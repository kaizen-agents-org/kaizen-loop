import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';
import { resolveKaizenTempDir } from '../src/utils/temp.js';
import { GitClient } from '../src/workspace/git.js';
import { CheckpointBranchDivergedError, CheckpointBranchMissingError, WorkspaceManager } from '../src/workspace/manager.js';
import { trustedRunner } from './helpers/trustedRunner.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('workspace branch handling', () => {
  afterEach(() => vi.unstubAllEnvs());

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

  it('fingerprints content changes when file names and line counts stay the same', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
    await fs.writeFile(path.join(workspacePath, 'package-lock.json'), 'version-one\n');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: 0,
      stdout: args.join(' ') === 'diff --name-only origin/main...HEAD'
        ? 'package-lock.json\n'
        : args.join(' ') === 'diff --numstat origin/main...HEAD'
          ? '1\t1\tpackage-lock.json\n'
          : '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath);
    const config = configSchema.parse({ version: 1 });

    const before = await workspace.checkpointFingerprint(config);
    await fs.writeFile(path.join(workspacePath, 'package-lock.json'), 'version-two\n');
    const after = await workspace.checkpointFingerprint(config);

    expect(after).not.toBe(before);
    await fs.truncate(path.join(workspacePath, 'package-lock.json'), 65 * 1024 * 1024);
    await expect(workspace.checkpointFingerprint(config)).rejects.toThrow('Checkpoint fingerprint exceeds');
  });

  it('can force-with-lease when pushing regenerated issue branches', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
        ? 'https://github.com/o/r.git\n'
        : args[0] === 'rev-parse' && args[1] === '--verify'
          ? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n'
          : '',
      stderr: '',
      durationMs: 1
    }));
    const git = new GitClient(trustedRunner(runner), '/workspace');

    await git.push('kaizen/issue-12-retry-branch', { forceWithLease: true, expectedRepo: 'o/r' });

    const push = runner.mock.calls.find(([, args]) => args[0] === 'push');
    expect(push?.[1]).toEqual([
      'push',
      '--no-verify',
      '--force-with-lease=refs/heads/kaizen/issue-12-retry-branch:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'https://github.com/o/r.git',
      'kaizen/issue-12-retry-branch:refs/heads/kaizen/issue-12-retry-branch'
    ]);
  });

  it('uses supervisor GitHub credentials only for publication pushes', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    vi.stubEnv('SSH_AUTH_SOCK', '/supervisor-agent');
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin' ? 'https://github.com/o/r.git\n' : '',
      stderr: '',
      durationMs: 1
    }));
    const git = new GitClient(trustedRunner(runner), '/workspace');

    await git.statusPorcelain();
    await git.push('kaizen/issue-330-fix', { forceWithLease: true, expectedRepo: 'o/r' });

    expect(runner.mock.calls[0][2]?.env?.GH_TOKEN).toBeUndefined();
    const publicationValidation = runner.mock.calls.find(([, args]) => args[0] === 'remote' && args[1] === 'get-url');
    expect(publicationValidation?.[0]).toBe('git');
    expect(publicationValidation?.[2]?.env?.SSH_AUTH_SOCK).toBeUndefined();
    expect(publicationValidation?.[2]?.env).toMatchObject({
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    });
    const publicationPush = runner.mock.calls.find(([, args]) => args[0] === 'push');
    expect(publicationPush?.[1].join(' ')).not.toContain('supervisor-token');
    expect(publicationPush?.[2]?.cwd).not.toBe('/workspace');
    expect(publicationPush?.[2]?.env).toMatchObject({
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '!f() { test "$1" = get || exit 0; printf "%s\\n" username=x-access-token "password=$KAIZEN_GIT_PASSWORD"; }; f',
      KAIZEN_GIT_PASSWORD: 'supervisor-token'
    });
    expect(publicationPush?.[2]?.env?.GH_TOKEN).toBeUndefined();
    expect(publicationPush?.[0]).toBe('git');
  });

  it('delegates HTTPS publication to the trusted broker only after validation', async () => {
    const events: string[] = [];
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      events.push(args[0] ?? command);
      return {
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
          ? 'https://github.com/o/r.git\n'
          : args[0] === 'rev-parse'
            ? 'deadbeef\n'
            : '',
      stderr: '',
      durationMs: 1
      };
    });
    const publisher = vi.fn(async () => {
      events.push('github-publisher');
    });

    await new GitClient(trustedRunner(runner, { githubToken: false, githubPublisher: publisher }), '/workspace')
      .push('kaizen/issue-330-fix', { expectedRepo: 'o/r' });

    const brokerIndex = events.indexOf('github-publisher');
    const cloneIndex = events.indexOf('clone');
    const inspectionIndex = events.indexOf('grep');
    expect(brokerIndex).toBeGreaterThan(cloneIndex);
    expect(brokerIndex).toBeGreaterThan(inspectionIndex);
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({
      pushUrl: 'https://github.com/o/r.git',
      refspec: 'kaizen/issue-330-fix:refs/heads/kaizen/issue-330-fix',
      expectedRepo: 'o/r',
      expectedSha: 'deadbeef'
    }));
    expect(runner.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
    expect(runner.mock.calls.some(([, , options]) => options?.env?.KAIZEN_GIT_PASSWORD)).toBe(false);
  });

  it('sanitizes broker publication failures', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
          ? 'https://github.com/o/r.git\n'
          : '',
      stderr: '',
      durationMs: 1
    }));

    const error = await new GitClient(trustedRunner(runner, {
      githubToken: false,
      githubPublisher: async () => { throw new Error('secret broker detail'); }
    }), '/workspace')
      .push('kaizen/issue-330-fix', { expectedRepo: 'o/r' })
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain('credential broker failed');
    expect(String(error)).not.toContain('secret broker detail');
    expect(runner.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });

  // Suppressing the message entirely made a named refusal indistinguishable
  // from any other failure, so a known refusal code is surfaced -- while the
  // surrounding text it arrived in stays suppressed.
  it('surfaces a known broker refusal code without the message around it', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
          ? 'https://github.com/o/r.git\n'
          : '',
      stderr: '',
      durationMs: 1
    }));

    const error = await new GitClient(trustedRunner(runner, {
      githubToken: false,
      githubPublisher: async () => {
        throw new Error('broker refused the request: repository-not-allowed (token ghp_aaaaaaaaaaaaaaaaaaaa)');
      }
    }), '/workspace')
      .push('kaizen/issue-330-fix', { expectedRepo: 'o/r' })
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain('repository-not-allowed');
    expect(String(error)).not.toContain('ghp_');
    expect(runner.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });

  it('does not expose GitHub tokens to SSH publication transports', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    vi.stubEnv('SSH_AUTH_SOCK', '/supervisor-agent');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
        ? 'git@github.com:o/r.git\n'
        : args[0] === 'rev-parse'
          ? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n'
          : '',
      stderr: '',
      durationMs: 1
    }));

    await new GitClient(trustedRunner(runner), '/workspace').push('kaizen/issue-330-fix', { expectedRepo: 'o/r' });

    const publicationClone = runner.mock.calls.find(([, args]) => args[0] === 'clone');
    expect(publicationClone?.[2]?.env).toMatchObject({
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    });
    expect(publicationClone?.[2]?.env?.SSH_AUTH_SOCK).toBeUndefined();
    const publicationPush = runner.mock.calls.find(([, args]) => args[0] === 'push');
    expect(publicationPush?.[2]?.env).toMatchObject({
      SSH_AUTH_SOCK: '/supervisor-agent',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    });
    expect(publicationPush?.[2]?.env?.GIT_SSH_COMMAND).toMatch(
      new RegExp(`ssh(?:\\.exe)?' -F '${process.platform === 'win32' ? 'NUL' : '/dev/null'}'$`, 'i')
    );
    expect(publicationPush?.[2]?.env?.GH_TOKEN).toBeUndefined();
    expect(publicationPush?.[0]).toBe('git');
    const updateRef = runner.mock.calls.find(([, args]) => args.includes('update-ref'));
    expect(updateRef?.[1]).toEqual([
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      'update-ref',
      'refs/remotes/origin/kaizen/issue-330-fix',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    ]);
    expect(updateRef?.[2]?.env?.SSH_AUTH_SOCK).toBeUndefined();
    expect(updateRef?.[2]?.env).toMatchObject({
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    });
  });

  it('refuses publication through unsupported origins', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'ext::malicious-command\n',
      stderr: '',
      durationMs: 1
    }));

    await expect(new GitClient(trustedRunner(runner), '/workspace').push('main', { expectedRepo: 'o/r' })).rejects.toThrow('Refusing to publish');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('refuses a valid GitHub push URL for a different repository', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'https://github.com/o/other.git\n',
      stderr: '',
      durationMs: 1
    }));

    await expect(new GitClient(trustedRunner(runner), '/workspace').push('main', { expectedRepo: 'o/r' }))
      .rejects.toThrow('Refusing to publish o/r');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('refuses to publish Git LFS pointers without a trusted object upload', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
        ? 'https://github.com/o/r.git\n'
        : args[0] === 'grep'
          ? 'kaizen/issue-330-fix:assets/model.bin\n'
          : args[0] === 'show'
            ? `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123\n`
          : '',
      stderr: '',
      durationMs: 1
    }));

    await expect(new GitClient(trustedRunner(runner), '/workspace').push('kaizen/issue-330-fix', {
      expectedRepo: 'o/r'
    })).rejects.toThrow('Git LFS pointer');
    expect(runner.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });

  it('refuses to publish valid Git LFS pointers with extensions', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command, args, cwd: '/workspace', exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
        ? 'https://github.com/o/r.git\n'
        : args[0] === 'grep'
          ? 'kaizen/issue-330-fix:assets/model.bin\n'
          : args[0] === 'show'
            ? `version https://git-lfs.github.com/spec/v1\next-0-example payload\noid sha256:${'a'.repeat(64)}\nsize 123\n`
            : '',
      stderr: '', durationMs: 1
    }));

    await expect(new GitClient(trustedRunner(runner), '/workspace').push('kaizen/issue-330-fix', {
      expectedRepo: 'o/r'
    })).rejects.toThrow('Git LFS pointer');
    expect(runner.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });

  it('publishes ordinary files that only mention the LFS specification version', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin'
        ? 'https://github.com/o/r.git\n'
        : args[0] === 'grep'
          ? 'kaizen/issue-330-fix:docs/lfs.md\n'
          : args[0] === 'show'
            ? 'version https://git-lfs.github.com/spec/v1\nThis is documentation, not a pointer.\n'
            : args[0] === 'rev-parse'
              ? 'abc123\n'
              : '',
      stderr: '',
      durationMs: 1
    }));

    await new GitClient(trustedRunner(runner), '/workspace').push('kaizen/issue-330-fix', {
      expectedRepo: 'o/r'
    });

    expect(runner.mock.calls.some(([, args]) => args[0] === 'push')).toBe(true);
  });

  it('refuses to publish when Git LFS inspection fails', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: args[0] === 'grep' ? 2 : 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin' ? 'https://github.com/o/r.git\n' : '',
      stderr: '',
      durationMs: 1
    }));

    await expect(new GitClient(trustedRunner(runner), '/workspace').push('kaizen/issue-330-fix', {
      expectedRepo: 'o/r'
    })).rejects.toThrow('Could not inspect');
    expect(runner.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  });

  it('preserves a publication failure when temporary cleanup also fails', async () => {
    vi.stubEnv('GH_TOKEN', 'supervisor-token');
    const cleanupError = new Error('cleanup failed');
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(cleanupError);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: args[0] === 'grep' ? 2 : 0,
      stdout: args.join(' ') === 'remote get-url --push --all origin' ? 'https://github.com/o/r.git\n' : '',
      stderr: '',
      durationMs: 1
    }));

    const error = await new GitClient(trustedRunner(runner), '/workspace').push('kaizen/issue-330-fix', {
      expectedRepo: 'o/r'
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: expect.stringContaining('Could not inspect'),
      cause: cleanupError
    });
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
    const git = new GitClient(trustedRunner(runner), '/workspace');

    await git.checkout('main', { ignoreOtherWorktrees: true });

    expect(runner.mock.calls[0][1]).toEqual(['checkout', '--ignore-other-worktrees', 'main']);
  });

  it('removes stale worktrees and resumes the existing issue branch', async () => {
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

    const worktree = await workspace.createIssueWorktree(config, { number: 12, title: 'Retry branch' }, 'new-run', { resume: true });

    expect(worktree).toEqual({
      branch: 'kaizen/issue-12-retry-branch',
      path: path.join(root, 'workspace-worktrees', 'new-run', 'issue-12'),
      resumed: true
    });
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain(`worktree remove --force ${oldWorktreePath}`);
    expect(gitCommands).toContain(
      `worktree add ${path.join(root, 'workspace-worktrees', 'new-run', 'issue-12')} kaizen/issue-12-retry-branch`
    );
  });

  it('creates a fresh issue branch from the default branch when no checkpoint branch exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: args[0] === 'show-ref' ? 1 : 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath, 'https://github.com/o/r.git');
    const config = configSchema.parse({ version: 1 });

    const worktree = await workspace.createIssueWorktree(config, { number: 12, title: 'Fresh branch' }, 'new-run');

    expect(worktree.resumed).toBe(false);
    expect(runner.mock.calls.map(([, args]) => args.join(' '))).toContain(
      `worktree add -B kaizen/issue-12-fresh-branch ${path.join(root, 'workspace-worktrees', 'new-run', 'issue-12')} origin/main`
    );
  });

  it('resumes the checkpoint branch even when the issue title changed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath);
    const config = configSchema.parse({ version: 1 });

    const worktree = await workspace.createIssueWorktree(config, { number: 12, title: 'Edited title' }, 'new-run', {
      branch: 'kaizen/issue-12-original-title',
      resume: true
    });

    expect(worktree.branch).toBe('kaizen/issue-12-original-title');
    expect(runner.mock.calls.map(([, args]) => args.join(' '))).toContain(
      `worktree add ${path.join(root, 'workspace-worktrees', 'new-run', 'issue-12')} kaizen/issue-12-original-title`
    );
  });

  it('recreates a missing local checkpoint branch from the pushed remote branch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: args.includes('refs/heads/kaizen/issue-12-resume') ? 1 : 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath);
    const config = configSchema.parse({ version: 1 });

    const worktree = await workspace.createIssueWorktree(config, { number: 12, title: 'Resume' }, 'new-run', { resume: true });

    expect(worktree.resumed).toBe(true);
    expect(runner.mock.calls.map(([, args]) => args.join(' '))).toContain(
      `worktree add -B kaizen/issue-12-resume ${path.join(root, 'workspace-worktrees', 'new-run', 'issue-12')} origin/kaizen/issue-12-resume`
    );
  });

  it('fails recovery when an active checkpoint branch is missing locally and remotely', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: args[0] === 'show-ref' ? 1 : 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath);
    const config = configSchema.parse({ version: 1 });

    await expect(
      workspace.createIssueWorktree(config, { number: 12, title: 'Missing checkpoint' }, 'new-run', { resume: true })
    ).rejects.toBeInstanceOf(CheckpointBranchMissingError);

    expect(runner.mock.calls.map(([, args]) => args.join(' '))).not.toContain(
      `worktree add -B kaizen/issue-12-missing-checkpoint ${path.join(root, 'workspace-worktrees', 'new-run', 'issue-12')} origin/main`
    );
  });

  it('fast-forwards a stale local checkpoint branch to origin before resuming', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: 0,
      stdout: args[0] === 'rev-list' ? '1\t0\n' : '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath);
    const config = configSchema.parse({ version: 1 });

    await workspace.createIssueWorktree(config, { number: 12, title: 'Resume' }, 'new-run', { resume: true });

    expect(runner.mock.calls.map(([, args]) => args.join(' '))).toContain(
      'branch -f kaizen/issue-12-resume origin/kaizen/issue-12-resume'
    );
  });

  it('stops recovery when local and remote checkpoint branches diverged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: workspacePath,
      exitCode: 0,
      stdout: args[0] === 'rev-list' ? '1\t1\n' : '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, workspacePath);
    const config = configSchema.parse({ version: 1 });

    await expect(
      workspace.createIssueWorktree(config, { number: 12, title: 'Resume' }, 'new-run', { resume: true })
    ).rejects.toBeInstanceOf(CheckpointBranchDivergedError);
  });

  it('discards forbidden changes back to a remote checkpoint when available', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, '/workspace');

    await expect(workspace.discardIssueChanges('kaizen/issue-12-resume', 'main')).resolves.toEqual({ restoredCheckpoint: true });
    expect(runner.mock.calls.map(([, args]) => args.join(' '))).toEqual([
      'show-ref --verify --quiet refs/remotes/origin/kaizen/issue-12-resume',
      'reset --hard origin/kaizen/issue-12-resume',
      'clean -fdx'
    ]);
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
    const git = new GitClient(trustedRunner(runner), '/workspace');

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

  it('detects uncommitted and untracked forbidden files before checkpointing', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: args.join(' ') === 'status --porcelain' ? ' M src/file.ts\n?? .env\n' : '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, '/workspace');
    const config = configSchema.parse({ version: 1, policy: { forbiddenPaths: ['.env'] } });

    const diff = await workspace.collectCheckpointDiffStats(config);

    expect(diff.files).toEqual(['src/file.ts', '.env']);
    expect(diff.forbiddenFiles).toEqual(['.env']);
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

  it('repairs transient Rollup optional dependency failures without a TTY', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    vi.stubEnv('CI', 'baseline');
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
      if (options?.env?.CI !== 'true') {
        return {
          command,
          args,
          cwd: options?.cwd,
          exitCode: 1,
          stdout: '',
          stderr: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY\n',
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
      safety: { envAllowlist: ['PATH', 'CI'] },
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
    expect(runner.mock.calls[0][2]?.env?.CI).toBe('baseline');
    expect(runner.mock.calls[1][2]?.env?.CI).toBe('true');
    expect(runner.mock.calls[1][2]?.env?.PATH).toBe(process.env.PATH);
    expect(runner.mock.calls[2][2]?.env?.CI).toBe('baseline');
  });

  it('preserves verification and dependency repair rejection evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-test-'));
    const workspacePath = path.join(root, 'workspace');
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (args.at(-1) === 'pnpm test') {
        throw Object.assign(new Error('Command timed out after 1000ms'), {
          result: {
            command,
            args,
            cwd: options?.cwd,
            exitCode: 1,
            stdout: '',
            stderr: "Error: Cannot find module '@rollup/rollup-darwin-x64'\n",
            durationMs: 1
          }
        });
      }
      throw new Error('spawn pnpm ENOENT');
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
    expect(results[0].output).toContain('Command timed out after 1000ms');
    expect(results[0].output).toContain('# kaizen-loop dependency repair: pnpm install --frozen-lockfile');
    expect(results[0].output).toContain('spawn pnpm ENOENT');
    expect(runner.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'pnpm test',
      'pnpm install --frozen-lockfile'
    ]);
  });

  it('returns spawn failures as verification evidence', async () => {
    const runner = vi.fn<CommandRunner>(async () => {
      throw new Error('spawn sh ENOENT');
    });
    const workspace = new WorkspaceManager(runner, '/workspace', 'https://github.com/o/r.git');
    const config = configSchema.parse({
      version: 1,
      commands: {
        setup: 'pnpm install --frozen-lockfile',
        verify: ['pnpm test']
      }
    });

    await expect(workspace.runVerify(config)).resolves.toEqual([
      {
        command: 'pnpm test',
        ok: false,
        output: 'spawn sh ENOENT'
      }
    ]);
    expect(runner).toHaveBeenCalledOnce();
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
    expect(runner.mock.calls[1][2]?.env?.CI).toBe('true');
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
