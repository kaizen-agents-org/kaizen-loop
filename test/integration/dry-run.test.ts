import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
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
  it('skips overlapping scheduled poll runs when skipIfRunning is enabled', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    vi.stubEnv('KAIZEN_HOME', home);
    await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.kaizen', 'config.yml'),
      defaultConfigWith({ scheduler: { poll: { enabled: true } } }, { agent: 'claude', setup: null, verify: [] })
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
      trigger: 'watch',
      dryRun: false,
      json: true,
      runCommand: runner
    });

    expect('issues' in summary && summary.trigger).toBe('watch');
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
    expect(String(comments.at(-1)?.[1].at(-1))).toContain('"trigger":"instant"');
    expect(String(comments.at(-1)?.[1].at(-1))).toContain('### Notes');
    expect(String(comments.at(-1)?.[1].at(-1))).toContain('PR guardian: success');
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
      if (command === 'gh') return result(command, args, repo, '');
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
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/kaizen-agents-org/verifier/issues/77\n');
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      if (command === 'gh') return result(command, args, repo, '');
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
      if (command === 'gh') return result(command, args, repo, '');
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
      if (command === 'gh') return result(command, args, repo, '');
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

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return result(command, args, repo, JSON.stringify(issue()));
      if (command === 'gh') return result(command, args, repo, '');
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
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([issue()]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh') return result(command, args, repo, '');
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

    expect(builderRuns).toBe(2);
    expect(verifierRuns).toBe(2);
    expect(builderPrompts[1]).toContain('Verifier blocked PR');
    expect('issues' in summary && summary.issues[0].outcome).toBe('pr-created');
    expect('issues' in summary && summary.issues[0].reason).toContain('Verifier cleared PR');
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
      if (command === 'gh') return result(command, args, repo, '');
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

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeConfig(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
