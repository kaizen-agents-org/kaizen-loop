import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { defaultConfigYaml as buildDefaultConfigYaml } from '../../src/config/config.js';
import { saveRegistry } from '../../src/config/registry.js';
import type { GitHubIssue } from '../../src/github/types.js';
import { runKaizen } from '../../src/orchestrator/run.js';
import type { CommandRunner } from '../../src/utils/command.js';

describe('runKaizen dry-run', () => {
  it('reports configured disabled scheduler jobs separately from unknown jobs', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      stringify({
        version: 1,
        scheduler: {
          jobs: {
            disabled: {
              enabled: false,
              schedule: { type: 'daily', time: '02:00' },
              run: { mode: 'maintenance', lateStartGuard: false }
            }
          }
        }
      })
    );
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
    const runner = vi.fn<CommandRunner>();

    await expect(runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      job: 'disabled',
      dryRun: true,
      json: true,
      runCommand: runner
    })).rejects.toThrow('Scheduler job is disabled: disabled');
    expect(runner).not.toHaveBeenCalled();
  });

  it('selects issues without acquiring a lock or mutating GitHub', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      expect(command).toBe('gh');
      expect(args).toContain('issue');
      return {
        command,
        args,
        cwd: repo,
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'Fix bug',
            body: '',
            labels: [{ name: 'kaizen' }],
            createdAt: '2026-06-12T00:00:00Z',
            comments: []
          }
        ]),
        stderr: '',
        durationMs: 1
      };
    });

    const result = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in result && result.selected[0].number).toBe(1);
    await expect(fs.access(path.join(home, 'projects', 'o-r', 'run.lock'))).rejects.toThrow();
  });

  it('keeps scheduled latestStartHour skips side-effect-free during dry-run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'));
    try {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
      vi.stubEnv('KAIZEN_HOME', home);
      await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
      await fs.writeFile(
        path.join(repo, '.kaizen', 'config.yml'),
        defaultConfigWith({ run: { latestStartHour: 0 } }, { agent: 'claude', setup: null, verify: [] })
      );
      await saveRegistry({
        version: 1,
        projects: {
          'o-r': {
            repo: 'o/r',
            localPath: repo,
            workspacePath: workspace,
            schedule: '02:00',
            enabled: true,
            createdAt: '2026-06-12T00:00:00Z'
          }
        }
      });

      const runner = vi.fn<CommandRunner>(async (command, args) => {
        if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          return result(command, args, repo, JSON.stringify([issue()]));
        }
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return result(command, args, repo, '[]');
        }
        return result(command, args, repo, '');
      });

      const resultValue = await runKaizen({
        cwd: repo,
        project: 'o-r',
        scheduled: true,
        trigger: 'scheduled',
        dryRun: true,
        json: true,
        runCommand: runner
      });

      expect('selected' in resultValue && resultValue.selected[0].number).toBe(1);
      await expect(fs.access(path.join(home, 'projects', 'o-r', 'runs'))).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-select issues when the repository already has too many open PRs', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ run: { maxOpenPullRequests: 1 } }, { agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1)]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([{ number: 3, headRefName: 'kaizen/issue-9-x', url: 'https://github.com/o/r/pull/3' }]));
      }
      return result(command, args, repo, '');
    });

    const resultSummary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      trigger: 'afternoon',
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in resultSummary && resultSummary.selected).toEqual([]);
    expect('selected' in resultSummary && resultSummary.skipped).toEqual([
      { number: 1, reason: 'open pull request limit reached (1/1)' }
    ]);
  });

  it('does not count fixed-branch sync PRs toward the automatic open PR limit', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ run: { maxOpenPullRequests: 1 } }, { agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1)]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(
          command,
          args,
          repo,
          JSON.stringify([
            { number: 3, headRefName: 'codex/daily-dogfood-sync', url: 'https://github.com/o/r/pull/3' },
            { number: 4, headRefName: 'codex/sync-kaizen-shared-skills', url: 'https://github.com/o/r/pull/4' },
            { number: 5, headRefName: 'codex/sync-kaizen-dogfood', url: 'https://github.com/o/r/pull/5' }
          ])
        );
      }
      return result(command, args, repo, '');
    });

    const resultSummary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      trigger: 'afternoon',
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in resultSummary && resultSummary.selected.map((item) => item.number)).toEqual([1]);
    expect('selected' in resultSummary && resultSummary.skipped).toEqual([]);
  });

  it('fetches enough open PRs before applying the sync PR exemption', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ run: { maxOpenPullRequests: 1 } }, { agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1)]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        const limit = Number(args[args.indexOf('--limit') + 1]);
        const syncPullRequests = Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          headRefName: 'codex/sync-kaizen-shared-skills',
          url: `https://github.com/o/r/pull/${index + 1}`
        }));
        const nonSyncPullRequest = { number: 101, headRefName: 'kaizen/issue-9-x', url: 'https://github.com/o/r/pull/101' };
        return result(command, args, repo, JSON.stringify(limit > 100 ? [...syncPullRequests, nonSyncPullRequest] : syncPullRequests));
      }
      return result(command, args, repo, '');
    });

    const resultSummary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      trigger: 'afternoon',
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in resultSummary && resultSummary.selected).toEqual([]);
    expect('selected' in resultSummary && resultSummary.skipped).toEqual([
      { number: 1, reason: 'open pull request limit reached (1/1)' }
    ]);
  });

  it('limits automatic selection to the remaining open PR capacity', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ run: { maxIssuesPerNight: 3, maxOpenPullRequests: 1 } }, { agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1), issue(2)]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(command, args, repo, '[]');
      }
      return result(command, args, repo, '');
    });

    const resultSummary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      trigger: 'afternoon',
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in resultSummary && resultSummary.selected.map((item) => item.number)).toEqual([1]);
    expect('selected' in resultSummary && resultSummary.skipped).toEqual([
      { number: 2, reason: 'open pull request limit would be exceeded (0/1)' }
    ]);
  });

  it('allows explicit issue runs even when the open PR limit is reached', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ run: { maxOpenPullRequests: 1 } }, { agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(1)));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([{ number: 3, headRefName: 'kaizen/issue-9-x', url: 'https://github.com/o/r/pull/3' }]));
      }
      return result(command, args, repo, '');
    });

    const resultSummary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      trigger: 'afternoon',
      issue: 1,
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in resultSummary && resultSummary.selected.map((item) => item.number)).toEqual([1]);
    expect(runner.mock.calls.some(([, args]) => args[0] === 'pr' && args[1] === 'list')).toBe(false);
  });
});

