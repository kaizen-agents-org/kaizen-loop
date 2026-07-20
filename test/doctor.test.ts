import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorProject } from '../src/commands/doctor.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('doctorProject', () => {
  it('reports drift while using the fleet workspace config for operational checks', async () => {
    const { repo, workspace } = await setupProject();
    vi.stubEnv('KAIZEN_RUNTIME_COMMIT', 'abc123');
    vi.stubEnv('KAIZEN_RUNTIME_DIR', '/runtime/kaizen-loop');
    const workspaceConfig = parse(await fs.readFile(path.join(workspace, '.kaizen', 'config.yml'), 'utf8')) as Record<string, any>;
    workspaceConfig.issues.selection.mode = 'opt-in';
    workspaceConfig.issues.selection.includeLabel = 'kaizen:ready';
    await fs.writeFile(path.join(workspace, '.kaizen', 'config.yml'), stringify(workspaceConfig));
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'builder-agent' && args.length === 0) {
        await writeBuilderResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: 'doctor smoke ok',
          notes: '',
          discoveredIssues: []
        });
      }
      return result(command, args, options?.cwd, 'ok');
    });

    const output = await doctorProject({ cwd: repo, project: 'o-r', repair: false, runCommand: runner });

    expect(output.ok).toBe(true);
    expect(output.runtime).toEqual({ commit: 'abc123', directory: '/runtime/kaizen-loop' });
    expect(output.configuration).toMatchObject({
      source: 'workspace',
      path: workspace,
      drift: {
        detected: true,
        message: 'developer checkout config differs from fleet workspace config'
      }
    });
  });

  it('repairs core state labels even when exclude labels are customized', async () => {
    const { repo, workspace } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'builder-agent' && args.length === 0) {
        await writeBuilderResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'fixed',
          summary: 'doctor smoke ok',
          notes: '',
          discoveredIssues: []
        });
      }
      return result(command, args, options?.cwd, 'ok');
    });

    const output = await doctorProject({
      cwd: repo,
      project: 'o-r',
      repair: true,
      runCommand: runner
    });

    expect(output.ok).toBe(true);
    const createdLabels = runner.mock.calls
      .filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('label create'))
      .map(([, args]) => args[2]);
    expect(createdLabels).toContain('kaizen:needs-human');
    expect(createdLabels).toContain('kaizen:roadmap');
    expect(createdLabels.filter((label) => label === 'kaizen:needs-human')).toHaveLength(1);
    expect(createdLabels).toEqual(expect.arrayContaining([
      'kaizen:retryable',
      'kaizen:blocked',
      'kaizen:upstream-first',
      'kaizen:not-actionable',
      'kaizen:attempts-exhausted'
    ]));
    expect(output.checks.find((item) => item.name === 'temporary directory')?.ok).toBe(true);
    expect(output.checks.find((item) => item.name === 'claude auth')?.ok).toBe(true);
    expect(output.checks.find((item) => item.name === 'codex auth')?.ok).toBe(true);
    const builderRuntimeCall = runner.mock.calls.find(([command, args]) => command === 'builder-agent' && args.length === 0);
    expect(builderRuntimeCall?.[2]?.cwd).toBe(workspace);
    expect(builderRuntimeCall?.[2]?.env?.KAIZEN_WORKSPACE_DIR).toBe(workspace);
  });

  it('does not create a missing workspace while checking temporary storage', async () => {
    const { repo, workspace } = await setupProject({ createWorkspace: false });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => result(command, args, options?.cwd, 'ok'));

    const output = await doctorProject({
      cwd: repo,
      project: 'o-r',
      repair: false,
      runCommand: runner
    });

    expect(output.ok).toBe(false);
    expect(output.checks.find((item) => item.name === 'workspace')?.ok).toBe(false);
    expect(output.checks.find((item) => item.name === 'temporary directory')?.ok).toBe(false);
    await expect(fs.access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails when the builder command exists but runtime smoke test cannot execute', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'builder-agent' && args.length === 0) {
        await writeBuilderResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, {
          status: 'blocked',
          summary: 'Builder agent exited with code 1.',
          notes: 'usage limit',
          blockedReason: 'Builder agent exited with code 1.',
          discoveredIssues: []
        });
        return result(command, args, options?.cwd, 'Builder agent exited with code 1.', 2);
      }
      return result(command, args, options?.cwd, 'ok');
    });

    const output = await doctorProject({
      cwd: repo,
      project: 'o-r',
      repair: false,
      runCommand: runner
    });

    expect(output.ok).toBe(false);
    const runtimeCheck = output.checks.find((check) => check.name === 'builder agent runtime');
    expect(runtimeCheck).toMatchObject({ ok: false });
    expect(runtimeCheck?.message).toContain('Builder agent exited with code 1.');
    expect(runtimeCheck?.message).toContain('usage limit');
  });
});

async function setupProject(options: { createWorkspace?: boolean } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  if (options.createWorkspace === false) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  const config = parse(defaultConfigYaml({ agent: 'claude', setup: null, verify: [] })) as Record<string, any>;
  config.safety.operationMode = 'dogfood';
  config.verifier.enabled = false;
  config.guardian.enabled = false;
  config.issues.selection.excludeLabels = [];
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), stringify(config));
  if (options.createWorkspace !== false) {
    await fs.mkdir(path.join(workspace, '.kaizen'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.kaizen', 'config.yml'), stringify(config));
  }
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
  return { repo, workspace };
}

async function writeBuilderResult(resultPath: unknown, payload: unknown) {
  if (typeof resultPath !== 'string') throw new Error('missing KAIZEN_BUILD_RESULT_PATH');
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.writeFile(resultPath, `${JSON.stringify(payload)}\n`);
}

function result(command: string, args: string[], cwd: string | undefined, stdout: string, exitCode = 0) {
  return {
    command,
    args,
    cwd,
    exitCode,
    stdout,
    stderr: '',
    durationMs: 1
  };
}
