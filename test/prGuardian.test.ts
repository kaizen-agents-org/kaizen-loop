import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config/schema.js';
import {
  enqueueManagedPrGuardianJobs,
  enqueuePrGuardianJob,
  listPrGuardianJobs,
  MANAGED_PR_GUARDIAN_MARKER,
  runPendingPrGuardianJobs,
  runPrGuardianSkill
} from '../src/orchestrator/prGuardian.js';
import { loadImplementationState, saveImplementationState } from '../src/orchestrator/implementationState.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('runPrGuardianSkill', () => {
  it('requires review feedback to be inspected before declaring a PR mergeable', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 3, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, []) : 'done',
      stderr: '',
      durationMs: 1
    }));

    await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    const prompt = String(runner.mock.calls.find(([command]) => command === 'codex')?.[1].at(-1));

    expect(prompt).toContain('Always inspect PR review feedback before declaring the PR ready to merge');
    expect(prompt).toContain('Do not require reviewDecision=APPROVED or human approval');
    expect(prompt).toContain('PullRequest.reviewThreads');
    expect(prompt).toContain('hasNextPage=false');
    expect(prompt).toContain('Reply in the same review thread or comment');
    expect(prompt).toContain('links to the original comment or review');
    expect(prompt).toContain('no unresolved review threads or actionable PR comments remain');
    expect(prompt).toContain('outdated unresolved threads still block merging');
    expect(prompt).toContain('missing approval or reviewDecision other than APPROVED is not a blocker');
    expect(prompt).toContain('required checks are passing');
    expect(prompt).toContain('unresolved/skipped feedback with reasons');
    expect(prompt).toContain('If GitHub reports state=MERGED');
    expect(prompt).toContain('stop all watches immediately and exit successfully');
  });

  it('reruns while unresolved review threads remain and fails after the retry budget', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? ghResponse(args, [{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Please fix this.' }])
        : 'guardian pass complete',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('unresolved review thread');
    expect(result.raw).toContain('src/file.ts:12 by reviewer');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(2);
    expect(runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('api graphql'))).toHaveLength(4);
  });

  it('treats outdated unresolved review threads as blockers', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? ghResponse(args, [{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Please resolve this.', isOutdated: true }])
        : 'guardian pass complete',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('unresolved review thread');
    expect(result.raw).toContain('src/file.ts:12 by reviewer');
  });

  it('does not declare success while the PR is behind the protected base branch', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, [], { mergeStateStatus: 'BEHIND' }) : 'guardian pass complete',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('mergeStateStatus is BEHIND');
  });

  it('treats skipped and neutral check conclusions as passing', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? ghResponse(args, [], {
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'conditional', status: 'COMPLETED', conclusion: 'SKIPPED' },
            { __typename: 'CheckRun', name: 'advisory', status: 'COMPLETED', conclusion: 'NEUTRAL' },
            { __typename: 'StatusContext', context: 'CodeRabbit', state: 'SUCCESS' }
          ]
        })
        : 'guardian pass complete',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
  });

  it('accepts UNSTABLE when required checks pass and only an optional check fails', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? isRequiredChecks(args)
          ? requiredChecksResponse()
          : ghResponse(args, [], {
            mergeStateStatus: 'UNSTABLE',
            statusCheckRollup: [
              { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
              { name: 'optional', status: 'COMPLETED', conclusion: 'FAILURE' }
            ]
          })
        : 'done',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
  });

  it('treats the GitHub CLI no-required-checks response as an empty check set', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: command === 'gh' && isRequiredChecks(args) ? 1 : 0,
      stdout: command === 'gh' && isRequiredChecks(args) ? '' : command === 'gh' ? ghResponse(args, []) : 'done',
      stderr: command === 'gh' && isRequiredChecks(args)
        ? "no required checks reported on the 'branch' branch"
        : '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
  });

  it('stabilizes a ready retry preflight before returning without another guardian pass', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 3, reviewSettleSeconds: 0 }
    });
    let reviewFetches = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh') {
        if (isPrView(args)) {
          return {
            command,
            args,
            cwd: options?.cwd,
            exitCode: 0,
            stdout: mergeablePrResponse(),
            stderr: '',
            durationMs: 1
          };
        }
        if (isReviewApi(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: '[]', stderr: '', durationMs: 1 };
        }
        if (isRequiredChecks(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: requiredChecksResponse(), stderr: '', durationMs: 1 };
        }
        reviewFetches += 1;
        return {
          command,
          args,
          cwd: options?.cwd,
          exitCode: 0,
          stdout: reviewFetches === 1
            ? reviewThreadsResponse([{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Please resolve this.', isOutdated: true }])
            : reviewThreadsResponse([]),
          stderr: '',
          durationMs: 1
        };
      }
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: 'guardian pass complete',
        stderr: '',
        durationMs: 1
      };
    });

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
    expect(runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('api graphql'))).toHaveLength(4);
  });

  it('waits once for late bot review threads before declaring success', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 1 }
    });
    let reviewFetches = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh') {
        if (isPrView(args)) {
          return {
            command,
            args,
            cwd: options?.cwd,
            exitCode: 0,
            stdout: mergeablePrResponse(),
            stderr: '',
            durationMs: 1
          };
        }
        if (isReviewApi(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: '[]', stderr: '', durationMs: 1 };
        }
        if (isRequiredChecks(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: requiredChecksResponse(), stderr: '', durationMs: 1 };
        }
        reviewFetches += 1;
        return {
          command,
          args,
          cwd: options?.cwd,
          exitCode: 0,
          stdout: reviewFetches === 1
            ? reviewThreadsResponse([])
            : reviewThreadsResponse([{ path: 'src/file.ts', line: 12, author: 'codex', body: 'Please fix this.' }]),
          stderr: '',
          durationMs: 1
        };
      }
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: 'guardian pass complete',
        stderr: '',
        durationMs: 1
      };
    });

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.raw).toContain('bot review settle wait');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(2);
  });

  it('requires two unchanged stabilization snapshots', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    let views = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? ghResponse(args, [], { headRefOid: isPrView(args) && ++views === 4 ? 'new-head' : 'old-head' })
        : 'done',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.raw).toMatch(/PR (head|activity) changed during stabilization/);
  });

  it('treats a merged PR as a successful terminal state', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? ghResponse(args, [{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Already obsolete.' }], {
          state: 'MERGED',
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNKNOWN'
        })
        : 'done',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(result.summary).toContain('PR is merged');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(0);
  });

  it('uses paginated REST review commit ids before accepting automated review evidence', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? isReviewApi(args)
          ? JSON.stringify([[{
            id: 1,
            user: { login: 'chatgpt-codex-connector[bot]' },
            state: 'COMMENTED',
            submitted_at: '2026-07-13T01:16:19Z',
            commit_id: 'old-head'
          }]])
          : ghResponse(args, [], { headRefOid: 'new-head' })
        : 'done',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('not for current PR head');
    expect(runner.mock.calls.some(([command, args]) => command === 'gh' && isReviewApi(args))).toBe(true);
    expect(runner.mock.calls.find(([command, args]) => command === 'gh' && isReviewApi(args))?.[1]).toContain('--paginate');
  });

  it('reactivates a successful same-head job when a late review thread appears', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'head-sha'
    });
    let lateThread = false;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'codex') lateThread = false;
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: command === 'gh'
          ? isReviewApi(args)
            ? JSON.stringify([])
            : ghResponse(
              args,
              lateThread ? [{ path: 'src/file.ts', line: 12, author: 'codex', body: 'Late finding.' }] : [],
              { mergeStateStatus: lateThread ? 'BLOCKED' : 'CLEAN' }
            )
          : 'done',
        stderr: '',
        durationMs: 1
      };
    });

    const first = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner,
      isolateWorktree: false
    });
    expect(first[0].status).toBe('success');

    lateThread = true;
    const second = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner,
      isolateWorktree: false
    });

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ status: 'success', reactivationCount: 1 });
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(2);
  });

  it('reactivates a successful job after a guardian fix advances the head', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'old-head'
    });
    let headRefOid = 'old-head';
    let lateThread = false;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'codex') lateThread = false;
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: command === 'gh'
          ? isReviewApi(args)
            ? JSON.stringify([])
            : ghResponse(
              args,
              lateThread ? [{ path: 'src/file.ts', line: 12, author: 'codex', body: 'Late finding.' }] : [],
              { headRefOid, mergeStateStatus: lateThread ? 'BLOCKED' : 'CLEAN' }
            )
          : 'done',
        stderr: '',
        durationMs: 1
      };
    });

    const first = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner,
      isolateWorktree: false
    });
    expect(first[0]).toMatchObject({ status: 'success', headSha: 'old-head' });

    headRefOid = 'new-head';
    lateThread = true;
    const second = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner,
      isolateWorktree: false
    });

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ status: 'success', headSha: 'new-head', reactivationCount: 1 });
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(2);
  });

  it('enqueues only marked same-repository generated sync pull requests', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({ version: 1, guardian: { enabled: true, mode: 'async' } });
    const pullRequests = [
      managedPullRequest(),
      managedPullRequest({ number: 5, body: 'missing marker' }),
      managedPullRequest({ number: 6, headRefName: 'feature/human-authored' }),
      managedPullRequest({ number: 7, headRepositoryOwner: { login: 'fork-owner' } }),
      managedPullRequest({ number: 8, baseRefName: 'release' }),
      managedPullRequest({ number: 9, isDraft: true })
    ];

    const jobs = await enqueueManagedPrGuardianJobs({
      stateDir,
      config,
      repo: 'o/r',
      pullRequests
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ prNumber: 4, branch: 'codex/daily-dogfood-sync', headSha: 'head-sha' });
  });

  it('enqueues a managed pull request beyond the first 100 discovered results', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({ version: 1, guardian: { enabled: true, mode: 'async' } });
    const pullRequests = [
      ...Array.from({ length: 100 }, (_, index) => managedPullRequest({
        number: index + 1,
        body: 'not managed',
        headRefName: `feature/${index + 1}`
      })),
      managedPullRequest({ number: 101, headRefOid: 'managed-head' })
    ];

    const jobs = await enqueueManagedPrGuardianJobs({
      stateDir,
      config,
      repo: 'o/r',
      pullRequests
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ prNumber: 101, headSha: 'managed-head' });
  });

  it('persists one guardian job per PR head SHA', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });

    const first = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    const duplicate = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    const changedHead = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'def123456789'
    });

    expect(duplicate.id).toBe(first.id);
    expect(changedHead.id).not.toBe(first.id);
    expect(await listPrGuardianJobs(stateDir)).toHaveLength(2);
  });

  it('skips corrupt guardian job files when listing jobs', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    const job = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    await fs.writeFile(path.join(stateDir, 'guardian', 'jobs', 'corrupt.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const jobs = await listPrGuardianJobs(stateDir);

      expect(jobs.map((item) => item.id)).toEqual([job.id]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping unreadable PR Guardian job file'));
    } finally {
      warn.mockRestore();
    }
  });

  it('runs pending guardian jobs and records the final state', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    await saveImplementationState(stateDir, {
      issue: 1,
      branch: 'kaizen/issue-1-fix',
      phase: 'guardian',
      attempt: 2,
      pr: 4,
      prUrl: 'https://github.com/o/r/pull/4'
    });
    await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      issueNumber: 1,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, []) : 'done',
      stderr: '',
      durationMs: 1
    }));

    const jobs = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('success');
    expect(jobs[0].attemptCount).toBe(1);
    expect((await listPrGuardianJobs(stateDir))[0].status).toBe('success');
    await expect(loadImplementationState(stateDir, 1)).resolves.toMatchObject({
      phase: 'complete',
      attempt: 2,
      pr: 4
    });
  });

  it('resumes stale running guardian jobs', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    const job = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    await fs.writeFile(
      path.join(stateDir, 'guardian', 'jobs', `${job.id}.json`),
      `${JSON.stringify({
        ...job,
        status: 'running',
        attemptCount: 1,
        updatedAt: '2026-06-12T00:00:00Z',
        lastCheckedAt: '2026-06-12T00:00:00Z'
      }, null, 2)}\n`
    );
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, []) : 'done',
      stderr: '',
      durationMs: 1
    }));

    const jobs = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('success');
    expect(jobs[0].attemptCount).toBe(2);
  });

  it('blocks stale running guardian jobs that exhausted their retry budget', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    const job = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    await fs.writeFile(
      path.join(stateDir, 'guardian', 'jobs', `${job.id}.json`),
      `${JSON.stringify({
        ...job,
        status: 'running',
        attemptCount: 2,
        updatedAt: '2026-06-12T00:00:00Z',
        lastCheckedAt: '2026-06-12T00:00:00Z'
      }, null, 2)}\n`
    );
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, []) : 'done',
      stderr: '',
      durationMs: 1
    }));

    const jobs = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner
    });
    const storedJobs = await listPrGuardianJobs(stateDir);

    expect(jobs).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    expect(storedJobs[0].status).toBe('blocked');
    expect(storedJobs[0].attemptCount).toBe(2);
    expect(storedJobs[0].lastBlocker).toBe('PR guardian retry budget exhausted after 2 attempts.');
  });

  it('leaves active running guardian jobs alone', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 60, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    const job = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    await fs.writeFile(
      path.join(stateDir, 'guardian', 'jobs', `${job.id}.json`),
      `${JSON.stringify({
        ...job,
        status: 'running',
        attemptCount: 1,
        updatedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString()
      }, null, 2)}\n`
    );
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, []) : 'done',
      stderr: '',
      durationMs: 1
    }));

    const jobs = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner
    });

    expect(jobs).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });
});

