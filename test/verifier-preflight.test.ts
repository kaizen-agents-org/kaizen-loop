import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { preflightVerifier } from '../src/orchestrator/run.js';
import type { CommandRunner } from '../src/utils/command.js';

const oldCommit = 'a'.repeat(40);
const currentCommit = 'b'.repeat(40);

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
  buildCommit?: string;
  runtimeCommit?: string;
  legacy?: boolean;
  canonicalMainUpdate?: boolean;
  refreshFails?: boolean;
  buildFails?: boolean;
  invalidAfterRefresh?: boolean;
  rollbackFails?: boolean;
  home?: string;
  globalRoot?: string;
}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-preflight-'));
  const previousHome = process.env.KAIZEN_HOME;
  process.env.KAIZEN_HOME = options.home ?? await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-home-'));
  const globalRoot = options.globalRoot ?? path.join(process.env.KAIZEN_HOME, 'global', 'node_modules');
  const previousPackageRoot = path.join(process.env.KAIZEN_HOME, 'previous-verifier', 'packages', 'core');
  const globalLink = path.join(globalRoot, '@verifier', 'core');
  await fs.mkdir(path.join(previousPackageRoot, 'dist'), { recursive: true });
  const previousPackageRootReal = await fs.realpath(previousPackageRoot);
  await fs.mkdir(path.dirname(globalLink), { recursive: true });
  try {
    await fs.lstat(globalLink);
  } catch {
    await fs.symlink(previousPackageRoot, globalLink, 'dir');
  }
  const config = configSchema.parse({
    version: 1,
    ...(options.canonicalMainUpdate ? {
      safety: { operationMode: 'dogfood' },
      verifier: { update: { mode: 'canonical-main' } }
    } : {})
  });
  let refreshed = false;
  let npmRootCalls = 0;
  const runner = vi.fn<CommandRunner>(async (command, args, commandOptions) => {
    if (command === 'git') {
      if (args[0] === 'clone') {
        if (options.refreshFails) throw new Error('clone failed');
        await fs.mkdir(args.at(-1)!, { recursive: true });
        return result(command, args, commandOptions?.cwd, '');
      }
      if (args[0] === 'checkout') return result(command, args, commandOptions?.cwd, '');
      if (args.join(' ') === 'rev-parse HEAD') return result(command, args, commandOptions?.cwd, `${currentCommit}\n`);
      return {
        command,
        args,
        cwd: commandOptions?.cwd,
        exitCode: options.expectedCommit ? 0 : 2,
        stdout: options.expectedCommit ? `${options.expectedCommit}\trefs/heads/main\n` : '',
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
      npmRootCalls += 1;
      if (options.rollbackFails && npmRootCalls > 1) throw new Error('global root unavailable during rollback');
      return result(command, args, commandOptions?.cwd, `${globalRoot}\n`);
    }
    const currentPackageRoot = await fs.realpath(globalLink);
    refreshed = currentPackageRoot !== previousPackageRootReal;
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
        build: { commit: refreshed && !options.invalidAfterRefresh ? currentCommit : options.buildCommit, builtAt: '2026-08-03T00:00:00.000Z', dirty: false },
        runtime: { commit: refreshed && !options.invalidAfterRefresh ? currentCommit : options.runtimeCommit, dirty: false, packageRoot: currentPackageRoot }
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
      home: process.env.KAIZEN_HOME
    };
  } finally {
    if (previousHome === undefined) delete process.env.KAIZEN_HOME;
    else process.env.KAIZEN_HOME = previousHome;
  }
}

function result(command: string, args: string[], cwd: string | undefined, stdout: string) {
  return { command, args, cwd, exitCode: 0, stdout, stderr: '', durationMs: 1 };
}
