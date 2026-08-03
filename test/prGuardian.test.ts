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

const sleepMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('node:timers/promises', () => ({ setTimeout: sleepMock }));

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
      stdout: command === 'gh'
        ? ghResponse(args, [], { comments: [{ id: 'human-comment', author: { login: 'reviewer' }, body: 'Please audit this.' }] })
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
    expect(runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('api graphql'))).toHaveLength(5);
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

  it.each([
    { stderr: "no required checks reported on the 'branch' branch", expectedStatus: 'success' },
    { stderr: "no checks reported on the 'branch' branch", expectedStatus: 'success' },
    { stderr: "authentication failed\nno checks reported on the 'branch' branch", expectedStatus: 'failed' }
  ])('handles the GitHub CLI checks response safely: $stderr', async ({ stderr, expectedStatus }) => {
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
      stderr: command === 'gh' && isRequiredChecks(args) ? stderr : '',
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

    expect(result.status).toBe(expectedStatus);
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
        if (isReviewCommentsApi(args) || isIssueCommentsApi(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: '[[]]', stderr: '', durationMs: 1 };
        }
        if (isRequiredChecks(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: requiredChecksResponse(), stderr: '', durationMs: 1 };
        }
        if (isCheckRunsApi(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: JSON.stringify([{ check_runs: [] }]), stderr: '', durationMs: 1 };
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
    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
    expect(runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('api graphql'))).toHaveLength(4);
  });

  it('does not miss a late bot review during the initial settle window', async () => {
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
        if (isReviewCommentsApi(args) || isIssueCommentsApi(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: '[[]]', stderr: '', durationMs: 1 };
        }
        if (isRequiredChecks(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: requiredChecksResponse(), stderr: '', durationMs: 1 };
        }
        if (isCheckRunsApi(args)) {
          return { command, args, cwd: options?.cwd, exitCode: 0, stdout: JSON.stringify([{ check_runs: [] }]), stderr: '', durationMs: 1 };
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
    expect(result.raw).toContain('before the first guardian pass');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(2);
  });

  it('runs Guardian when a pending PR becomes ready without complete audit evidence', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 2, reviewSettleSeconds: 0 }
    });
    let prViews = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && isPrView(args)) prViews += 1;
      const statusCheckRollup = [{
        name: 'test',
        status: prViews < 3 ? 'IN_PROGRESS' : 'COMPLETED',
        conclusion: prViews < 3 ? null : 'SUCCESS'
      }];
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: command === 'gh' ? ghResponse(args, [], { statusCheckRollup }) : 'guardian pass complete',
        stderr: '',
        durationMs: 1
      };
    });

    const pending = runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });
    const result = await pending;

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('still runs Guardian when only a generated CodeRabbit summary is present', async () => {
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
          comments: [{
            id: 'summary',
            author: { login: 'coderabbitai' },
            body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\nWalkthrough'
          }]
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
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('does not trust a CodeRabbit marker from a lookalike actor', async () => {
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
          comments: [{
            id: 'lookalike',
            author: { login: 'coderabbitai-fan' },
            body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->'
          }]
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
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('does not trust a Codex no-findings comment for an old head', async () => {
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
          headRefOid: 'new-head-sha',
          comments: [{
            id: 'old-codex-review',
            author: { login: 'chatgpt-codex-connector[bot]' },
            body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
          }]
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
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('reconciles a thrown guardian timeout when GitHub is stably ready', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    let reviewFetches = 0;
    let guardianAttempted = false;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'codex') {
        guardianAttempted = true;
        throw new Error('Command timed out after 60000ms');
      }
      if (command === 'gh' && args.join(' ').startsWith('api graphql')) reviewFetches += 1;
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: ghResponse(args, reviewFetches === 1
          ? [{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Pending review.' }]
          : [], guardianAttempted ? {
            headRefOid: 'abc123456789',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: new Date(Math.floor(Date.now() / 1_000) * 1_000 + 2_000).toISOString(),
              body: "Codex Review: Didn’t find any major issues. What shall we delve into next?\n\n**Reviewed commit:** `abc1234567`\n\n<details>standard footer</details>"
            }]
          } : undefined),
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
    expect(result.raw).toContain('Command timed out');
  });

  it('does not reconcile a timeout with audit evidence from the guardian attempt start second', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    let reviewFetches = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'codex') throw new Error('Command timed out after 60000ms');
      if (command === 'gh' && args.join(' ').startsWith('api graphql')) reviewFetches += 1;
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: ghResponse(args, reviewFetches === 1
          ? [{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Pending review.' }]
          : [], {
          headRefOid: 'abc123456789',
          comments: [{
            id: 'old-codex-review',
            author: { login: 'chatgpt-codex-connector[bot]' },
            updatedAt: new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString(),
            body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
          }]
        }),
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.raw).toContain('Command timed out');
  });

  it('preserves a real review blocker after a thrown guardian timeout', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'codex') throw new Error('Command timed out after 60000ms');
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: ghResponse(args, [{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Please fix this.' }]),
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
    expect(result.raw).toContain('unresolved review thread');
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
        ? ghResponse(args, [], { headRefOid: isPrView(args) && ++views % 2 === 0 ? 'new-head' : 'old-head' })
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

  it('runs Guardian when later PR activity shares the no-findings timestamp second', async () => {
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
          headRefOid: 'abc123456789',
          comments: [
            {
              id: 'codex-clean',
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn’t find any major issues. What shall we delve into next?\n\n**Reviewed commit:** `abc1234567`\n\n<details>standard footer</details>"
            },
            {
              id: 'later-human-comment',
              author: { login: 'reviewer' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: 'Please inspect the generated artifact.'
            }
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('uses the newest current-head no-findings evidence after intervening activity', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const noFindings = (updatedAt: string) => ({
      author: { login: 'chatgpt-codex-connector[bot]' },
      updatedAt,
      body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? ghResponse(args, [], {
          headRefOid: 'abc123456789',
          comments: [
            noFindings('2026-07-13T01:16:20Z'),
            {
              author: { login: 'reviewer' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: 'Please recheck this.'
            },
            noFindings('2026-07-13T01:16:22Z')
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(0);
  });

  it('does not trust a mixed Codex message containing findings as no-findings evidence', async () => {
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
          headRefOid: 'abc123456789',
          comments: [{
            author: { login: 'chatgpt-codex-connector[bot]' },
            updatedAt: '2026-07-13T01:16:21Z',
            body: "Codex Review: Didn't find any major issues. However, one finding remains.\n\n**Reviewed commit:** `abc1234567`"
          }]
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('does not miss a check annotation that arrives during stabilization', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    let checkRunFetches = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      let stdout: string;
      if (command === 'gh' && isCheckRunsApi(args)) {
        checkRunFetches += 1;
        stdout = JSON.stringify([{ check_runs: checkRunFetches === 1 ? [] : [{
          id: 99,
          name: 'lint',
          completed_at: '2026-07-13T01:16:22Z',
          output: { annotations_count: 1 }
        }] }]);
      } else if (command === 'gh' && isCheckAnnotationsApi(args)) {
        stdout = JSON.stringify([[{
          annotation_level: 'warning',
          path: 'src/file.ts',
          start_line: 12,
          message: 'Generated output is stale.'
        }]]);
      } else {
        stdout = command === 'gh'
          ? ghResponse(args, [], {
            headRefOid: 'abc123456789',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }]
          })
          : 'guardian pass complete';
      }
      return { command, args, cwd: options?.cwd, exitCode: 0, stdout, stderr: '', durationMs: 1 };
    });

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
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('runs Guardian for an auditable annotation without a check completion time', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      let stdout: string;
      if (command === 'gh' && isCheckRunsApi(args)) {
        stdout = JSON.stringify([{ check_runs: [{
          id: 99,
          name: 'optional-lint',
          completed_at: null,
          output: { annotations_count: 1 }
        }] }]);
      } else if (command === 'gh' && isCheckAnnotationsApi(args)) {
        stdout = JSON.stringify([[{
          annotation_level: 'warning',
          path: 'src/file.ts',
          start_line: 12,
          message: 'Review this warning.'
        }]]);
      } else {
        stdout = command === 'gh'
          ? ghResponse(args, [], {
            headRefOid: 'abc123456789',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }]
          })
          : 'guardian pass complete';
      }
      return { command, args, cwd: options?.cwd, exitCode: 0, stdout, stderr: '', durationMs: 1 };
    });

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
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('bounds concurrent check annotation requests', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    let activeAnnotationRequests = 0;
    let maxActiveAnnotationRequests = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      let stdout: string;
      if (command === 'gh' && isCheckRunsApi(args)) {
        stdout = JSON.stringify([{ check_runs: Array.from({ length: 5 }, (_, index) => ({
          id: index + 1,
          name: `check-${index + 1}`,
          completed_at: '2026-07-13T01:16:20Z',
          output: { annotations_count: 1 }
        })) }]);
      } else if (command === 'gh' && isCheckAnnotationsApi(args)) {
        activeAnnotationRequests += 1;
        maxActiveAnnotationRequests = Math.max(maxActiveAnnotationRequests, activeAnnotationRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeAnnotationRequests -= 1;
        stdout = JSON.stringify([[{ annotation_level: 'notice', message: 'Informational.' }]]);
      } else {
        stdout = command === 'gh'
          ? ghResponse(args, [], {
            headRefOid: 'abc123456789',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }]
          })
          : 'guardian pass complete';
      }
      return { command, args, cwd: options?.cwd, exitCode: 0, stdout, stderr: '', durationMs: 1 };
    });

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
    expect(maxActiveAnnotationRequests).toBe(4);
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(0);
  });

  it('accepts current-head Codex comment and CodeRabbit status evidence when REST reviews are stale', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const reviews = [[
      {
        id: 1,
        user: { login: 'chatgpt-codex-connector[bot]' },
        state: 'COMMENTED',
        submitted_at: '2026-07-13T01:16:19Z',
        commit_id: 'old-head'
      },
      {
        id: 2,
        user: { login: 'coderabbitai[bot]' },
        state: 'COMMENTED',
        submitted_at: '2026-07-13T01:16:20Z',
        commit_id: 'old-head'
      }
    ]];
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? isReviewApi(args)
          ? JSON.stringify(reviews)
          : ghResponse(args, [], {
            headRefOid: 'abc123456789',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn’t find any major issues. What shall we delve into next?\n\n**Reviewed commit:** `abc1234567`\n\n<details>standard footer</details>"
            }],
            statusCheckRollup: [
              {
                name: 'verify',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                completedAt: '2026-07-13T01:16:22Z'
              },
              { context: 'CodeRabbit', state: 'SUCCESS' }
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
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(0);
    expect(result.summary).not.toContain('not for current PR head');
  });

  it('runs Guardian when an optional check fails after no-findings evidence', async () => {
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
            headRefOid: 'abc123456789',
            mergeStateStatus: 'UNSTABLE',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }],
            statusCheckRollup: [{
              name: 'optional-analysis',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
              startedAt: '2026-07-13T01:16:21Z',
              completedAt: '2026-07-13T01:16:22Z'
            }]
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('does not finish Guardian while an optional check is still in progress', async () => {
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
            headRefOid: 'abc123456789',
            mergeStateStatus: 'UNSTABLE',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:22Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }],
            statusCheckRollup: [{
              name: 'optional-analysis',
              status: 'IN_PROGRESS',
              conclusion: null,
              startedAt: '2026-07-13T01:16:21Z'
            }]
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('auditable PR activity is still in progress');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('does not finish Guardian while an optional legacy status is pending', async () => {
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
            headRefOid: 'abc123456789',
            mergeStateStatus: 'UNSTABLE',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:22Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }],
            statusCheckRollup: [{
              __typename: 'StatusContext',
              context: 'optional-analysis',
              state: 'PENDING',
              startedAt: '2026-07-13T01:16:21Z'
            }]
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('auditable PR activity is still in progress');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('runs Guardian for a nested review comment newer than no-findings evidence', async () => {
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
        ? isReviewCommentsApi(args)
          ? JSON.stringify([[{
            id: 42,
            in_reply_to_id: 41,
            user: { login: 'reviewer' },
            created_at: '2026-07-13T01:16:22Z',
            updated_at: '2026-07-13T01:16:22Z',
            commit_id: 'abc123456789'
          }]])
          : ghResponse(args, [], {
            headRefOid: 'abc123456789',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }]
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('runs Guardian for a top-level comment on a later pagination page', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' && isIssueCommentsApi(args)
        ? JSON.stringify([[
          {
            id: 41,
            user: { login: 'chatgpt-codex-connector[bot]' },
            created_at: '2026-07-13T01:16:21Z',
            updated_at: '2026-07-13T01:16:21Z',
            body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
          }
        ], [
          {
            id: 42,
            user: { login: 'reviewer' },
            created_at: '2026-07-13T01:16:22Z',
            updated_at: '2026-07-13T01:16:22Z',
            body: 'Please audit this later comment.'
          }
        ]])
        : command === 'gh'
          ? ghResponse(args, [], { headRefOid: 'abc123456789' })
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('fails closed when review comment activity has no valid timestamp', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' && isReviewCommentsApi(args)
        ? JSON.stringify([[{ id: 42, user: { login: 'reviewer' } }]])
        : command === 'gh'
          ? ghResponse(args, [])
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('without an id or valid timestamp');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(0);
  });

  it('does not accept a current-head Codex findings comment as no-findings evidence', async () => {
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
          ? JSON.stringify([{
            id: 1,
            user: { login: 'chatgpt-codex-connector[bot]' },
            state: 'COMMENTED',
            submitted_at: '2026-07-13T01:16:19Z',
            commit_id: 'old-head'
          }])
          : ghResponse(args, [], {
            headRefOid: 'abc123456789',
            comments: [{
              author: { login: 'chatgpt-codex-connector[bot]' },
              body: 'Codex Review: Found an actionable issue.\n\n**Reviewed commit:** `abc1234567`'
            }]
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

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('not for current PR head');
  });

  it('does not trust old bot evidence while a newer undated review is pending', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' && isReviewApi(args)
        ? JSON.stringify([{
          id: 1,
          user: { login: 'chatgpt-codex-connector[bot]' },
          state: 'COMMENTED',
          submitted_at: '2026-07-13T01:16:21Z',
          commit_id: 'abc123456789'
        }, {
          id: 2,
          user: { login: 'chatgpt-codex-connector[bot]' },
          state: 'PENDING',
          commit_id: 'abc123456789'
        }])
        : command === 'gh'
          ? ghResponse(args, [], {
            headRefOid: 'abc123456789',
            comments: [{
              id: 1,
              author: { login: 'chatgpt-codex-connector[bot]' },
              updatedAt: '2026-07-13T01:16:21Z',
              body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
            }]
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('auditable PR activity is still in progress');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(1);
  });

  it('enforces a 30-second minimum between audited early-success snapshots', async () => {
    sleepMock.mockClear();
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
          headRefOid: 'abc123456789',
          comments: [{
            id: 1,
            author: { login: 'chatgpt-codex-connector[bot]' },
            updatedAt: '2026-07-13T01:16:21Z',
            body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234567`"
          }]
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
      branch: 'branch',
      baseBranch: 'main'
    });

    expect(result.status).toBe('success');
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 30_000);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 30_000);
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(0);
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

  it('reactivates a successful same-head job when a resolved thread receives a late reply', async () => {
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
    let lateReply = false;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'codex') lateReply = false;
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: command === 'gh' && isReviewCommentsApi(args)
          ? lateReply
            ? JSON.stringify([[{
              id: 42,
              in_reply_to_id: 41,
              user: { login: 'reviewer' },
              created_at: '2026-07-13T01:16:22Z',
              updated_at: '2026-07-13T01:16:22Z',
              commit_id: 'head-sha'
            }]])
            : '[[]]'
          : command === 'gh'
            ? ghResponse(args, [])
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

    lateReply = true;
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

  it('continues pending jobs when an old successful pull request is inaccessible', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-state-'));
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, mode: 'async', command: 'codex', timeoutMinutes: 1, maxAttempts: 1, reviewSettleSeconds: 0 }
    });
    const oldJob = await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'old-branch',
      baseBranch: 'main',
      headSha: 'old-head'
    });
    await fs.writeFile(
      path.join(stateDir, 'guardian', 'jobs', `${oldJob.id}.json`),
      `${JSON.stringify({ ...oldJob, status: 'success' }, null, 2)}\n`
    );
    await enqueuePrGuardianJob({
      stateDir,
      config,
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/5',
      prNumber: 5,
      branch: 'new-branch',
      baseBranch: 'main',
      headSha: 'new-head'
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      const inaccessible = command === 'gh' && isPrView(args) && args[2] === '4';
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: inaccessible ? 1 : 0,
        stdout: inaccessible ? '' : command === 'gh' ? ghResponse(args, []) : 'done',
        stderr: inaccessible ? 'not found' : '',
        durationMs: 1
      };
    });

    const jobs = await runPendingPrGuardianJobs({
      stateDir,
      config,
      workspaceDir: '/tmp/workspace',
      runCommand: runner,
      isolateWorktree: false
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ prNumber: 5, status: 'success' });
    await expect(listPrGuardianJobs(stateDir)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ prNumber: 4, status: 'success' }),
      expect.objectContaining({ prNumber: 5, status: 'success' })
    ]));
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
    expect(runner.mock.calls.some(([command]) => command === 'codex')).toBe(false);
    expect(storedJobs[0].status).toBe('blocked');
    expect(storedJobs[0].attemptCount).toBe(2);
    expect(storedJobs[0].lastBlocker).toBe('PR guardian retry budget exhausted after 2 attempts.');
  });

  it('reconciles an exhausted guardian job when the pull request was merged', async () => {
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
      prUrl: 'https://github.com/o/r/pull/4',
      lastFailure: 'Guardian retry budget exhausted.'
    });
    const job = await enqueuePrGuardianJob({
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
    await fs.writeFile(
      path.join(stateDir, 'guardian', 'jobs', `${job.id}.json`),
      `${JSON.stringify({
        ...job,
        status: 'blocked',
        attemptCount: 2,
        lastBlocker: 'Guardian retry budget exhausted.'
      }, null, 2)}\n`
    );
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, [], {
        state: 'MERGED',
        baseRefName: 'main',
        closingIssuesReferences: [{ number: 1 }]
      }) : 'done',
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
    expect(jobs[0]).toMatchObject({ status: 'success', attemptCount: 2, lastBlocker: undefined });
    expect(runner.mock.calls.some(([command]) => command === 'codex')).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    const implementationState = await loadImplementationState(stateDir, 1);
    expect(implementationState).toMatchObject({
      phase: 'complete',
      attempt: 2,
      pr: 4
    });
    expect(implementationState?.lastFailure).toBeUndefined();
  });

  it.each([
    ['the pull request was retargeted', { state: 'MERGED', baseRefName: 'release', closingIssuesReferences: [{ number: 1 }] }, 1],
    ['the pull request no longer closes the issue', { state: 'MERGED', baseRefName: 'main', closingIssuesReferences: [] }, 1],
    ['the job has no tracked issue', { state: 'MERGED', baseRefName: 'main', closingIssuesReferences: [{ number: 1 }] }, undefined]
  ])('does not reconcile an exhausted guardian job when %s', async (_description, resolution, issueNumber) => {
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
      issueNumber,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main',
      headSha: 'abc123456789'
    });
    await fs.writeFile(
      path.join(stateDir, 'guardian', 'jobs', `${job.id}.json`),
      `${JSON.stringify({ ...job, status: 'blocked', attemptCount: 2 }, null, 2)}\n`
    );
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? ghResponse(args, [], resolution) : 'done',
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
    expect((await listPrGuardianJobs(stateDir))[0]).toMatchObject({ status: 'blocked', attemptCount: 2 });
    expect(runner.mock.calls.some(([command]) => command === 'codex')).toBe(false);
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
    baseRefName: string;
    closingIssuesReferences: Array<{ number: number }>;
    comments: Array<Record<string, unknown>>;
  }> = {}
): string {
  if (isPrView(args)) return mergeablePrResponse(pr);
  if (isReviewApi(args)) return JSON.stringify([]);
  if (isReviewCommentsApi(args)) return JSON.stringify([[]]);
  if (isIssueCommentsApi(args)) return JSON.stringify([(
    pr.comments ?? []
  ).map((comment, index) => ({
    id: comment.id ?? index + 1,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    body: comment.body,
    user: comment.author
  }))]);
  if (isCheckRunsApi(args)) return JSON.stringify([{ check_runs: [] }]);
  if (isCheckAnnotationsApi(args)) return JSON.stringify([[]]);
  if (isRequiredChecks(args)) return requiredChecksResponse(pr.statusCheckRollup);
  return reviewThreadsResponse(threads);
}

function isPrView(args: string[]): boolean {
  return args[0] === 'pr' && args[1] === 'view';
}

function isReviewApi(args: string[]): boolean {
  return args[0] === 'api' && args.some((arg) => /\/pulls\/\d+\/reviews/.test(arg));
}

function isReviewCommentsApi(args: string[]): boolean {
  return args[0] === 'api' && args.some((arg) => /\/pulls\/\d+\/comments/.test(arg));
}

function isIssueCommentsApi(args: string[]): boolean {
  return args[0] === 'api' && args.some((arg) => /\/issues\/\d+\/comments/.test(arg));
}

function isCheckRunsApi(args: string[]): boolean {
  return args[0] === 'api' && args.some((arg) => /\/commits\/[^/]+\/check-runs/.test(arg));
}

function isCheckAnnotationsApi(args: string[]): boolean {
  return args[0] === 'api' && args.some((arg) => /\/check-runs\/\d+\/annotations/.test(arg));
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
  baseRefName: string;
  closingIssuesReferences: Array<{ number: number }>;
  comments: Array<Record<string, unknown>>;
}> = {}): string {
  return JSON.stringify({
    state: pr.state ?? 'OPEN',
    isDraft: pr.isDraft ?? false,
    mergeStateStatus: pr.mergeStateStatus ?? 'CLEAN',
    mergeable: pr.mergeable ?? 'MERGEABLE',
    reviewDecision: pr.reviewDecision ?? '',
    headRefOid: pr.headRefOid ?? 'head-sha',
    baseRefName: pr.baseRefName ?? 'main',
    closingIssuesReferences: pr.closingIssuesReferences ?? [],
    reviews: pr.reviews ?? [],
    comments: pr.comments ?? [],
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
