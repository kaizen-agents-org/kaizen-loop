import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';
import { GitClient } from '../src/workspace/git.js';
import { WorkspaceManager } from '../src/workspace/manager.js';

describe('workspace branch handling', () => {
  it('replaces an existing deterministic issue branch before retrying', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, '/workspace', 'https://github.com/o/r.git');
    const config = configSchema.parse({ version: 1 });

    const branch = await workspace.createIssueBranch(config, { number: 12, title: 'Retry branch' });

    expect(branch).toBe('kaizen/issue-12-retry-branch');
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ['branch', '-D', 'kaizen/issue-12-retry-branch'],
      ['switch', '-c', 'kaizen/issue-12-retry-branch']
    ]);
  });

  it('can force-with-lease when pushing regenerated issue branches', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const git = new GitClient(runner, '/workspace');

    await git.push('kaizen/issue-12-retry-branch', { forceWithLease: true });

    expect(runner.mock.calls[0][1]).toEqual([
      'push',
      '-u',
      '--force-with-lease',
      'origin',
      'kaizen/issue-12-retry-branch'
    ]);
  });

  it('can check out a branch even when another worktree has it checked out', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const git = new GitClient(runner, '/workspace');

    await git.checkout('main', { ignoreOtherWorktrees: true });

    expect(runner.mock.calls[0][1]).toEqual(['checkout', '--ignore-other-worktrees', 'main']);
  });

  it('removes stale worktrees that still hold the issue branch before retrying', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const oldWorktreePath = path.join(root, 'workspace-worktrees', 'old-run', 'issue-12');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: 0,
      stdout:
        args.join(' ') === 'worktree list --porcelain'
          ? [
              `worktree ${workspacePath}`,
              'HEAD abc',
              'branch refs/heads/main',
              '',
              `worktree ${oldWorktreePath}`,
              'HEAD def',
              'branch refs/heads/kaizen/issue-12-retry-branch',
              ''
            ].join('\n')
          : '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath, 'https://github.com/o/r.git');
    const config = configSchema.parse({ version: 1 });

    const worktree = await workspace.createIssueWorktree(config, { number: 12, title: 'Retry branch' }, 'new-run');

    expect(worktree).toEqual({
      branch: 'kaizen/issue-12-retry-branch',
      path: path.join(root, 'workspace-worktrees', 'new-run', 'issue-12')
    });
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain(`worktree remove --force ${oldWorktreePath}`);
    expect(gitCommands).toContain(
      `worktree add -B kaizen/issue-12-retry-branch ${path.join(root, 'workspace-worktrees', 'new-run', 'issue-12')} origin/main`
    );
  });

  it('can abort a failed rebase before falling back to PR creation', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const git = new GitClient(runner, '/workspace');

    await git.abortRebase();

    expect(runner.mock.calls[0][1]).toEqual(['rebase', '--abort']);
    expect(runner.mock.calls[0][2]?.rejectOnNonZero).toBe(false);
  });

  it('collects bounded diff text against the default branch', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'abcdef',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, '/workspace');
    const config = configSchema.parse({ version: 1 });

    const diff = await workspace.collectDiffText(config, 3);

    expect(diff).toBe('abc\n\n[truncated after 3 characters]');
    expect(runner.mock.calls[0][1]).toEqual(['diff', '--no-ext-diff', 'origin/main...HEAD']);
  });

  it('runs verification commands with a workspace-local temporary directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: options?.env?.TMPDIR ?? '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath, 'https://github.com/o/r.git');
    const config = configSchema.parse({
      version: 1,
      commands: {
        verify: ['npm test']
      }
    });

    const results = await workspace.runVerify(config);

    expect(results[0].output).toBe(path.join(workspacePath, '.kaizen', 'tmp'));
    expect(runner.mock.calls[0][2]?.env?.TMPDIR).toBe(path.join(workspacePath, '.kaizen', 'tmp'));
    expect(runner.mock.calls[0][2]?.env?.TMP).toBe(path.join(workspacePath, '.kaizen', 'tmp'));
    expect(runner.mock.calls[0][2]?.env?.TEMP).toBe(path.join(workspacePath, '.kaizen', 'tmp'));
  });

  it('caps verification command timeout at the remaining run deadline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: String(options?.timeoutMs ?? ''),
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath, 'https://github.com/o/r.git');
    const config = configSchema.parse({
      version: 1,
      commands: {
        verify: ['npm test'],
        verifyTimeoutMinutes: 15
      }
    });

    await workspace.runVerify(config, Date.now() + 2_000);

    expect(runner.mock.calls[0][2]?.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(runner.mock.calls[0][2]?.timeoutMs).toBeGreaterThan(0);
  });
});
