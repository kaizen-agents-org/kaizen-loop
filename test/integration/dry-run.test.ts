import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfigYaml } from '../../src/config/config.js';
import { saveRegistry } from '../../src/config/registry.js';
import { runKaizen } from '../../src/orchestrator/run.js';
import type { CommandRunner } from '../../src/utils/command.js';

describe('runKaizen dry-run', () => {
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
});

describe('runKaizen PR flow', () => {
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
      if (command === 'gh') return result(command, args, repo, '');
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
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return result(command, args, repo, '');
      if (command === 'claude' && args[0] === '-p' && args[1] === 'ok') return result(command, args, workspace, 'ok');
      if (command === 'claude') {
        return result(command, args, workspace, JSON.stringify({ result: '```json\n{"status":"fixed","summary":"直した","notes":""}\n```' }));
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
    expect('issues' in summary && summary.issues[0].reason).toContain('Instant direct commit switched to PR');
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain('push -u --force-with-lease origin kaizen/issue-1-fix-bug');
    expect(gitCommands).not.toContain('push origin main');
    const comments = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue comment'));
    expect(String(comments.at(-1)?.[1].at(-1))).toContain('"trigger":"instant"');
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
      defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] }).replace('unattendedMode: pr', 'unattendedMode: reject')
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
      if (command === 'gh') return result(command, args, repo, '');
      if (command === 'claude' && args[0] === '-p' && args[1] === 'ok') return result(command, args, workspace, 'ok');
      if (command === 'claude') {
        return result(command, args, workspace, JSON.stringify({ result: '```json\n{"status":"fixed","summary":"直した","notes":""}\n```' }));
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

  it('commits verifier-generated changes before pushing the branch', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'claude', setup: 'npm ci', verify: ['npm test'] }).replace('mode: hybrid', 'mode: pr-only')
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
      if (command === 'gh') return result(command, args, repo, '');
      if (command === 'claude' && args[0] === '-p' && args[1] === 'ok') return result(command, args, workspace, 'ok');
      if (command === 'claude') {
        return result(
          command,
          args,
          workspace,
          JSON.stringify({ result: '```json\n{"status":"fixed","summary":"直した","notes":""}\n```' })
        );
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
});

function issue(number = 1) {
  return {
    number,
    title: 'Fix bug',
    body: '',
    labels: [{ name: 'kaizen' }],
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
