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
  it('repairs core state labels even when exclude labels are customized', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => result(command, args, options?.cwd, 'ok'));

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
    expect(createdLabels.filter((label) => label === 'kaizen:needs-human')).toHaveLength(1);
    expect(output.checks.find((item) => item.name === 'temporary directory')?.ok).toBe(true);
    expect(output.checks.find((item) => item.name === 'claude auth')?.ok).toBe(true);
    expect(output.checks.find((item) => item.name === 'codex auth')?.ok).toBe(true);
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
  config.verifier.enabled = false;
  config.guardian.enabled = false;
  config.issues.selection.excludeLabels = [];
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), stringify(config));
  if (options.createWorkspace !== false) {
    await fs.mkdir(workspace, { recursive: true });
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
