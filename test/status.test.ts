import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { statusProject } from '../src/commands/status.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('statusProject', () => {
  it('reports pushed remote branches with no open pull request', async () => {
    const { repo, workspace, home } = await setupProject();
    await writeGuardianJob(home, 4, 'pending');
    await writeGuardianJob(home, 98, 'success');
    await writeGuardianJob(home, 99, 'pending');
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, '[]');
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(
          command,
          args,
          repo,
          JSON.stringify([
            {
              number: 4,
              headRefName: 'kaizen/has-pr',
              headRepositoryOwner: { login: 'O' },
              url: 'https://github.com/o/r/pull/4'
            },
            {
              number: 5,
              headRefName: 'feature/fork-pr',
              headRepositoryOwner: { login: 'contributor' },
              url: 'https://github.com/o/r/pull/5'
            }
          ])
        );
      }
      if (command === 'git' && args.join(' ') === 'fetch --prune origin') {
        return result(command, args, workspace, '');
      }
      if (command === 'git' && args.join(' ') === 'for-each-ref --format=%(refname:short)%09%(objectname:short) refs/remotes/origin') {
        return result(
          command,
          args,
          workspace,
          [
            'origin/HEAD\t1111111',
            'origin/main\t2222222',
            'origin/codex/hidden-work\t3333333',
            'origin/kaizen/has-pr\t4444444',
            'origin/feature/no-diff\t5555555',
            'origin/feature/fork-pr\t6666666'
          ].join('\n')
        );
      }
      if (command === 'git' && args.join(' ') === 'rev-list --left-right --count origin/main...origin/codex/hidden-work') {
        return result(command, args, workspace, '23\t2\n');
      }
      if (command === 'git' && args.join(' ') === 'rev-list --left-right --count origin/main...origin/feature/no-diff') {
        return result(command, args, workspace, '0\t0\n');
      }
      if (command === 'git' && args.join(' ') === 'rev-list --left-right --count origin/main...origin/feature/fork-pr') {
        return result(command, args, workspace, '1\t3\n');
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const output = await statusProject({
      cwd: repo,
      project: 'o-r',
      runCommand: runner
    });

    expect(output.pullRequests.open).toBe(2);
    expect(output.guardian.stale).toBe(1);
    expect(output.branchHygiene).toEqual({
      checked: true,
      unreviewedRemoteBranches: [
        {
          branch: 'codex/hidden-work',
          remoteRef: 'origin/codex/hidden-work',
          headSha: '3333333',
          ahead: 2,
          behind: 23
        },
        {
          branch: 'feature/fork-pr',
          remoteRef: 'origin/feature/fork-pr',
          headSha: '6666666',
          ahead: 3,
          behind: 1
        }
      ]
    });
  });

  it('keeps status available when branch hygiene cannot be checked', async () => {
    const { repo, workspace } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'git' && args.join(' ') === 'fetch --prune origin') {
        throw new Error('workspace is not a git checkout');
      }
      return result(command, args, workspace, '');
    });

    const output = await statusProject({
      cwd: repo,
      project: 'o-r',
      runCommand: runner
    });

    expect(output.branchHygiene.checked).toBe(false);
    expect(output.branchHygiene.unreviewedRemoteBranches).toEqual([]);
    expect(output.branchHygiene.error).toContain('workspace is not a git checkout');
  });

  it('keeps metrics when some run directories have no summary and reports review-window counters', async () => {
    const { repo, workspace, home } = await setupProject();
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await writeSummary(home, '2026-07-01T00-00-00Z', {
      version: 1,
      project: 'o-r',
      startedAt: recent,
      finishedAt: recent,
      trigger: 'scheduled',
      result: 'partial',
      issues: [
        {
          number: 1,
          title: 'passes',
          outcome: 'pr-created',
          guardian: { status: 'success', summary: 'ok' },
          reason: 'Verifier cleared PR: ok'
        },
        {
          number: 2,
          title: 'blocked',
          outcome: 'failed',
          reason: 'Verifier blocked PR: missing coverage'
        },
        {
          number: 3,
          title: 'verify failed',
          outcome: 'failed',
          reason: 'Verification failed: pnpm test'
        }
      ],
      skipped: [{ number: 4, reason: 'maxIssuesPerNight reached' }]
    });
    await writeSummary(home, '2026-06-20T00-00-00Z', {
      version: 1,
      project: 'o-r',
      startedAt: old,
      finishedAt: old,
      trigger: 'scheduled',
      result: 'failed',
      issues: [
        {
          number: 5,
          title: 'needs context',
          outcome: 'blocked',
          reason: 'Verifier needs context: unclear task'
        }
      ],
      skipped: []
    });
    await fs.mkdir(path.join(home, 'projects', 'o-r', 'runs', '2026-07-02T00-00-00Z'), { recursive: true });

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'search' && args[1] === 'prs') {
        return result(
          command,
          args,
          repo,
          JSON.stringify([
            {
              number: 7,
              author: { login: 'github-actions[bot]', type: 'Bot' },
              repository: { nameWithOwner: 'o/r' },
              url: 'https://github.com/o/r/pull/7'
            },
            {
              number: 8,
              author: { login: 'dependabot[bot]' },
              repository: { nameWithOwner: 'o/other' },
              url: 'https://github.com/o/other/pull/8'
            },
            {
              number: 9,
              author: { login: 'human', type: 'User' },
              repository: { nameWithOwner: 'o/r' },
              url: 'https://github.com/o/r/pull/9'
            }
          ])
        );
      }
      if (command === 'git' && args.join(' ') === 'fetch --prune origin') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'for-each-ref --format=%(refname:short)%09%(objectname:short) refs/remotes/origin') {
        return result(command, args, workspace, 'origin/HEAD\t1111111\norigin/main\t2222222\n');
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const output = await statusProject({
      cwd: repo,
      project: 'o-r',
      metrics: true,
      runCommand: runner
    });

    expect(output.metrics).toMatchObject({
      runs: 2,
      readableRuns: 2,
      unreadableRuns: 1,
      processed: 4,
      prCreated: 1,
      failed: 2,
      blocked: 1,
      skipped: 1,
      verificationFailed: 1,
      verifierBlocked: 1,
      verifierNeedsContext: 1,
      guardian: {
        eligible: 1,
        success: 1
      },
      reviewWindow: {
        runs: 1,
        processed: 3,
        prCreated: 1,
        failed: 2,
        blocked: 0,
        skipped: 1,
        verificationFailed: 1,
        verifierBlocked: 1,
        verifierNeedsContext: 0
      },
      wipLimit: {
        repository: 1,
        organization: 2,
        limit: 5,
        exceeded: false
      }
    });
  });
});

