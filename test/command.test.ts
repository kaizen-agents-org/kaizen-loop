import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAllowlistedEnv,
  buildUntrustedEnv,
  executableNames,
  gitCliEnv,
  gitPublicationEnv,
  gitSshPublicationEnv,
  githubCliEnv,
  trustedGithubCliEnv,
  githubCliExecutable,
  isTrustedExecutablePath,
  isWindowsExecutablePathTrusted,
  isolatedGitEnv,
  publicationGitExecutable,
  runCommand,
  withRunDeadline,
  type CommandRunner
} from '../src/utils/command.js';

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

describe('buildUntrustedEnv', () => {
  it('removes supervisor credentials even when explicitly allowlisted or added', () => {
    expect(buildUntrustedEnv({
      PATH: '/bin',
      GH_TOKEN: 'publication-token',
      GITHUB_TOKEN: 'github-token',
      GH_CONFIG_DIR: '/supervisor-gh',
      SSH_AUTH_SOCK: '/supervisor-agent',
      gh_token: 'case-insensitive-publication-token',
      github_token: 'case-insensitive-github-token'
    }, ['PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'SSH_AUTH_SOCK', 'gh_token', 'github_token'], {
      github_enterprise_token: 'extra-token'
    })).toEqual({ PATH: '/bin' });
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

  it('removes startup tokens from the supervisor process environment while retaining privileged access', () => {
    const script = `
      process.argv.splice(1, 0, 'kaizen');
      const { gitPublicationEnv, githubCliEnv, hasSupervisorGitHubToken } = await import('./src/utils/command.ts');
      process.stdout.write(JSON.stringify({
        parentToken: process.env.GH_TOKEN,
        privilegedToken: githubCliEnv().GH_TOKEN,
        publicationToken: gitPublicationEnv().KAIZEN_GIT_PASSWORD,
        hasToken: hasSupervisorGitHubToken()
      }));
    `;
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, 'actions', 'publish'],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, GH_TOKEN: 'startup-token' },
        encoding: 'utf8'
      }
    );

    expect(JSON.parse(stdout)).toEqual({
      publicationToken: 'startup-token',
      hasToken: true
    });
  });

  it('restores startup authentication only for the trusted GitHub CLI boundary', () => {
    const script = `
      process.argv.splice(1, 0, 'kaizen');
      const { githubCliEnv, trustedGithubCliEnv } = await import('./src/utils/command.ts');
      process.stdout.write(JSON.stringify({
        ordinary: githubCliEnv().GH_TOKEN,
        trusted: trustedGithubCliEnv(process.env, '/trusted/bin/gh', '/trusted/bin/git').GH_TOKEN
      }));
    `;
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, 'actions', 'publish'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, GH_TOKEN: 'startup-token' },
      encoding: 'utf8'
    });

    expect(JSON.parse(stdout)).toEqual({ trusted: 'startup-token' });
  });

  it.each([
    ['run'],
    ['doctor'],
    ['run', '--project', 'init'],
    ['run', '--job', 'init']
  ])('rejects startup tokens in builder-capable processes: %s', (...args) => {
    const script = "process.argv.splice(1, 0, 'kaizen'); await import('./src/utils/command.ts')";
    expect(() => execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, '--', ...args],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, GH_TOKEN: 'startup-token' },
        encoding: 'utf8',
        stdio: 'pipe'
      }
    )).toThrow('Refusing to start a builder-capable Kaizen process');
  });

  it.each([
    ['init'],
    ['--json', 'init'],
    ['--project', 'owner-repo', 'actions', 'prepare'],
    ['actions', '--json', 'publish'],
    ['actions', '--project', 'owner-repo', 'publish'],
    ['actions', 'publish']
  ])('accepts startup tokens only for exact credential-only commands: %s', (...args) => {
    const script = "process.argv.splice(1, 0, 'kaizen'); await import('./src/utils/command.ts')";
    expect(() => execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, '--', ...args],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, GH_TOKEN: 'startup-token' },
        encoding: 'utf8',
        stdio: 'pipe'
      }
    )).not.toThrow();
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

