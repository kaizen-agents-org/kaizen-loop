import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';
import { resolveKaizenTempDir } from '../src/utils/temp.js';
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

  it('runs verification commands with a short temporary directory for tsx IPC sockets', async () => {
    const workspacePath = path.join(
      os.tmpdir(),
      'kaizen-workspace-test',
      'very-long-kaizen-worktree-path-that-would-overflow-tsx-ipc-socket-names',
      'issue-146'
    );
    const previousKaizenTmpDir = process.env.KAIZEN_TMPDIR;
    delete process.env.KAIZEN_TMPDIR;
    try {
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
      const expectedTmpDir = resolveKaizenTempDir(workspacePath, {});

      expect(results[0].output).toBe(expectedTmpDir);
      expect(expectedTmpDir.startsWith(workspacePath)).toBe(false);
      expect(path.join(expectedTmpDir, 'tsx-501', '19718.pipe').length).toBeLessThan(104);
      expect(runner.mock.calls[0][2]?.env?.TMPDIR).toBe(expectedTmpDir);
      expect(runner.mock.calls[0][2]?.env?.TMP).toBe(expectedTmpDir);
      expect(runner.mock.calls[0][2]?.env?.TEMP).toBe(expectedTmpDir);
    } finally {
      if (previousKaizenTmpDir === undefined) delete process.env.KAIZEN_TMPDIR;
      else process.env.KAIZEN_TMPDIR = previousKaizenTmpDir;
    }
  });

  it('honors KAIZEN_TMPDIR for verification command temporary directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const overrideTmpDir = path.join(root, 'operator-tmp');
    const previousKaizenTmpDir = process.env.KAIZEN_TMPDIR;
    process.env.KAIZEN_TMPDIR = overrideTmpDir;
    try {
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

      const expectedTmpDir = resolveKaizenTempDir(workspacePath, { KAIZEN_TMPDIR: overrideTmpDir });

      expect(results[0].output).toBe(expectedTmpDir);
      expect(expectedTmpDir.startsWith(`${overrideTmpDir}${path.sep}`)).toBe(true);
      expect(runner.mock.calls[0][2]?.env?.KAIZEN_TMPDIR).toBe(overrideTmpDir);
      expect(runner.mock.calls[0][2]?.env?.TMPDIR).toBe(expectedTmpDir);
      expect(runner.mock.calls[0][2]?.env?.TMP).toBe(expectedTmpDir);
      expect(runner.mock.calls[0][2]?.env?.TEMP).toBe(expectedTmpDir);
    } finally {
      if (previousKaizenTmpDir === undefined) delete process.env.KAIZEN_TMPDIR;
      else process.env.KAIZEN_TMPDIR = previousKaizenTmpDir;
    }
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

  it('repairs transient Rollup optional dependency verification failures once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    let verifyAttempts = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      const shellCommand = args.at(-1);
      if (shellCommand === 'pnpm test') {
        verifyAttempts += 1;
        return {
          command,
          args,
          cwd: options?.cwd,
          exitCode: verifyAttempts === 1 ? 1 : 0,
          stdout: verifyAttempts === 1 ? '' : 'ok\n',
          stderr:
            verifyAttempts === 1
              ? [
                  "Error: Cannot find module '@rollup/rollup-darwin-x64'",
                  'npm has a bug related to optional dependencies'
                ].join('\n')
              : '',
          durationMs: 1
        };
      }
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 0,
        stdout: 'installed\n',
        stderr: '',
        durationMs: 1
      };
    });
    const workspace = new WorkspaceManager(runner, workspacePath, 'https://github.com/o/r.git');
    const config = configSchema.parse({
      version: 1,
      commands: {
        setup: 'pnpm install --frozen-lockfile',
        verify: ['pnpm test'],
        verifyTimeoutMinutes: 15
      }
    });

    const results = await workspace.runVerify(config);

    expect(results).toEqual([
      {
        command: 'pnpm test',
        ok: true,
        output: expect.stringContaining('# kaizen-loop dependency repair: retrying verification command')
      }
    ]);
    expect(results[0].output).toContain("Cannot find module '@rollup/rollup-darwin-x64'");
    expect(results[0].output).toContain('installed');
    expect(results[0].output).toContain('ok');
    expect(runner.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'pnpm test',
      'pnpm install --frozen-lockfile',
      'pnpm test'
    ]);
  });

  it('does not retry verification when dependency repair setup fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    let verifyAttempts = 0;
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      const shellCommand = args.at(-1);
      if (shellCommand === 'pnpm test') {
        verifyAttempts += 1;
        return {
          command,
          args,
          cwd: options?.cwd,
          exitCode: 1,
          stdout: '',
          stderr: [
            "Error: Cannot find module '@rollup/rollup-darwin-x64'",
            'npm has a bug related to optional dependencies'
          ].join('\n'),
          durationMs: 1
        };
      }
      return {
        command,
        args,
        cwd: options?.cwd,
        exitCode: 1,
        stdout: '',
        stderr: 'install failed\n',
        durationMs: 1
      };
    });
    const workspace = new WorkspaceManager(runner, workspacePath, 'https://github.com/o/r.git');
    const config = configSchema.parse({
      version: 1,
      commands: {
        setup: 'pnpm install --frozen-lockfile',
        verify: ['pnpm test'],
        verifyTimeoutMinutes: 15
      }
    });

    const results = await workspace.runVerify(config);

    expect(results[0].ok).toBe(false);
    expect(results[0].output).toContain("Cannot find module '@rollup/rollup-darwin-x64'");
    expect(results[0].output).toContain('install failed');
    expect(results[0].output).not.toContain('retrying verification command');
    expect(verifyAttempts).toBe(1);
    expect(runner.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'pnpm test',
      'pnpm install --frozen-lockfile'
    ]);
  });

  it('does not run setup for ordinary verification failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 1,
      stdout: '',
      stderr: 'AssertionError: expected true to be false\n',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath, 'https://github.com/o/r.git');
    const config = configSchema.parse({
      version: 1,
      commands: {
        setup: 'pnpm install --frozen-lockfile',
        verify: ['pnpm test'],
        verifyTimeoutMinutes: 15
      }
    });

    const results = await workspace.runVerify(config);

    expect(results).toEqual([
      {
        command: 'pnpm test',
        ok: false,
        output: 'AssertionError: expected true to be false\n'
      }
    ]);
    expect(runner).toHaveBeenCalledOnce();
  });
});