describe('runKaizen PR flow', () => {
  it('persists generated pull request WIP limit skips before starting work', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ safety: { wipLimit: 2 } }, { agent: 'claude', setup: null, verify: [] })
    );
    await saveRegistry({
      version: 1,
      projects: {
        'o-r': {
          repo: 'o/r',
          localPath: repo,
          workspacePath: workspace,
          schedule: '02:00',
          enabled: true,
          createdAt: '2026-06-12T00:00:00Z'
        }
      }
    });

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1)]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(command, args, repo, '[]');
      }
      if (command === 'gh' && args[0] === 'search' && args[1] === 'prs') {
        return result(
          command,
          args,
          repo,
          JSON.stringify([
            {
              number: 10,
              author: { login: 'github-actions[bot]', type: 'Bot' },
              repository: { nameWithOwner: 'o/r' },
              url: 'https://github.com/o/r/pull/10'
            },
            {
              number: 11,
              author: { login: 'github-actions[bot]', type: 'Bot' },
              repository: { nameWithOwner: 'o/other' },
              url: 'https://github.com/o/other/pull/11'
            }
          ])
        );
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      trigger: 'afternoon',
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues).toEqual([]);
    expect('issues' in summary && summary.skipped).toEqual([
      {
        number: 1,
        reason: 'generated pull request WIP limit reached (organization 2/2, repository 1/2)'
      }
    ]);
    expect(runner.mock.calls.some(([command]) => command === 'git')).toBe(false);
    const runsDir = path.join(home, 'projects', 'o-r', 'runs');
    const runIds = await fs.readdir(runsDir);
    const persisted = JSON.parse(await fs.readFile(path.join(runsDir, runIds[0], 'summary.json'), 'utf8'));
    expect(persisted.skipped).toEqual(summary.skipped);
  });

  it('persists scheduled skips caused by latestStartHour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'));
    try {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
      vi.stubEnv('KAIZEN_HOME', home);
      await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
      await fs.writeFile(
        path.join(repo, '.kaizen', 'config.yml'),
        defaultConfigWith({ run: { latestStartHour: 0 } }, { agent: 'claude', setup: null, verify: [] })
      );
      await saveRegistry({
        version: 1,
        projects: {
          'o-r': {
            repo: 'o/r',
            localPath: repo,
            workspacePath: workspace,
            schedule: '02:00',
            enabled: true,
            createdAt: '2026-06-12T00:00:00Z'
          }
        }
      });

      const runner = vi.fn<CommandRunner>(async (command, args) => result(command, args, repo, ''));

      const summary = await runKaizen({
        cwd: repo,
        project: 'o-r',
        scheduled: true,
        trigger: 'scheduled',
        dryRun: false,
        json: true,
        runCommand: runner
      });

      expect('issues' in summary && summary.skipped).toEqual([{ number: 0, reason: 'latestStartHour(0) passed' }]);
      expect(runner).not.toHaveBeenCalled();
      const runsDir = path.join(home, 'projects', 'o-r', 'runs');
      const runIds = await fs.readdir(runsDir);
      expect(runIds).toHaveLength(1);
      const persisted = JSON.parse(await fs.readFile(path.join(runsDir, runIds[0], 'summary.json'), 'utf8'));
      expect(persisted.skipped).toEqual([{ number: 0, reason: 'latestStartHour(0) passed' }]);
      const registry = JSON.parse(await fs.readFile(path.join(home, 'registry.json'), 'utf8'));
      expect(registry.projects['o-r'].lastRun).toMatchObject({
        result: 'success',
        processed: 0,
        fixed: 0,
        prCreated: 0,
        failed: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs afternoon triggers after latestStartHour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'));
    try {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
      vi.stubEnv('KAIZEN_HOME', home);
      await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
      await fs.writeFile(
        path.join(repo, '.kaizen', 'config.yml'),
        defaultConfigWith(
          { run: { latestStartHour: 0 } },
          { agent: 'claude', setup: null, verify: [] }
        )
      );
      await saveRegistry({
        version: 1,
        projects: {
          'o-r': {
            repo: 'o/r',
            localPath: repo,
            workspacePath: workspace,
            schedule: '02:00',
            enabled: true,
            createdAt: '2026-06-12T00:00:00Z'
          }
        }
      });

      const runner = vi.fn<CommandRunner>(async (command, args) => result(command, args, repo, JSON.stringify([])));

      const summary = await runKaizen({
        cwd: repo,
        project: 'o-r',
        scheduled: true,
        trigger: 'afternoon',
        dryRun: false,
        json: true,
        runCommand: runner
      });

      expect(runner).toHaveBeenCalledWith('gh', expect.arrayContaining(['issue', 'list']), expect.any(Object));
      expect('issues' in summary && summary.trigger).toBe('afternoon');
      expect('issues' in summary && summary.skipped).toEqual([]);
      const runsDir = path.join(home, 'projects', 'o-r', 'runs');
      const runIds = await fs.readdir(runsDir);
      const persisted = JSON.parse(await fs.readFile(path.join(runsDir, runIds[0], 'summary.json'), 'utf8'));
      expect(persisted.trigger).toBe('afternoon');
      expect(persisted.skipped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the open PR list fetched during automatic issue selection for intake', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1, { body: 'This was already fixed by #4.' })]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([{ number: 4, headRefName: 'kaizen/issue-1-fix', url: 'https://github.com/o/r/pull/4' }]));
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') return result(command, args, repo, '');
      return result(command, args, repo, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      trigger: 'afternoon',
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.skipped[0]).toMatchObject({ number: 1 });
    expect(runner.mock.calls.filter(([command, args]) => command === 'gh' && args[0] === 'pr' && args[1] === 'list')).toHaveLength(1);
  });

  it('does not repost an already-resolved intake comment with an existing marker', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: [] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(1, {
          body: 'This was already fixed.',
          comments: [{ body: '<!-- kaizen-loop:intake-decision status=already_resolved -->' }]
        })));
      }
      return result(command, args, repo, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.skipped[0]).toMatchObject({ number: 1 });
    expect(runner.mock.calls.some(([command, args]) => command === 'gh' && args[0] === 'issue' && args[1] === 'comment')).toBe(false);
  });

  it('runs scheduler jobs with lateStartGuard disabled after latestStartHour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'));
    try {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
      vi.stubEnv('KAIZEN_HOME', home);
      await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
      await fs.writeFile(
        path.join(repo, '.kaizen', 'config.yml'),
        defaultConfigWith(
          {
            run: { latestStartHour: 0 },
            scheduler: {
              jobs: {
                maintenance: {
                  enabled: true,
                  schedule: { type: 'interval', everyHours: 8, anchorTime: '02:45' },
                  run: { mode: 'maintenance', lateStartGuard: false }
                }
              }
            }
          },
          { agent: 'claude', setup: null, verify: [] }
        )
      );
      await saveRegistry({
        version: 1,
        projects: {
          'o-r': {
            repo: 'o/r',
            localPath: repo,
            workspacePath: workspace,
            schedule: '02:00',
            enabled: true,
            createdAt: '2026-06-12T00:00:00Z'
          }
        }
      });

      const runner = vi.fn<CommandRunner>(async (command, args) => result(command, args, repo, JSON.stringify([])));

      const summary = await runKaizen({
        cwd: repo,
        project: 'o-r',
        scheduled: true,
        job: 'maintenance',
        dryRun: false,
        json: true,
        runCommand: runner
      });

      expect(runner).toHaveBeenCalledWith('gh', expect.arrayContaining(['issue', 'list']), expect.any(Object));
      expect('issues' in summary && summary.trigger).toBe('maintenance');
      expect('issues' in summary && summary.skipped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips overlapping scheduled watch jobs when skipIfRunning is enabled', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({
        scheduler: {
          jobs: {
            'issue-watch': {
              enabled: true,
              schedule: { type: 'interval', everyMinutes: 5 },
              run: { mode: 'watch', skipIfRunning: true }
            }
          }
        }
      }, { agent: 'claude', setup: null, verify: [] })
    );
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
    const stateDir = path.join(home, 'projects', 'o-r');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'run.lock'), JSON.stringify({ pid: process.pid }));

    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue()]));
      }
      return result(command, args, repo, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: true,
      job: 'issue-watch',
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.trigger).toBe('issue-watch');
    expect('issues' in summary && summary.result).toBe('success');
    expect('issues' in summary && summary.issues).toHaveLength(0);
    expect('issues' in summary && summary.skipped).toEqual([{ number: 0, reason: 'run already in progress' }]);
  });

  it('aborts the run when baseline verification fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1), issue(2)]));
      }
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'claude' && args[0] === '-p' && args[1] === 'ok') return result(command, args, workspace, 'ok');
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') {
        return { ...result(command, args, workspace, 'not ok'), exitCode: 1, stderr: 'failed' };
      }
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.result).toBe('failed');
    expect('issues' in summary && summary.issues).toHaveLength(0);
    expect('issues' in summary && summary.skipped.map((item) => item.number)).toEqual([1, 2]);
    const issueComments = runner.mock.calls.filter(
      ([command, args]) => command === 'gh' && args.join(' ').startsWith('issue comment')
    );
    expect(issueComments).toHaveLength(1);
    expect(String(issueComments[0][1].at(-1))).not.toContain('kaizen-loop:result');
    const claudeRuns = runner.mock.calls.filter(([command, args]) => command === 'claude' && args[0] !== '-p');
    expect(claudeRuns).toHaveLength(0);
  });

  it('switches instant direct commits to PR by default when unattended', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }));
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
        return result(command, args, repo, JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  },
                  nodes: []
                }
              }
            }
          }
        }));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: '直した',
          notes: 'Protected path changed: .github/workflows/ci.yml'
        });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'open_pr', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.trigger).toBe('instant');
    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    expect('issues' in summary && summary.issues[0].reason).toContain('Verifier cleared PR');
    const prCreateArgs = runner.mock.calls.find(([command, args]) => command === 'gh' && args[0] === 'pr' && args[1] === 'create');
    expect(prCreateArgs?.[1]).not.toContain('--draft');
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain('push -u --force-with-lease origin kaizen/issue-1-fix-bug');
    expect(gitCommands).not.toContain('push origin main');
    const prCreate = runner.mock.calls.find(([command, args]) => command === 'gh' && args.join(' ').startsWith('pr create'));
    expect(String(prCreate?.[1].at(-1))).toContain('## Builder notes');
    expect(String(prCreate?.[1].at(-1))).toContain('Protected path changed');
    const guardian = runner.mock.calls.find(([command, args]) => command === 'codex' && args.join(' ').startsWith('exec '));
    expect(guardian).toBeDefined();
    expect(guardian?.[1]).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(String(guardian?.[1].at(-1))).toContain('skills/pr-guardian/SKILL.md');
    expect(String(guardian?.[1].at(-1))).toContain('gh run watch --exit-status');
    expect(String(guardian?.[1].at(-1))).toContain('https://github.com/o/r/pull/4');
    const comments = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue comment'));
    expect(comments[0][1].at(-1)).toContain('PR created (https://github.com/o/r/pull/4); monitoring CI and review feedback');
    expect(String(comments[0][1].at(-1))).toContain('kaizen-loop:progress');
    expect(String(comments.at(-1)?.[1].at(-1))).toContain('"trigger":"instant"');
    expect(String(comments.at(-1)?.[1].at(-1))).toContain('### Notes');
    expect(String(comments.at(-1)?.[1].at(-1))).toContain('PR guardian: success');
  });

  it('records a PR progress marker when post-create readiness validation fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }));
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') return result(command, args, repo, '');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'edit') return result(command, args, repo, '');
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return result(
          command,
          args,
          repo,
          JSON.stringify({
            number: 4,
            url: 'https://github.com/o/r/pull/4',
            baseRefName: 'main',
            isDraft: false,
            closingIssuesReferences: []
          })
        );
      }
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: '直した',
          notes: ''
        });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'open_pr', summary: 'PRで確認する', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return result(command, args, workspace, 'abc123\n');
      if (command === 'git') return result(command, args, workspace, '');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('failed');
    expect('issues' in summary && summary.issues[0].reason).toContain('Created pull request https://github.com/o/r/pull/4 failed readiness validation');
    const comments = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue comment'));
    expect(comments).toHaveLength(2);
    expect(String(comments[0][1].at(-1))).toContain('PR created (https://github.com/o/r/pull/4); monitoring CI and review feedback');
    expect(String(comments[0][1].at(-1))).toContain('kaizen-loop:progress');
    expect(String(comments[0][1].at(-1))).toContain('"outcome":"pr-monitoring"');
    expect(String(comments[1][1].at(-1))).toContain('closing issue reference #1 was not recognized by GitHub');
    expect(runner.mock.calls.some(([command]) => command === 'codex')).toBe(false);
  });

  it('enqueues PR Guardian instead of blocking when async mode is enabled', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ guardian: { mode: 'async' } }, { agent: 'claude', setup: null, verify: ['npm test'] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'open_pr', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return result(command, args, workspace, 'abc123456789\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect(summary).toHaveProperty('issues');
    if (!('issues' in summary)) throw new Error('Expected run summary with issues.');
    expect(summary.issues[0]).toMatchObject({ guardian: { status: 'queued' } });
    expect(summary.issues[0].guardian?.status).toBe('queued');
    expect(runner.mock.calls.some(([command]) => command === 'codex')).toBe(false);
    const jobsDir = path.join(home, 'projects', 'o-r', 'guardian', 'jobs');
    const jobs = await fs.readdir(jobsDir);
    expect(jobs).toHaveLength(1);
    const job = JSON.parse(await fs.readFile(path.join(jobsDir, jobs[0]), 'utf8')) as { status: string; headSha: string; prNumber: number };
    expect(job).toMatchObject({ status: 'pending', headSha: 'abc123456789', prNumber: 4 });
  });

  it('processes selected issues concurrently in isolated worktrees and creates one closing PR per issue', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ verifier: { enabled: false } }, { agent: 'claude', setup: null, verify: ['npm test'] })
    );
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

    let activeBuilders = 0;
    let maxActiveBuilders = 0;
    let prCount = 0;
    const builderWorkspaces = new Set<string>();
    const prBodies: string[] = [];

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue(1), issue(2)]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        prCount += 1;
        prBodies.push(String(args.at(-1)));
        return result(command, args, repo, `https://github.com/o/r/pull/${prCount}\n`);
      }
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        activeBuilders += 1;
        maxActiveBuilders = Math.max(maxActiveBuilders, activeBuilders);
        builderWorkspaces.add(String(options?.cwd));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        activeBuilders -= 1;
        return result(command, args, options?.cwd, 'built');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, options?.cwd, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, options?.cwd, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, options?.cwd, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, options?.cwd, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues.map((item) => item.outcome)).toEqual(['pr-created', 'pr-created']);
    expect(maxActiveBuilders).toBeGreaterThan(1);
    expect(builderWorkspaces.size).toBe(2);
    expect([...builderWorkspaces].every((item) => item.includes(`${path.basename(workspace)}-worktrees`))).toBe(true);
    expect(prBodies).toHaveLength(2);
    expect(prBodies).toEqual(expect.arrayContaining([expect.stringContaining('Closes #1'), expect.stringContaining('Closes #2')]));
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands.some((command) => command.startsWith('worktree add -B kaizen/issue-1-fix-bug '))).toBe(true);
    expect(gitCommands.some((command) => command.startsWith('worktree add -B kaizen/issue-2-fix-bug '))).toBe(true);
    // 2 issues x (1 pre-cleanup remove in createIssueWorktree + 1 post-cleanup remove in removeIssueWorktree) = 4
    expect(gitCommands.filter((command) => command.startsWith('worktree remove --force '))).toHaveLength(4);
  });

  it('files builder-discovered follow-up issues through GitHub', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }));
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        if (args.join(' ').includes('Verifier duplicate follow-up')) {
          return result(command, args, repo, JSON.stringify([
            {
              ...issue(78, { title: 'Verifier duplicate follow-up' }),
              url: 'https://github.com/kaizen-agents-org/verifier/issues/78'
            }
          ]));
        }
        return result(command, args, repo, '[]');
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/kaizen-agents-org/verifier/issues/77\n');
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: '直した',
          notes: '',
          discoveredIssues: [
            {
              title: 'Verifier false-positive on legacy status words',
              repo: 'verifier',
              body: 'Verifier rejected a clean run from summary text.',
              expected: 'Only real failures should block PR creation.',
              evidence: 'verifier.log',
              severity: 'P2'
            },
            {
              title: 'Verifier duplicate follow-up',
              repo: 'verifier',
              body: 'Verifier already has this follow-up open.',
              expected: 'The duplicate should not be filed again.',
              evidence: 'existing issue'
            }
          ]
        });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'approved', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    const expectedFollowups = [
      {
        title: 'Verifier false-positive on legacy status words',
        repo: 'kaizen-agents-org/verifier',
        status: 'created',
        url: 'https://github.com/kaizen-agents-org/verifier/issues/77'
      },
      {
        title: 'Verifier duplicate follow-up',
        repo: 'kaizen-agents-org/verifier',
        status: 'duplicate',
        url: 'https://github.com/kaizen-agents-org/verifier/issues/78'
      }
    ];
    expect('issues' in summary && summary.issues[0].discoveredFollowups).toEqual(expectedFollowups);
    const runIds = await fs.readdir(path.join(home, 'projects', 'o-r', 'runs'));
    const writtenSummary = JSON.parse(await fs.readFile(path.join(home, 'projects', 'o-r', 'runs', runIds[0], 'summary.json'), 'utf8'));
    expect(writtenSummary.issues[0].discoveredFollowups).toEqual(expectedFollowups);
    const issueCreate = runner.mock.calls.find(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue create'));
    expect(issueCreate).toBeDefined();
    const issueCreateArgs = issueCreate![1];
    expect(issueCreateArgs).toContain('--repo');
    expect(issueCreateArgs).toContain('kaizen-agents-org/verifier');
    expect(issueCreateArgs).toContain('--label');
    expect(issueCreateArgs).toContain('kaizen,kaizen:P2');
    expect(String(issueCreateArgs.at(issueCreateArgs.indexOf('--body') + 1))).toContain('Source issue');
    const comments = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue comment'));
    expect(comments.some(([, args]) => String(args.at(-1)).includes('Kaizen discovered follow-up issue'))).toBe(true);
    expect(comments.some(([, args]) => String(args.at(-1)).includes('Existing in `kaizen-agents-org/verifier`'))).toBe(true);
  });

  it('routes builder-discovered issues to the registered repo named by evidence paths', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    const verifierRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-repo-'));
    const verifierWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-workspace-'));
    const sourceWorktree = path.join(path.dirname(workspace), `${path.basename(workspace)}-worktrees`, '2026-06-26T05-45-05Z', 'issue-1');
    const verifierWorktreeRoot = path.join(path.dirname(verifierWorkspace), `${path.basename(verifierWorkspace)}-worktrees`);
    const verifierWorktree = path.join(verifierWorktreeRoot, '2026-06-26T05-45-05Z', 'issue-7');
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }));
    await saveRegistry({
      version: 1,
      projects: {
        'kaizen-agents-org-kaizen-loop': {
          repo: 'kaizen-agents-org/kaizen-loop',
          localPath: repo,
          workspacePath: workspace,
          schedule: '02:00',
          enabled: false,
          createdAt: '2026-06-12T00:00:00Z'
        },
        'kaizen-agents-org-verifier': {
          repo: 'kaizen-agents-org/verifier',
          localPath: verifierRepo,
          workspacePath: verifierWorkspace,
          schedule: '03:00',
          enabled: false,
          createdAt: '2026-06-12T00:00:00Z'
        }
      }
    });

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        const targetRepo = String(args.at(args.indexOf('--repo') + 1));
        return result(command, args, repo, `https://github.com/${targetRepo}/issues/77\n`);
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/kaizen-agents-org/kaizen-loop/pull/4\n');
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: '直した',
          notes: '',
          discoveredIssues: [
            {
              title: 'Verifier workspace verification failed',
              repo: 'kaizen-loop',
              body: 'A fleet verification failure belongs to the verifier repository.',
              expected: 'The follow-up issue should be processed by verifier.',
              evidence: `pnpm test failed under ${verifierWorktree}/packages/core/test/cli.test.ts`,
              severity: 'P2'
            },
            {
              title: 'Verifier-old workspace verification failed',
              repo: 'kaizen-loop',
              body: 'A similarly named workspace should not be treated as verifier evidence.',
              expected: 'The follow-up issue should stay with kaizen-loop.',
              evidence: `pnpm test failed under ${verifierWorktreeRoot}-old/2026-06-26T05-45-05Z/issue-7/packages/core/test/cli.test.ts`,
              severity: 'P2'
            },
            {
              title: 'Verifier reported target with source worktree evidence',
              repo: 'verifier',
              body: 'The reported verifier target should not be overridden by source worktree paths.',
              expected: 'The follow-up issue should be processed by verifier.',
              evidence: `kaizen-loop ran from ${sourceWorktree}/src/orchestrator/run.ts and verifier failed under ${verifierRepo}/packages/core/test/cli.test.ts`,
              severity: 'P2'
            }
          ]
        });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'approved', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/kaizen-agents-org/kaizen-loop.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'kaizen-agents-org-kaizen-loop',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    const issueCreates = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue create'));
    expect(issueCreates).toHaveLength(3);
    const verifierCreate = issueCreates.find(([, args]) => args.includes('Verifier workspace verification failed'));
    expect(verifierCreate).toBeDefined();
    expect(verifierCreate![1]).toContain('--repo');
    expect(verifierCreate![1]).toContain('kaizen-agents-org/verifier');
    const verifierBody = String(verifierCreate![1].at(verifierCreate![1].indexOf('--body') + 1));
    expect(verifierBody).toContain('evidence matched a registered project path for this repository');
    expect(verifierBody).not.toContain('registered project path `');
    expect(verifierBody).toContain('kaizen-agents-org/kaizen-loop#1');

    const oldWorkspaceCreate = issueCreates.find(([, args]) => args.includes('Verifier-old workspace verification failed'));
    expect(oldWorkspaceCreate).toBeDefined();
    expect(oldWorkspaceCreate![1]).toContain('--repo');
    expect(oldWorkspaceCreate![1]).toContain('kaizen-agents-org/kaizen-loop');

    const reportedVerifierCreate = issueCreates.find(([, args]) => args.includes('Verifier reported target with source worktree evidence'));
    expect(reportedVerifierCreate).toBeDefined();
    expect(reportedVerifierCreate![1]).toContain('--repo');
    expect(reportedVerifierCreate![1]).toContain('kaizen-agents-org/verifier');
  });

  it('retries builder-discovered issue creation with the base label when the priority label is missing', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }));
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        const labelValue = String(args.at(args.indexOf('--label') + 1));
        if (labelValue.includes('kaizen:P2')) throw new Error("could not add label: 'kaizen:P2' not found");
        return result(command, args, repo, 'https://github.com/external/project/issues/12\n');
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: '直した',
          notes: '',
          discoveredIssues: [
            {
              title: 'External repo bug',
              repo: 'external/project',
              body: 'A separate bug was observed.',
              evidence: 'log excerpt',
              severity: 'P2'
            }
          ]
        });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'approved', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    const issueCreates = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue create'));
    expect(issueCreates.length).toBe(2);
    expect(issueCreates.at(-1)?.[1]).toContain('--label');
    expect(issueCreates.at(-1)?.[1]).toContain('kaizen');
    expect(issueCreates.at(-1)?.[1]).toContain('external/project');
  });

  it('routes builder-discovered policy repository aliases to their owning repos', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }));
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        const targetRepo = String(args.at(args.indexOf('--repo') + 1));
        return result(command, args, repo, `https://github.com/${targetRepo}/issues/77\n`);
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: '直した',
          notes: '',
          discoveredIssues: [
            {
              title: 'CodeRabbit rule regression',
              repo: 'coderabbit',
              body: 'CodeRabbit configuration missed a project rule.',
              evidence: 'coderabbit.yml'
            },
            {
              title: 'Renovate preset regression',
              repo: 'renovate-config',
              body: 'Renovate configuration missed a preset.',
              evidence: 'renovate.json'
            }
          ]
        });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'approved', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    const issueCreates = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue create'));
    const targetRepos = issueCreates.map(([, args]) => String(args.at(args.indexOf('--repo') + 1)));
    expect(targetRepos).toEqual(['kaizen-agents-org/coderabbit', 'kaizen-agents-org/renovate-config']);
  });

  it('rejects instant direct commits when unattended mode is reject', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] })
        .replace('mode: pr-only', 'mode: hybrid')
        .replace('unattendedMode: pr', 'unattendedMode: reject')
        .replace('verifier:\n  enabled: true', 'verifier:\n  enabled: false')
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        return result(command, args, workspace, 'built');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'instant',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('failed');
    expect('issues' in summary && summary.issues[0].reason).toContain('Direct commit rejected');
    const ghCommands = runner.mock.calls.filter(([command]) => command === 'gh').map(([, args]) => args.join(' '));
    expect(ghCommands.some((command) => command.startsWith('pr create'))).toBe(false);
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands.some((command) => command.startsWith('push'))).toBe(false);
  });

  it('preserves direct commits for single-issue manual runs from an issue worktree', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ verifier: { enabled: false }, policy: { mode: 'hybrid' } }, { agent: 'claude', setup: null, verify: ['npm test'] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        return result(command, args, options?.cwd, 'built');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, options?.cwd, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, options?.cwd, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, options?.cwd, '1\t0\tsrc/file.ts\n');
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return result(command, args, options?.cwd, 'abc123\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, options?.cwd, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      trigger: 'manual',
      issue: 1,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('direct-commit');
    expect('issues' in summary && summary.issues[0].commit).toBe('abc123');
    const ghCommands = runner.mock.calls.filter(([command]) => command === 'gh').map(([, args]) => args.join(' '));
    expect(ghCommands.some((command) => command.startsWith('pr create'))).toBe(false);
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain('checkout --ignore-other-worktrees main');
    expect(gitCommands).toContain('push -u origin main');
  });

  it('returns block_pr verifier results to the builder before creating a PR', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }).replace('maxVerifyRetries: 2', 'maxVerifyRetries: 1')
    );
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

    let builderRuns = 0;
    let verifierRuns = 0;
    const builderPrompts: string[] = [];
    const verifierPrompts: string[] = [];
    const prBodies: string[] = [];
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue()]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        prBodies.push(String(args[args.indexOf('--body') + 1]));
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        builderRuns += 1;
        builderPrompts.push(String(options?.input ?? ''));
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: `直した${builderRuns}`, notes: '' });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        verifierRuns += 1;
        verifierPrompts.push(String(options?.input ?? ''));
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, {
          status: verifierRuns === 1 ? 'block_pr' : 'open_pr',
          summary: verifierRuns === 1 ? '不足あり' : '確認した',
          notes: verifierRuns === 1 ? 'テストを追加してください' : ''
        });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --no-ext-diff origin/main...HEAD') {
        return result(command, args, workspace, 'diff --git a/src/file.ts b/src/file.ts\n+const evidence = true;\n');
      }
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'PASS integration evidence\n');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect(builderRuns).toBe(2);
    expect(verifierRuns).toBe(2);
    expect(builderPrompts[1]).toContain('Verifier blocked PR');
    expect(verifierPrompts[0]).toContain('diff --git a/src/file.ts b/src/file.ts');
    expect(verifierPrompts[0]).toContain('+const evidence = true;');
    expect(verifierPrompts[0]).toContain('PASS integration evidence');
    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    expect('issues' in summary && summary.issues[0].reason).toContain('Verifier cleared PR');
    expect(prBodies[0]).toContain('## Verifier');
    expect(prBodies[0]).toContain('verifier: open_pr');
    expect(prBodies[0]).toContain('summary: 確認した');
  });

  it('surfaces open_pr_with_warning verifier status in generated PR bodies', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] })
    );
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

    let prBody = '';
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, JSON.stringify([issue()]));
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        prBody = String(args[args.indexOf('--body') + 1]);
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, {
          status: 'open_pr_with_warning',
          summary: '確認したが注意あり',
          reason: 'low confidence',
          notes: 'human should double-check docs'
        });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    expect(prBody).toContain('## Verifier');
    expect(prBody).toContain('verifier: open_pr_with_warning');
    expect(prBody).toContain('summary: 確認したが注意あり');
    expect(prBody).toContain('reason: low confidence');
    expect(prBody).toContain('notes: human should double-check docs');
  });

  it('accepts legacy approved verifier payloads as open_pr', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] })
    );
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, JSON.stringify([issue()]));
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'approved', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    expect('issues' in summary && summary.issues[0].reason).toContain('Verifier cleared PR');
  });

  it('commits verifier-generated changes before pushing the branch', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: 'npm ci', verify: ['npm test'] })
    );
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

    let statusCalls = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue()]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        return result(
          command,
          args,
          workspace,
          'built'
        );
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'open_pr', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') {
        statusCalls += 1;
        return result(command, args, workspace, statusCalls === 2 ? 'M generated.txt\n' : '');
      }
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') {
        return result(command, args, workspace, 'src/file.ts\ngenerated.txt\n');
      }
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') {
        return result(command, args, workspace, '1\t0\tsrc/file.ts\n1\t0\tgenerated.txt\n');
      }
      if (command === 'sh' && args.join(' ') === '-lc npm ci') return result(command, args, workspace, 'installed');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    const shellCommands = runner.mock.calls.filter(([command]) => command === 'sh').map(([, args]) => args.join(' '));
    expect(shellCommands.filter((command) => command === '-lc npm ci')).toHaveLength(2);
    expect(gitCommands).toContain('commit -m kaizen: 直した (#1)');
    expect(gitCommands).toContain('push -u --force-with-lease origin kaizen/issue-1-fix-bug');
  });

  it('fails an issue immediately when worktree setup fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: 'npm ci', verify: ['npm test'] })
    );
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

    let setupCalls = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue()]));
      }
      if (command === 'gh') return githubReadinessResult(command, args, repo);
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'sh' && args.join(' ') === '-lc npm ci') {
        setupCalls += 1;
        return setupCalls === 1
          ? result(command, args, options?.cwd, 'base setup ok')
          : failedResult(command, args, options?.cwd, 'worktree setup failed');
      }
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, options?.cwd, 'ok');
      if (command === 'builder-agent') throw new Error('builder must not run after setup failure');
      return result(command, args, options?.cwd, '');
    });

    const summary = await runKaizen({
      cwd: repo,
      project: 'o-r',
      scheduled: false,
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.issues[0]).toMatchObject({
      outcome: 'failed',
      reason: 'Setup failed: npm ci'
    });
    expect(setupCalls).toBe(2);
    expect(runner.mock.calls.some(([command]) => command === 'builder-agent')).toBe(false);
  });
});

