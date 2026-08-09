import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { VerifierAgentAdapter } from '../src/agents/verifier.js';
import { createInitialConfig } from '../src/init/init.js';
import { preflightVerifier } from '../src/orchestrator/run.js';
import type { KaizenConfig } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';

const oldCommit = 'a'.repeat(40);
const currentCommit = 'b'.repeat(40);
const tagObject = 'c'.repeat(40);
const execFileAsync = promisify(execFile);

describe('verifier freshness preflight', () => {
  it('rejects a self-consistent verifier checkout that is behind the trusted branch', async () => {
    const { failure, diagnostic } = await inspect({ expectedCommit: currentCommit, buildCommit: oldCommit, runtimeCommit: oldCommit });

    expect(failure).toContain(`obsolete build (expected ${currentCommit}`);
    expect(diagnostic).toMatchObject({
      protocol: 'structured',
      status: 'current',
      stale: false,
      freshness: {
        repository: 'https://github.com/kaizen-agents-org/verifier.git',
        ref: 'refs/heads/main',
        expectedCommit: currentCommit,
        observedBuildCommit: oldCommit,
        observedRuntimeCommit: oldCommit,
        status: 'stale'
      }
    });
  });

  it('accepts only a clean build and runtime at the trusted branch commit', async () => {
    const { failure, diagnostic } = await inspect({ expectedCommit: currentCommit, buildCommit: currentCommit, runtimeCommit: currentCommit });

    expect(failure).toBeUndefined();
    expect(diagnostic.freshness).toMatchObject({ expectedCommit: currentCommit, status: 'current' });
  });

  it('accepts a clean pinned release at the peeled tag commit', async () => {
    const expectedRef = 'refs/tags/v0.1.0';
    const { failure, diagnostic, runner } = await inspect({
      expectedRef,
      expectedCommit: oldCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit
    });

    expect(failure).toBeUndefined();
    expect(diagnostic.freshness).toMatchObject({
      ref: expectedRef,
      expectedCommit: oldCommit,
      status: 'current'
    });
    expect(runner).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--exit-code', 'https://github.com/kaizen-agents-org/verifier.git', expectedRef, `${expectedRef}^{}`],
      expect.any(Object)
    );
  });

  it('accepts a clean pinned release at a lightweight tag commit', async () => {
    const expectedRef = 'refs/tags/v0.1.0';
    const { failure, diagnostic } = await inspect({
      expectedRef,
      expectedCommit: oldCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      lightweightTag: true
    });

    expect(failure).toBeUndefined();
    expect(diagnostic.freshness).toMatchObject({ expectedCommit: oldCommit, status: 'current' });
  });

  it('keeps an installed pinned release current after upstream main advances', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-pinned-install-'));
    const stamp = path.join(home, 'toolchain', 'verifier', '.installed-version');
    await fs.mkdir(path.dirname(stamp), { recursive: true });
    await fs.writeFile(stamp, 'v0.1.0\n');
    const config = configSchema.parse(await createInitialConfig({
      agent: 'codex',
      setup: null,
      verify: []
    }, home));
    const remote = await createVerifierRemote();

    expect(remote.mainCommit).not.toBe(remote.releaseCommit);
    expect(config.verifier.expectedRef).toBe('refs/tags/v0.1.0');

    const { failure, diagnostic, runner } = await inspect({
      config,
      expectedCommit: remote.releaseCommit,
      buildCommit: remote.releaseCommit,
      runtimeCommit: remote.releaseCommit,
      localGitRemote: remote.repo
    });

    expect(failure).toBeUndefined();
    expect(diagnostic.freshness).toMatchObject({
      ref: 'refs/tags/v0.1.0',
      expectedCommit: remote.releaseCommit,
      status: 'current'
    });
    expect(runner.mock.calls.some(([command, args]) =>
      command === 'git' && args.includes('refs/heads/main'))).toBe(false);
  });

  it('rejects current main when a pinned release tag is expected', async () => {
    const { failure } = await inspect({
      expectedRef: 'refs/tags/v0.1.0',
      expectedCommit: oldCommit,
      buildCommit: currentCommit,
      runtimeCommit: currentCommit
    });

    expect(failure).toContain(`obsolete build (expected ${oldCommit}`);
  });

  it('rejects a dirty verifier at the pinned release tag commit', async () => {
    const { failure } = await inspect({
      expectedRef: 'refs/tags/v0.1.0',
      expectedCommit: oldCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      dirty: true
    });

    expect(failure).toContain('verifier build or runtime checkout is dirty');
  });

  it.each([
    { remoteOutput: `${oldCommit}\trefs/tags/v0.1.0^{}\n`, label: 'a peeled tag without its exact tag' },
    { remoteOutput: `${tagObject}\trefs/tags/v0.1.0\n${currentCommit}\trefs/tags/v0.1.0\n`, label: 'duplicate exact tag records' },
    { remoteOutput: `not-a-sha\trefs/tags/v0.1.0\n${oldCommit}\trefs/tags/v0.1.0^{}\n`, label: 'a malformed exact tag object' }
  ])('fails closed for $label', async ({ remoteOutput }) => {
    const { failure } = await inspect({
      expectedRef: 'refs/tags/v0.1.0',
      expectedCommit: oldCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      remoteOutput
    });

    expect(failure).toContain('did not resolve to one exact 40-character commit');
  });

  it('fails closed when the trusted branch cannot be resolved', async () => {
    const { failure, diagnostic } = await inspect({ expectedCommit: null, buildCommit: currentCommit, runtimeCommit: currentCommit });

    expect(failure).toContain('Could not resolve trusted verifier revision');
    expect(diagnostic).toMatchObject({
      protocol: 'unavailable',
      freshness: { expectedCommit: null, status: 'unverifiable' }
    });
  });

  it('fails closed for legacy verifier output even when the trusted branch resolves', async () => {
    const { failure, diagnostic } = await inspect({ expectedCommit: currentCommit, legacy: true });

    expect(failure).toContain('does not provide structured build provenance');
    expect(diagnostic).toMatchObject({ protocol: 'legacy', freshness: { expectedCommit: currentCommit, status: 'stale' } });
  });

  it('refreshes an obsolete Verifier exactly once for opted-in dogfood', async () => {
    const { failure, diagnostic, runner, globalLink } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true
    });

    expect(failure).toBeUndefined();
    expect(diagnostic).toMatchObject({
      freshness: { expectedCommit: currentCommit, status: 'current' },
      recovery: { attempted: true, status: 'recovered' }
    });
    expect(runner.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'clone')).toHaveLength(1);
    expect((await fs.stat(path.join(globalLink, 'dist', 'cli.js'))).mode & 0o111).not.toBe(0);
  });

  it('keeps pinned runtimes fail-closed without attempting an update', async () => {
    const { failure, runner } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit
    });

    expect(failure).toContain('obsolete build');
    expect(runner.mock.calls.some(([command]) => command === 'pnpm' || command === 'npm')).toBe(false);
  });

  it('reports refresh failure and leaves the existing link untouched', async () => {
    const { failure, diagnostic, globalLink, previousPackageRoot } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true,
      refreshFails: true
    });

    expect(failure).toContain('canonical-main refresh failed');
    expect(diagnostic.recovery).toMatchObject({ attempted: true, status: 'failed' });
    expect(await fs.realpath(globalLink)).toBe(previousPackageRoot);
  });

  it('removes a partial managed build when installation or build fails', async () => {
    const { failure, globalLink, previousPackageRoot, home } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true,
      buildFails: true
    });

    expect(failure).toContain('canonical-main refresh failed');
    expect(await fs.realpath(globalLink)).toBe(previousPackageRoot);
    const buildsRoot = path.join(home, 'toolchain', 'verifier-builds');
    expect(await fs.readdir(buildsRoot)).toEqual([]);
  });

  it('does not auto-update a legacy runtime without a rollback package root', async () => {
    const { failure, runner } = await inspect({
      expectedCommit: currentCommit,
      legacy: true,
      canonicalMainUpdate: true
    });

    expect(failure).toContain('does not provide structured build provenance');
    expect(runner.mock.calls.some(([command]) => command === 'pnpm' || command === 'npm')).toBe(false);
  });

  it('reports a rollback failure without claiming the previous runtime was restored', async () => {
    const { failure, diagnostic } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true,
      invalidAfterRefresh: true,
      rollbackFails: true
    });

    expect(failure).toContain('rollback failed');
    expect(diagnostic.recovery).toMatchObject({ attempted: true, status: 'rollback-failed' });
  });

  it('restores the previous link when refreshed provenance is invalid', async () => {
    const { failure, diagnostic, globalLink, previousPackageRoot } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true,
      invalidAfterRefresh: true
    });

    expect(failure).toContain('restored the previous Verifier link');
    expect(diagnostic.recovery).toMatchObject({ attempted: true, status: 'rolled-back' });
    expect(await fs.realpath(globalLink)).toBe(previousPackageRoot);
  });

  it('restores the previous link when post-refresh inspection throws', async () => {
    const { failure, diagnostic, globalLink, previousPackageRoot } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true,
      postRefreshInspectionFails: true
    });

    expect(failure).toContain('post-refresh runtime inspection failed');
    expect(failure).toContain('restored the previous Verifier link');
    expect(diagnostic.recovery).toMatchObject({ attempted: true, status: 'rolled-back' });
    expect(await fs.realpath(globalLink)).toBe(previousPackageRoot);
  });

  it('holds the shared refresh lock through inspection and the rollback decision', async () => {
    const { failure, refreshLockObservations } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true,
      invalidAfterRefresh: true,
      observeRefreshLock: true
    });

    expect(failure).toContain('restored the previous Verifier link');
    expect(refreshLockObservations).toEqual([true, true]);
  });

  it('runs the validated package artifact after the global link changes', async () => {
    const { failure, config, runner, globalLink, home, runDir, executedVerifierCommands } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true
    });
    expect(failure).toBeUndefined();
    const validatedCommand = config.verifier.command;
    const competingPackageRoot = path.join(home!, 'competing-verifier', 'packages', 'core');
    await fs.mkdir(path.join(competingPackageRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(competingPackageRoot, 'dist', 'cli.js'), '');
    const temporaryLink = `${globalLink}.competing`;
    await fs.symlink(competingPackageRoot, temporaryLink, 'dir');
    await fs.rename(temporaryLink, globalLink);

    const result = await new VerifierAgentAdapter(runner, {
      ...config.verifier,
      envAllowlist: config.safety.envAllowlist
    }).run({ workspaceDir: runDir, prompt: 'verify' });

    expect(result.status).toBe('open_pr');
    expect(validatedCommand).toMatch(/\/toolchain\/verifier-builds\/.+\/packages\/core\/dist\/cli\.js$/);
    expect(executedVerifierCommands).toEqual([validatedCommand]);
    expect(validatedCommand).not.toContain(competingPackageRoot);
  });

  it('fails closed when another process holds the shared refresh lock', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-home-'));
    const globalRoot = path.join(home, 'global', 'node_modules');
    await fs.mkdir(path.join(globalRoot, '@verifier', '.kaizen-update-lock'), { recursive: true });
    await fs.writeFile(
      path.join(globalRoot, '@verifier', '.kaizen-update-lock', 'run.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    const { failure } = await inspect({
      expectedCommit: currentCommit,
      buildCommit: oldCommit,
      runtimeCommit: oldCommit,
      canonicalMainUpdate: true,
      home,
      globalRoot
    });

    expect(failure).toContain('canonical-main refresh failed');
    expect(failure).toContain('already active');
  });
});

