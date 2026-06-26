import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshFleet } from '../src/commands/fleet.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('refreshFleet', () => {
  it('discovers registered projects, syncs workspaces, and runs setup plus verify commands', async () => {
    const first = await setupProject('o-one', { setup: 'npm ci', verify: ['npm test'] });
    const second = await setupProject('o-two', { setup: 'npm install', verify: ['npm run typecheck', 'npm run build'] });
    await saveFleet([first, second]);
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'git') return result(command, args, options?.cwd, '');
      if (command === 'sh') return result(command, args, options?.cwd, `ran ${args[1]}`);
      return result(command, args, options?.cwd, '');
    });

    const output = await refreshFleet({
      cwd: first.repo,
      sync: true,
      runCommand: runner
    });

    expect(output.ok).toBe(true);
    expect(output.projects.map((project) => project.slug)).toEqual(['o-one', 'o-two']);
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain('fetch origin');
    expect(gitCommands).toContain('checkout main');
    expect(gitCommands).toContain('reset --hard origin/main');
    expect(gitCommands).toContain('clean -fdx');
    const shellCommands = runner.mock.calls.filter(([command]) => command === 'sh').map(([, args]) => args[1]);
    expect(shellCommands).toEqual(['npm ci', 'npm test', 'npm install', 'npm run typecheck', 'npm run build']);
  });

  it('reports verification failure as fleet readiness failure', async () => {
    const project = await setupProject('o-r', { setup: null, verify: ['npm test', 'npm run build'] });
    await saveFleet([project]);
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'sh' && args[1] === 'npm test') {
        return { ...result(command, args, options?.cwd, 'failed'), exitCode: 1 };
      }
      return result(command, args, options?.cwd, '');
    });

    const output = await refreshFleet({
      cwd: project.repo,
      project: 'o-r',
      runCommand: runner
    });

    expect(output.ok).toBe(false);
    expect(output.projects[0].ok).toBe(false);
    expect(output.projects[0].steps).toContainEqual(expect.objectContaining({
      name: 'verify',
      command: 'npm test',
      ok: false,
      output: 'failed'
    }));
    expect(runner.mock.calls.filter(([, args]) => args[1] === 'npm run build')).toHaveLength(0);
  });

  it('does not sync unless requested', async () => {
    const project = await setupProject('o-r', { setup: null, verify: [] });
    await saveFleet([project]);
    const runner = vi.fn<CommandRunner>(async (command, args, options) => result(command, args, options?.cwd, ''));

    const output = await refreshFleet({
      cwd: project.repo,
      runCommand: runner
    });

    expect(output.ok).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(output.projects[0].steps).toEqual([
      { name: 'config', ok: true },
      { name: 'workspace', ok: true },
      { name: 'setup', ok: true, message: 'not configured' },
      { name: 'verify', ok: true, message: 'not configured' }
    ]);
  });
});

async function setupProject(slug: string, options: { setup: string | null; verify: string[] }) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), `${slug}-repo-`));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `${slug}-workspace-`));
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const config = parse(defaultConfigYaml({ agent: 'claude', setup: options.setup, verify: options.verify })) as Record<string, unknown>;
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), stringify(config));
  return { slug, repo, workspace };
}

async function saveFleet(projects: Array<{ slug: string; repo: string; workspace: string }>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await saveRegistry({
    version: 1,
    projects: Object.fromEntries(projects.map((project) => [
      project.slug,
      {
        repo: project.slug.replace('-', '/'),
        localPath: project.repo,
        workspacePath: project.workspace,
        schedule: '02:00',
        enabled: false,
        createdAt: '2026-06-12T00:00:00Z'
      }
    ]))
  });
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
