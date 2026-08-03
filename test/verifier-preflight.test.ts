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
});

async function inspect(options: {
  expectedCommit: string | null;
  buildCommit?: string;
  runtimeCommit?: string;
  legacy?: boolean;
}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-preflight-'));
  const config = configSchema.parse({ version: 1 });
  const runner = vi.fn<CommandRunner>(async (command, args, commandOptions) => {
    if (command === 'git') {
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
        build: { commit: options.buildCommit, builtAt: '2026-08-03T00:00:00.000Z', dirty: false },
        runtime: { commit: options.runtimeCommit, dirty: false, packageRoot: '/runtime/verifier/packages/core' }
      }),
      stderr: '',
      durationMs: 1
    };
  });

  const failure = await preflightVerifier({ config, runCommand: runner, runDir });
  const diagnostic = JSON.parse(await fs.readFile(path.join(runDir, 'verifier-runtime.json'), 'utf8'));
  return { failure, diagnostic, runner };
}