async function inspect(options: {
  expectedCommit: string | null;
  config?: KaizenConfig;
  expectedRef?: string;
  buildCommit?: string;
  runtimeCommit?: string;
  legacy?: boolean;
  dirty?: boolean;
  lightweightTag?: boolean;
  remoteOutput?: string;
  canonicalMainUpdate?: boolean;
  refreshFails?: boolean;
  buildFails?: boolean;
  invalidAfterRefresh?: boolean;
  rollbackFails?: boolean;
  postRefreshInspectionFails?: boolean;
  observeRefreshLock?: boolean;
  home?: string;
  globalRoot?: string;
  localGitRemote?: string;
}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-preflight-'));
  const previousHome = process.env.KAIZEN_HOME;
  process.env.KAIZEN_HOME = options.home ?? await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-home-'));
  const globalRoot = options.globalRoot ?? path.join(process.env.KAIZEN_HOME, 'global', 'node_modules');
  const previousPackageRoot = path.join(process.env.KAIZEN_HOME, 'previous-verifier', 'packages', 'core');
  const globalLink = path.join(globalRoot, '@verifier', 'core');
  await fs.mkdir(path.join(previousPackageRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(previousPackageRoot, 'dist', 'cli.js'), '');
  await fs.chmod(path.join(previousPackageRoot, 'dist', 'cli.js'), 0o755);
  const previousPackageRootReal = await fs.realpath(previousPackageRoot);
  await fs.mkdir(path.dirname(globalLink), { recursive: true });
  try {
    await fs.lstat(globalLink);
  } catch {
    await fs.symlink(previousPackageRoot, globalLink, 'dir');
  }
  const config = options.config ?? configSchema.parse({
    version: 1,
    ...(options.canonicalMainUpdate ? {
      safety: { operationMode: 'dogfood' },
      verifier: { update: { mode: 'canonical-main' } }
    } : options.expectedRef ? {
      verifier: { expectedRef: options.expectedRef }
    } : {})
  });
  let refreshed = false;
  let verifierCommandCalls = 0;
  const refreshLockObservations: boolean[] = [];
  const executedVerifierCommands: string[] = [];
  const runner = vi.fn<CommandRunner>(async (command, args, commandOptions) => {
    if (command === 'git') {
      if (args[0] === 'clone') {
        if (options.refreshFails) throw new Error('clone failed');
        await fs.mkdir(args.at(-1)!, { recursive: true });
        return result(command, args, commandOptions?.cwd, '');
      }
      if (args[0] === 'checkout') return result(command, args, commandOptions?.cwd, '');
      if (args.join(' ') === 'rev-parse HEAD') return result(command, args, commandOptions?.cwd, `${currentCommit}\n`);
      if (args[0] === 'ls-remote' && options.localGitRemote) {
        const localArgs = [...args];
        localArgs[2] = options.localGitRemote;
        const remote = await execFileAsync('git', localArgs, { cwd: commandOptions?.cwd });
        return result(command, args, commandOptions?.cwd, remote.stdout);
      }
      const expectedRef = config.verifier.expectedRef;
      return {
        command,
        args,
        cwd: commandOptions?.cwd,
        exitCode: options.expectedCommit ? 0 : 2,
        stdout: options.remoteOutput ?? (options.expectedCommit
          ? options.expectedRef?.startsWith('refs/tags/')
            ? options.lightweightTag
              ? `${options.expectedCommit}\t${expectedRef}\n`
              : `${tagObject}\t${expectedRef}\n${options.expectedCommit}\t${expectedRef}^{}\n`
            : `${options.expectedCommit}\t${expectedRef}\n`
          : ''),
        stderr: options.expectedCommit ? '' : 'remote unavailable',
        durationMs: 1
      };
    }
    if (command === 'pnpm') {
      if (args.join(' ') === 'build') {
        const dist = path.join(commandOptions!.cwd!, 'packages', 'core', 'dist');
        await fs.mkdir(dist, { recursive: true });
        await fs.writeFile(path.join(dist, 'cli.js'), '');
        if (options.buildFails) throw new Error('build failed');
      }
      return result(command, args, commandOptions?.cwd, '');
    }
    if (command === 'npm' && args.join(' ') === 'root -g') {
      return result(command, args, commandOptions?.cwd, `${globalRoot}\n`);
    }
    if (args.length === 0) {
      executedVerifierCommands.push(command);
      await fs.writeFile(commandOptions!.env!.KAIZEN_VERIFIER_RESULT_PATH!, JSON.stringify({
        status: 'open_pr',
        summary: 'validated runtime executed',
        notes: '',
        evidence_grade: 'executed'
      }));
      return result(command, args, commandOptions?.cwd, '');
    }
    const currentPackageRoot = await fs.realpath(globalLink);
    refreshed = currentPackageRoot !== previousPackageRootReal;
    verifierCommandCalls += 1;
    if (verifierCommandCalls > 1 && options.observeRefreshLock) {
      try {
        await fs.access(path.join(globalRoot, '@verifier', '.kaizen-update-lock', 'run.lock'));
        refreshLockObservations.push(true);
      } catch {
        refreshLockObservations.push(false);
      }
    }
    if (refreshed && options.rollbackFails) {
      await fs.rm(previousPackageRootReal, { recursive: true, force: true });
    }
    if (refreshed && options.postRefreshInspectionFails) {
      throw new Error('refreshed verifier failed to start');
    }
    return {
      command,
      args,
      cwd: commandOptions?.cwd,
      exitCode: 0,
      stdout: options.legacy ? 'verifier 0.0.0\n' : JSON.stringify({
        name: 'verifier',
        version: '0.0.0',
        status: options.buildCommit === options.runtimeCommit ? 'current' : 'stale',
        stale: options.buildCommit === options.runtimeCommit ? false : true,
        build: { commit: refreshed && !options.invalidAfterRefresh ? currentCommit : options.buildCommit, builtAt: '2026-08-03T00:00:00.000Z', dirty: options.dirty ?? false },
        runtime: { commit: refreshed && !options.invalidAfterRefresh ? currentCommit : options.runtimeCommit, dirty: options.dirty ?? false, packageRoot: currentPackageRoot }
      }),
      stderr: '',
      durationMs: 1
    };
  });
  try {
    const failure = await preflightVerifier({ config, runCommand: runner, runDir });
    const diagnostic = JSON.parse(await fs.readFile(path.join(runDir, 'verifier-runtime.json'), 'utf8'));
    return {
      failure,
      diagnostic,
      runner,
      globalLink,
      previousPackageRoot: previousPackageRootReal,
      home: process.env.KAIZEN_HOME,
      runDir,
      config,
      refreshLockObservations,
      executedVerifierCommands
    };
  } finally {
    if (previousHome === undefined) delete process.env.KAIZEN_HOME;
    else process.env.KAIZEN_HOME = previousHome;
  }
}

async function createVerifierRemote(): Promise<{
  repo: string;
  releaseCommit: string;
  mainCommit: string;
}> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-remote-'));
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: repo });
    return stdout.trim();
  };
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Kaizen Test');
  await git('config', 'user.email', 'kaizen-test@example.com');
  await fs.writeFile(path.join(repo, 'verifier.txt'), 'release\n');
  await git('add', 'verifier.txt');
  await git('commit', '-m', 'release');
  const releaseCommit = await git('rev-parse', 'HEAD');
  await git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  await fs.writeFile(path.join(repo, 'verifier.txt'), 'main advanced\n');
  await git('commit', '-am', 'advance main');
  const mainCommit = await git('rev-parse', 'HEAD');
  return { repo, releaseCommit, mainCommit };
}

function result(command: string, args: string[], cwd: string | undefined, stdout: string) {
  return { command, args, cwd, exitCode: 0, stdout, stderr: '', durationMs: 1 };
}
