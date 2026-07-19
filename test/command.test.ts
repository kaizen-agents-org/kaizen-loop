import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildAllowlistedEnv, gitCliEnv, githubCliEnv, runCommand, withRunDeadline, type CommandRunner } from '../src/utils/command.js';

describe('buildAllowlistedEnv', () => {
  it('copies only allowlisted variables plus explicit extras', () => {
    const env = buildAllowlistedEnv(
      {
        PATH: '/bin',
        SECRET_TOKEN: 'secret'
      },
      ['PATH'],
      {
        KAIZEN_WORKSPACE_DIR: '/workspace'
      }
    );

    expect(env).toEqual({
      PATH: '/bin',
      KAIZEN_WORKSPACE_DIR: '/workspace'
    });
  });
});

describe('githubCliEnv', () => {
  it('preserves GitHub CLI token auth without passing unrelated secrets', () => {
    const env = githubCliEnv({
      PATH: '/bin',
      GH_TOKEN: 'gh-token',
      GITHUB_TOKEN: 'github-token',
      GH_ENTERPRISE_TOKEN: 'enterprise-token',
      GITHUB_ENTERPRISE_TOKEN: 'github-enterprise-token',
      GH_CONFIG_DIR: '/gh-config',
      SSH_AUTH_SOCK: '/ssh-agent',
      SECRET_TOKEN: 'secret'
    });

    expect(env).toEqual({
      PATH: '/bin',
      GH_TOKEN: 'gh-token',
      GITHUB_TOKEN: 'github-token',
      GH_ENTERPRISE_TOKEN: 'enterprise-token',
      GITHUB_ENTERPRISE_TOKEN: 'github-enterprise-token',
      GH_CONFIG_DIR: '/gh-config'
    });
  });
});

describe('gitCliEnv', () => {
  it('preserves Git SSH auth only for git commands', () => {
    expect(gitCliEnv({
      PATH: '/bin',
      SSH_AUTH_SOCK: '/ssh-agent',
      GIT_SSH_COMMAND: 'ssh -i key',
      GH_TOKEN: 'do-not-pass'
    })).toEqual({
      PATH: '/bin',
      SSH_AUTH_SOCK: '/ssh-agent',
      GIT_SSH_COMMAND: 'ssh -i key'
    });
  });
});

describe('runCommand', () => {
  it('uses the default environment allowlist when no environment is supplied', async () => {
    const previousSecretToken = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = 'do-not-pass';
    try {
      const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.env.SECRET_TOKEN || "")']);
      expect(result.stdout).toBe('');
    } finally {
      if (previousSecretToken === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = previousSecretToken;
    }
  });

  it('terminates background child processes when a command times out', async () => {
    if (process.platform === 'win32') return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-command-'));
    const leakPath = path.join(dir, 'leaked');

    await expect(
      runCommand('sh', ['-lc', `(sleep 0.3; echo leaked > ${JSON.stringify(leakPath)}) & wait`], {
        timeoutMs: 50
      })
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(fs.access(leakPath)).rejects.toThrow();
  });

  it('terminates background descendants after a successful command exits', async () => {
    if (process.platform === 'win32') return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-command-'));
    const leakPath = path.join(dir, 'leaked-after-success');
    await runCommand('sh', ['-lc', `(sleep 0.3; echo leaked > ${JSON.stringify(leakPath)}) >/dev/null 2>&1 &`]);

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(fs.access(leakPath)).rejects.toThrow();
  });

  it('rejects when a timed-out command exits cleanly after SIGTERM', async () => {
    if (process.platform === 'win32') return;

    await expect(
      runCommand('sh', ['-lc', 'trap "exit 0" TERM; while true; do sleep 0.01; done'], {
        timeoutMs: 50
      })
    ).rejects.toThrow('Command timed out');
  });
});

describe('withRunDeadline', () => {
  it('bounds command timeouts by the remaining run deadline', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const deadlineRunner = withRunDeadline(runner, Date.now() + 1_000);

    await deadlineRunner('tool', [], { timeoutMs: 5_000 });

    expect(runner.mock.calls[0][2]?.timeoutMs).toBeGreaterThan(0);
    expect(runner.mock.calls[0][2]?.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it('applies the remaining run deadline when a command has no timeout', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const deadlineRunner = withRunDeadline(runner, Date.now() + 1_000);

    await deadlineRunner('tool', []);

    expect(runner.mock.calls[0][2]?.timeoutMs).toBeGreaterThan(0);
    expect(runner.mock.calls[0][2]?.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it('applies the remaining run deadline when a command has a non-positive timeout', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const deadlineRunner = withRunDeadline(runner, Date.now() + 1_000);

    await deadlineRunner('zero', [], { timeoutMs: 0 });
    await deadlineRunner('negative', [], { timeoutMs: -1 });

    expect(runner.mock.calls[0][2]?.timeoutMs).toBeGreaterThan(0);
    expect(runner.mock.calls[0][2]?.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(runner.mock.calls[1][2]?.timeoutMs).toBeGreaterThan(0);
    expect(runner.mock.calls[1][2]?.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it('rejects commands after the run deadline expires', async () => {
    const runner = vi.fn<CommandRunner>();
    const deadlineRunner = withRunDeadline(runner, Date.now() - 1);

    await expect(deadlineRunner('tool', [])).rejects.toThrow('Kaizen run timeout exceeded');
    expect(runner).not.toHaveBeenCalled();
  });
});