describe('isolatedGitEnv', () => {
  it('disables inherited Git config and omits SSH authentication', () => {
    expect(isolatedGitEnv({
      PATH: '/bin',
      HOME: '/home/supervisor',
      SSH_AUTH_SOCK: '/ssh-agent'
    })).toEqual({
      PATH: '/bin',
      HOME: '/home/supervisor',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    });
  });
});

describe('gitPublicationEnv', () => {
  it('provides GitHub HTTPS auth through an inline helper without an external executable', () => {
    expect(gitPublicationEnv({
      PATH: '/bin',
      GH_TOKEN: 'gh-token',
      GH_CONFIG_DIR: '/gh-config',
      SECRET_TOKEN: 'secret'
    })).toEqual({
      PATH: '/bin',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '!f() { test "$1" = get || exit 0; printf "%s\\n" username=x-access-token "password=$KAIZEN_GIT_PASSWORD"; }; f',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      KAIZEN_GIT_PASSWORD: 'gh-token'
    });
  });

  it('falls back to GITHUB_TOKEN without requiring gh during publication', () => {
    expect(gitPublicationEnv({ GITHUB_TOKEN: 'github-token' }).KAIZEN_GIT_PASSWORD).toBe('github-token');
    expect(gitPublicationEnv({}, 'startup-token').KAIZEN_GIT_PASSWORD).toBe('startup-token');
    expect(() => gitPublicationEnv({}, '')).toThrow('GH_TOKEN or GITHUB_TOKEN');
  });
});

describe('executableNames', () => {
  it('honors PATHEXT when resolving Windows executables', () => {
    expect(executableNames('git', 'win32', '.COM;.EXE;.CMD')).toEqual([
      'git',
      'git.COM',
      'git.EXE',
      'git.CMD'
    ]);
  });

  it('rejects Windows executables with a writable ancestor inside a protected root', () => {
    const writable = new Set(['C:\\Program Files\\Git\\cmd']);

    expect(isWindowsExecutablePathTrusted(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      ['C:\\Program Files'],
      (candidate) => writable.has(candidate)
    )).toBe(false);
    expect(isWindowsExecutablePathTrusted(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      ['C:\\Program Files'],
      () => false
    )).toBe(true);
  });
});

describe('privileged executable resolution', () => {
  it('fails closed for unmarked command runners even under NODE_ENV=test', () => {
    const unmarkedRunner = vi.fn<CommandRunner>();
    expect(process.env.NODE_ENV).toBe('test');
    expect(githubCliExecutable(unmarkedRunner)).toBeUndefined();
    expect(publicationGitExecutable(unmarkedRunner)).toBeUndefined();
    expect(trustedGithubCliEnv(process.env, '/trusted/bin/gh', '/trusted/bin/git').PATH).toBe('/trusted/bin');
  });
});

describe.runIf(process.platform !== 'win32')('isTrustedExecutablePath', () => {
  it('rejects an executable owned by the supervisor user', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-user-owned-executable-'));
    const executable = path.join(root, 'gh');
    await fs.writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });

    expect(isTrustedExecutablePath(executable)).toBe(false);

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('gitSshPublicationEnv', () => {
  it('keeps GitHub tokens out and overrides repository-controlled SSH commands', () => {
    expect(gitSshPublicationEnv({
      PATH: '/bin',
      GH_TOKEN: 'gh-token',
      SSH_AUTH_SOCK: '/ssh-agent'
    }, '/trusted/ssh')).toEqual({
      PATH: '/bin',
      SSH_AUTH_SOCK: '/ssh-agent',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_SSH_COMMAND: `'/trusted/ssh' -F '${process.platform === 'win32' ? 'NUL' : '/dev/null'}'`
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

  it('waits for force-killed descendants before a successful command resolves', async () => {
    if (process.platform === 'win32') return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-command-'));
    const leakPath = path.join(dir, 'stubborn-leak');
    const descendant = [
      'process.on("SIGTERM", () => {});',
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(leakPath)}, "leaked"), 500);`,
      'setInterval(() => {}, 1000);'
    ].join('');

    await runCommand('sh', ['-lc', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(descendant)} >/dev/null 2>&1 &`]);

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