function ghResponse(
  args: string[],
  threads: Array<{ path: string; line: number; author: string; body: string; isOutdated?: boolean }>,
  pr: Partial<{
    state: string;
    isDraft: boolean;
    mergeStateStatus: string;
    mergeable: string;
    reviewDecision: string;
    statusCheckRollup: Array<Record<string, unknown>>;
    headRefOid: string;
    reviews: Array<Record<string, unknown>>;
  }> = {}
): string {
  if (isPrView(args)) return mergeablePrResponse(pr);
  if (isReviewApi(args)) return JSON.stringify([]);
  if (isRequiredChecks(args)) return requiredChecksResponse(pr.statusCheckRollup);
  return reviewThreadsResponse(threads);
}

function isPrView(args: string[]): boolean {
  return args[0] === 'pr' && args[1] === 'view';
}

function isReviewApi(args: string[]): boolean {
  return args[0] === 'api' && args.some((arg) => arg.includes('/pulls/4/reviews'));
}

function isRequiredChecks(args: string[]): boolean {
  return args[0] === 'pr' && args[1] === 'checks' && args.includes('--required');
}

function requiredChecksResponse(checks?: Array<Record<string, unknown>>): string {
  const source = checks ?? [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  return JSON.stringify(source.map((check) => ({
    name: String(check.name ?? check.context ?? 'test'),
    state: String(check.conclusion ?? check.state ?? 'SUCCESS'),
    bucket: ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(String(check.conclusion ?? check.state ?? 'SUCCESS')) ? 'pass' : 'fail',
    workflow: ''
  })));
}

function managedPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 4,
    url: 'https://github.com/o/r/pull/4',
    isDraft: false,
    headRefName: 'codex/daily-dogfood-sync',
    headRefOid: 'head-sha',
    headRepositoryOwner: { login: 'o' },
    baseRefName: 'main',
    body: `Sync contracts.\n\n${MANAGED_PR_GUARDIAN_MARKER}`,
    ...overrides
  };
}

