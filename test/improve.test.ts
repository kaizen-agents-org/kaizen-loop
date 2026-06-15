import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planImprove, runImprove } from '../src/commands/improve.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('planImprove', () => {
  it('plans queued issues with the existing selection rules', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([
          issue(3, 'P2 later', 'kaizen:P2', '2026-06-12T02:00:00Z'),
          issue(1, 'P1 first', 'kaizen:P1', '2026-06-12T03:00:00Z'),
          issue(2, 'P2 earlier', 'kaizen:P2', '2026-06-12T01:00:00Z')
        ]));
      }
      return result(command, args, options?.cwd, '');
    });

    const plan = await planImprove({
      cwd: repo,
      project: 'o-r',
      dryRun: true,
      maxIssues: 2,
      json: true,
      runCommand: runner
    });

    expect(plan.selected.map((item) => item.number)).toEqual([1, 2]);
    expect(plan.skipped).toEqual([{ number: 3, reason: 'maxIssuesPerNight reached' }]);
  });

  it('uses explicit issue numbers as the default max issue limit', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(Number(args[2]), `Issue ${args[2]}`, 'kaizen:P2')));
      }
      return result(command, args, options?.cwd, '');
    });

    const plan = await planImprove({
      cwd: repo,
      project: 'o-r',
      issueNumbers: [4, 5],
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect(plan.selected.map((item) => item.number)).toEqual([4, 5]);
    const issueViewCalls = runner.mock.calls.filter(([, args]) => args[0] === 'issue' && args[1] === 'view');
    expect(issueViewCalls).toHaveLength(2);
  });

  it('skips explicit issue numbers that do not have the required kaizen label', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        const number = Number(args[2]);
        const payload = number === 5
          ? issueWithoutKaizen(number, `Issue ${number}`)
          : issue(number, `Issue ${number}`, 'kaizen:P2');
        return result(command, args, repo, JSON.stringify(payload));
      }
      return result(command, args, options?.cwd, '');
    });

    const plan = await planImprove({
      cwd: repo,
      project: 'o-r',
      issueNumbers: [4, 5],
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect(plan.selected.map((item) => item.number)).toEqual([4]);
    expect(plan.skipped).toEqual([{ number: 5, reason: 'missing required label: kaizen' }]);
  });
});

describe('runImprove', () => {
  it('delegates dry-run execution to the instant improvement path', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(Number(args[2]), `Issue ${args[2]}`, 'kaizen:P2')));
      }
      return result(command, args, options?.cwd, '');
    });

    const output = await runImprove({
      cwd: repo,
      project: 'o-r',
      issueNumbers: [7],
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in output && output.selected[0].number).toBe(7);
  });

  it('does not treat plan confirmation as direct-commit approval', async () => {
    const { repo, workspace } = await setupProject({
      config: defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] })
        .replace('verifier:\n  enabled: true', 'verifier:\n  enabled: false')
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(Number(args[2]), `Issue ${args[2]}`, 'kaizen:P2')));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh') return result(command, args, repo, '');
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: 'fixed', notes: '' });
        return result(command, args, options?.cwd, 'built');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, options?.cwd, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, options?.cwd, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, options?.cwd, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, options?.cwd, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const output = await runImprove({
      cwd: repo,
      project: 'o-r',
      issueNumbers: [8],
      dryRun: false,
      json: true,
      runCommand: runner,
      assumeYes: true
    } as Parameters<typeof runImprove>[0] & { assumeYes: boolean });

    expect('issues' in output && output.issues[0].outcome).toBe('pr-created');
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands.some((command) => command === 'push -u origin main')).toBe(false);
    expect(gitCommands.some((command) => command === 'push -u --force-with-lease origin kaizen/issue-8-issue-8')).toBe(true);
  });
});

async function setupProject(options: { config?: string } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), options.config ?? defaultConfigYaml({ agent: 'claude', setup: null, verify: [] }));
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
  return { repo, workspace };
}

function issue(number: number, title: string, priority: string, createdAt = '2026-06-12T00:00:00Z') {
  return {
    number,
    title,
    body: '',
    labels: [{ name: 'kaizen' }, { name: priority }],
    createdAt,
    comments: []
  };
}

function issueWithoutKaizen(number: number, title: string) {
  return {
    number,
    title,
    body: '',
    labels: [{ name: 'bug' }],
    createdAt: '2026-06-12T00:00:00Z',
    comments: []
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

async function writeJsonResult(filePath: unknown, payload: unknown) {
  if (typeof filePath !== 'string') throw new Error('missing result path');
  await fs.writeFile(filePath, JSON.stringify(payload));
}