function issue(number = 1, overrides: Partial<GitHubIssue> = {}) {
  return {
    number,
    title: overrides.title ?? 'Fix bug',
    body: overrides.body ?? 'The command fails during normal Kaizen processing and should be fixed with a regression test.',
    labels: overrides.labels ?? [{ name: 'kaizen' }],
    createdAt: overrides.createdAt ?? '2026-06-12T00:00:00Z',
    comments: overrides.comments ?? []
  };
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

function githubReadinessResult(command: string, args: string[], cwd: string | undefined) {
  if (args[0] === 'repo' && args[1] === 'view') {
    return result(command, args, cwd, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    return result(
      command,
      args,
      cwd,
      JSON.stringify({
        number: Number(args[2]),
        url: `https://github.com/o/r/pull/${args[2]}`,
        baseRefName: 'main',
        isDraft: false,
        closingIssuesReferences: [{ number: 1 }, { number: 2 }]
      })
    );
  }
  return result(command, args, cwd, '');
}

function failedResult(command: string, args: string[], cwd: string | undefined, stderr: string) {
  return {
    command,
    args,
    cwd,
    exitCode: 1,
    stdout: '',
    stderr,
    durationMs: 1
  };
}

async function writeJsonResult(filePath: unknown, payload: unknown) {
  if (typeof filePath !== 'string') throw new Error('missing result path');
  await fs.writeFile(filePath, JSON.stringify(payload));
}

function defaultConfigWith(
  overrides: Record<string, unknown>,
  options: { agent: 'claude' | 'codex'; setup: string | null; verify: string[] }
): string {
  const config = parse(defaultConfigYaml(options)) as Record<string, unknown>;
  mergeConfig(config, overrides);
  return stringify(config);
}

function defaultConfigYaml(options: { agent: 'claude' | 'codex'; setup: string | null; verify: string[] }): string {
  const config = parse(buildDefaultConfigYaml(options)) as Record<string, unknown>;
  mergeConfig(config, { guardian: { reviewSettleSeconds: 0 } });
  return stringify(config);
}

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key]) && !('type' in value)) {
      mergeConfig(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