function mergeablePrResponse(pr: Partial<{
  state: string;
  isDraft: boolean;
  mergeStateStatus: string;
  mergeable: string;
  reviewDecision: string;
  statusCheckRollup: Array<Record<string, unknown>>;
  headRefOid: string;
  reviews: Array<Record<string, unknown>>;
}> = {}): string {
  return JSON.stringify({
    state: pr.state ?? 'OPEN',
    isDraft: pr.isDraft ?? false,
    mergeStateStatus: pr.mergeStateStatus ?? 'CLEAN',
    mergeable: pr.mergeable ?? 'MERGEABLE',
    reviewDecision: pr.reviewDecision ?? '',
    headRefOid: pr.headRefOid ?? 'head-sha',
    reviews: pr.reviews ?? [],
    comments: [],
    statusCheckRollup: pr.statusCheckRollup ?? [
      {
        __typename: 'CheckRun',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS'
      },
      {
        __typename: 'StatusContext',
        context: 'CodeRabbit',
        state: 'SUCCESS'
      }
    ]
  });
}

function reviewThreadsResponse(threads: Array<{ path: string; line: number; author: string; body: string; isOutdated?: boolean }>): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage: false,
              endCursor: null
            },
            nodes: threads.map((thread) => ({
              isResolved: false,
              isOutdated: thread.isOutdated ?? false,
              path: thread.path,
              line: thread.line,
              comments: {
                nodes: [
                  {
                    body: thread.body,
                    author: {
                      login: thread.author
                    }
                  }
                ]
              }
            }))
          }
        }
      }
    }
  });
}