async function setupProject() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: [] }));
  await saveRegistry({
    version: 1,
    projects: {
      'o-r': {
        repo: 'o/r',
        localPath: repo,
        workspacePath: workspace,
        schedule: '02:00',
        enabled: false,
        createdAt: '2026-06-12T00:00:00Z'
      }
    }
  });
  return { repo, workspace, home };
}

async function writeSummary(home: string, run: string, summary: unknown) {
  const runDir = path.join(home, 'projects', 'o-r', 'runs', run);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

async function writeGuardianJob(home: string, prNumber: number, status: string) {
  const jobsDir = path.join(home, 'projects', 'o-r', 'guardian', 'jobs');
  await fs.mkdir(jobsDir, { recursive: true });
  const id = `o-r-pr-${prNumber}-abc123456789`;
  await fs.writeFile(
    path.join(jobsDir, `${id}.json`),
    `${JSON.stringify({
      version: 1,
      id,
      repo: 'o/r',
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      prNumber,
      branch: `kaizen/issue-${prNumber}`,
      baseBranch: 'main',
      headSha: 'abc123456789',
      retryBudget: 2,
      attemptCount: 0,
      status,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z'
    }, null, 2)}\n`
  );
}

function result(command: string, args: string[], cwd: string | undefined, stdout: string) {
  return {
    command,
    args,
    cwd,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1
  };
}
