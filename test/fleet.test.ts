import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetHasFailures, migrateLegacySchedulerConfig, refreshFleet, syncFleet, type FleetProjectResult } from '../src/commands/fleet.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('migrateLegacySchedulerConfig', () => {
  it('converts legacy nightly, afternoon, and poll settings into scheduler jobs', () => {
    const config = {
      version: 1,
      scheduler: {
        nightly: { enabled: true, time: '02:15' },
        afternoon: { enabled: true, time: '14:15' },
        poll: { enabled: false, intervalMinutes: 5, skipIfRunning: true }
      }
    };

    expect(migrateLegacySchedulerConfig(config)).toBe(true);
    expect(config.scheduler).toEqual({
      jobs: {
        maintenance: {
          enabled: true,
          schedule: { type: 'times', times: ['02:15', '14:15'] },
          run: { mode: 'maintenance', lateStartGuard: false }
        },
        'issue-watch': {
          enabled: false,
          schedule: { type: 'interval', everyMinutes: 5 },
          run: { mode: 'watch', skipIfRunning: true }
        }
      }
    });
  });

  it('preserves explicitly disabled legacy maintenance schedules', () => {
    const config = {
      version: 1,
      scheduler: {
        nightly: { enabled: false, time: '02:15' },
        poll: { enabled: false, intervalMinutes: 5, skipIfRunning: true }
      }
    };

    expect(migrateLegacySchedulerConfig(config)).toBe(true);
    expect(config.scheduler).toEqual({
      jobs: {
        maintenance: {
          enabled: false,
          schedule: { type: 'daily', time: '02:15' },
          run: { mode: 'maintenance', lateStartGuard: true }
        },
        'issue-watch': {
          enabled: false,
          schedule: { type: 'interval', everyMinutes: 5 },
          run: { mode: 'watch', skipIfRunning: true }
        }
      }
    });
  });

  it('leaves current scheduler jobs unchanged', () => {
    const config = {
      version: 1,
      scheduler: {
        jobs: {
          maintenance: {
            schedule: { type: 'daily', time: '02:00' },
            run: { mode: 'maintenance', lateStartGuard: true }
          }
        }
      }
    };

    expect(migrateLegacySchedulerConfig(config)).toBe(false);
  });
});

describe('syncFleet', () => {
  it('preserves a non-empty registry when prune discovery is empty', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-fleet-'));
    vi.stubEnv('KAIZEN_HOME', home);
    vi.stubEnv('HOME', home);
    const registryPath = path.join(home, 'registry.json');
    const registry = {
      version: 1,
      projects: {
        'o-r': {
          repo: 'o/r',
          localPath: '/tmp/r',
          workspacePath: '/tmp/r-workspace',
          schedule: '02:00',
          enabled: true,
          createdAt: '2026-06-12T00:00:00Z'
        }
      }
    };
    await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const before = await fs.readFile(registryPath, 'utf8');
    const runner = vi.fn<CommandRunner>();

    await expect(syncFleet({
      cwd: root,
      root,
      owner: 'o',
      migrateConfig: true,
      ensureWorkspace: true,
      ensureLabels: true,
      syncScheduler: true,
      repairLocks: true,
      verify: false,
      prune: true,
      dryRun: false,
      runCommand: runner
    })).rejects.toThrow('Refusing to prune 1 registered project(s) because fleet discovery');

    await expect(fs.readFile(registryPath, 'utf8')).resolves.toBe(before);
  });

  it('rebuilds registry entries from repo checkouts and migrates legacy configs', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-fleet-'));
    vi.stubEnv('KAIZEN_HOME', home);
    vi.stubEnv('HOME', home);

    const repoDir = path.join(root, 'builder-agent');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(repoDir, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, '.kaizen', 'config.yml'),
      [
        'version: 1',
        'scheduler:',
        '  nightly:',
        '    enabled: true',
        '    time: "02:15"',
        '  afternoon:',
        '    enabled: true',
        '    time: "14:15"',
        '  poll:',
        '    enabled: false',
        '    intervalMinutes: 5',
        'commands:',
        '  setup: "npm ci"',
        '  verify:',
        '    - "npm test"',
        ''
      ].join('\n')
    );
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify({
        version: 1,
        projects: {
          stale: {
            repo: 'o/r',
            localPath: '/tmp/stale',
            workspacePath: '/tmp/stale-workspace',
            schedule: '02:00',
            enabled: false,
            createdAt: '2026-06-12T00:00:00Z'
          }
        }
      })
    );
    const duplicateRepoDir = path.join(root, 'builder-agent-old-branch');
    await fs.mkdir(path.join(duplicateRepoDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(duplicateRepoDir, '.kaizen'), { recursive: true });
    await fs.writeFile(
      path.join(duplicateRepoDir, '.kaizen', 'config.yml'),
      ['version: 1', 'commands:', '  setup: null', '  verify: []', ''].join('\n')
    );

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        return result(command, args, options?.cwd, 'https://github.com/kaizen-agents-org/builder-agent.git\n');
      }
      if (command === 'git' && args[0] === 'clone') return result(command, args, options?.cwd, '');
      if (command === 'git' && args[0] === 'fetch') return result(command, args, options?.cwd, '');
      if (command === 'git' && args[0] === 'checkout') return result(command, args, options?.cwd, '');
      if (command === 'git' && args[0] === 'reset') return result(command, args, options?.cwd, '');
      if (command === 'git' && args[0] === 'clean') return result(command, args, options?.cwd, '');
      if (command === 'gh') return result(command, args, options?.cwd, '');
      if (command === 'launchctl') return result(command, args, options?.cwd, '');
      if (command === 'sh' && args.join(' ') === '-lc npm ci') return result(command, args, options?.cwd, 'setup ok\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, options?.cwd, 'tests ok\n');
      return result(command, args, options?.cwd, '');
    });

    const output = await syncFleet({
      cwd: repoDir,
      root,
      owner: 'kaizen-agents-org',
      migrateConfig: true,
      ensureWorkspace: true,
      ensureLabels: true,
      syncScheduler: true,
      repairLocks: true,
      verify: true,
      prune: true,
      dryRun: false,
      runCommand: runner
    });

    expect(output.pruned).toEqual(['stale']);
    expect(output.projects).toMatchObject([
      {
        slug: 'kaizen-agents-org-builder-agent',
        repo: 'kaizen-agents-org/builder-agent',
        configMigrated: true,
        workspaceEnsured: true,
        labelsEnsured: true,
        schedulerSynced: true,
        verified: true,
        verifyPassed: true,
        verifyResults: [{ command: 'npm test', ok: true, output: 'tests ok\n' }]
      }
    ]);

    const registry = JSON.parse(await fs.readFile(path.join(home, 'registry.json'), 'utf8'));
    expect(Object.keys(registry.projects)).toEqual(['kaizen-agents-org-builder-agent']);
    expect(registry.projects['kaizen-agents-org-builder-agent']).toMatchObject({
      repo: 'kaizen-agents-org/builder-agent',
      localPath: repoDir,
      schedule: '02:15',
      enabled: true
    });

    const migrated = parse(await fs.readFile(path.join(repoDir, '.kaizen', 'config.yml'), 'utf8'));
    expect(migrated.scheduler.jobs.maintenance.schedule).toEqual({ type: 'times', times: ['02:15', '14:15'] });
    expect(migrated.scheduler.nightly).toBeUndefined();
    expect(runner.mock.calls.some(([command]) => command === 'launchctl' || command === 'crontab')).toBe(true);
    expect(runner.mock.calls.some(([command]) => command === 'gh')).toBe(true);
  });

  it('reports fleet failures when a project errors or verify fails', () => {
    expect(fleetHasFailures({
      root: '/tmp/fleet',
      owner: 'kaizen-agents-org',
      dryRun: false,
      pruned: [],
      projects: [
        fleetProject({ verifyPassed: true }),
        fleetProject({ verifyPassed: false })
      ]
    })).toBe(true);

    expect(fleetHasFailures({
      root: '/tmp/fleet',
      dryRun: false,
      pruned: [],
      projects: [fleetProject({ error: 'failed to sync' })]
    })).toBe(true);

    expect(fleetHasFailures({
      root: '/tmp/fleet',
      dryRun: false,
      pruned: [],
      projects: [fleetProject({ error: '' })]
    })).toBe(true);

    expect(fleetHasFailures({
      root: '/tmp/fleet',
      dryRun: false,
      pruned: [],
      projects: [fleetProject({ verifyPassed: true })]
    })).toBe(false);
  });

  it('stops fleet verification when setup fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-fleet-'));
    vi.stubEnv('KAIZEN_HOME', home);
    vi.stubEnv('HOME', home);

    const repoDir = path.join(root, 'verifier');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(repoDir, '.kaizen'), { recursive: true });
    const config = parse(defaultConfigYaml({ agent: 'claude', setup: 'pnpm install --frozen-lockfile', verify: ['pnpm test'] }));
    await fs.writeFile(path.join(repoDir, '.kaizen', 'config.yml'), stringify(config));

    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        return result(command, args, options?.cwd, 'https://github.com/kaizen-agents-org/verifier.git\n');
      }
      if (command === 'sh' && args[1] === 'pnpm install --frozen-lockfile') {
        return { ...result(command, args, options?.cwd, 'missing package\n'), exitCode: 1 };
      }
      if (command === 'sh' && args[1] === 'pnpm test') {
        throw new Error('verify should not run after setup failure');
      }
      return result(command, args, options?.cwd, '');
    });

    const output = await syncFleet({
      cwd: repoDir,
      root,
      owner: 'kaizen-agents-org',
      migrateConfig: true,
      ensureWorkspace: true,
      ensureLabels: false,
      syncScheduler: false,
      repairLocks: false,
      verify: true,
      prune: false,
      dryRun: false,
      runCommand: runner
    });

    expect(output.projects[0]).toMatchObject({
      slug: 'kaizen-agents-org-verifier',
      verified: true,
      verifyPassed: false,
      setupResult: {
        command: 'pnpm install --frozen-lockfile',
        ok: false,
        output: 'missing package\n'
      },
      verifyResults: []
    });
    expect(fleetHasFailures(output)).toBe(true);
    expect(runner.mock.calls.some(([command, args]) => command === 'sh' && args[1] === 'pnpm test')).toBe(false);
  });
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

  it('uses the registered checkout origin when cloning a missing workspace', async () => {
    const project = await setupProject('o-r', { setup: null, verify: [] });
    await saveFleet([project]);
    await fs.rm(project.workspace, { recursive: true, force: true });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        return result(command, args, options?.cwd, 'git@github.com:o/r.git\n');
      }
      return result(command, args, options?.cwd, '');
    });

    await refreshFleet({
      cwd: project.repo,
      project: 'o-r',
      sync: true,
      runCommand: runner
    });

    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain(`clone git@github.com:o/r.git ${project.workspace}`);
  });

  it('falls back to the registered repo when the checkout origin cannot be read', async () => {
    const project = await setupProject('o-r', { setup: null, verify: [] });
    await saveFleet([project]);
    await fs.rm(project.workspace, { recursive: true, force: true });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        throw new Error('missing origin');
      }
      return result(command, args, options?.cwd, '');
    });

    await refreshFleet({
      cwd: project.repo,
      project: 'o-r',
      sync: true,
      runCommand: runner
    });

    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain(`clone https://github.com/o/r.git ${project.workspace}`);
  });

  it('skips a project when its run lock is active', async () => {
    const project = await setupProject('o-r', { setup: 'npm ci', verify: ['npm test'] });
    const home = await saveFleet([project]);
    await fs.mkdir(path.join(home, 'projects', 'o-r'), { recursive: true });
    await fs.writeFile(path.join(home, 'projects', 'o-r', 'run.lock'), JSON.stringify({ pid: process.pid }));
    const runner = vi.fn<CommandRunner>(async (command, args, options) => result(command, args, options?.cwd, ''));

    const output = await refreshFleet({
      cwd: project.repo,
      project: 'o-r',
      sync: true,
      runCommand: runner
    });

    expect(output.ok).toBe(false);
    expect(output.projects[0].steps).toEqual([
      { name: 'config', ok: true },
      { name: 'workspace', ok: false, message: 'skipped because run is already active' },
      { name: 'sync', ok: false, message: 'skipped because run is already active' },
      { name: 'setup', ok: false, message: 'skipped because run is already active' },
      { name: 'verify', ok: false, message: 'skipped because run is already active' }
    ]);
    const mutatingCommands = runner.mock.calls.map(([, args]) => args.join(' ')).filter((command) => command !== 'remote get-url origin');
    expect(mutatingCommands).toEqual([]);
  });

  it('refuses to repair a workspace outside the managed workspace directory', async () => {
    const project = await setupProject('o-r', { setup: null, verify: [] });
    await saveFleet([project]);
    const unsafeWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unsafe-workspace-'));
    await saveRegistry({
      version: 1,
      projects: {
        'o-r': {
          repo: 'o/r',
          localPath: project.repo,
          workspacePath: unsafeWorkspace,
          schedule: '02:00',
          enabled: false,
          createdAt: '2026-06-12T00:00:00Z'
        }
      }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        return result(command, args, options?.cwd, 'git@github.com:o/r.git\n');
      }
      return result(command, args, options?.cwd, '');
    });

    const output = await refreshFleet({
      cwd: project.repo,
      project: 'o-r',
      sync: true,
      runCommand: runner
    });

    expect(output.ok).toBe(false);
    expect(output.projects[0].steps).toContainEqual(expect.objectContaining({
      name: 'workspace',
      ok: false,
      message: expect.stringContaining('Refusing to refresh unsafe workspace path for o-r')
    }));
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).not.toContain(`clone git@github.com:o/r.git ${unsafeWorkspace}`);
  });

  it('refuses to run no-sync setup or verify in an unsafe workspace', async () => {
    const project = await setupProject('o-r', { setup: 'npm ci', verify: ['npm test'] });
    await saveFleet([project]);
    const unsafeWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unsafe-workspace-'));
    await fs.mkdir(path.join(unsafeWorkspace, '.git'), { recursive: true });
    await saveRegistry({
      version: 1,
      projects: {
        'o-r': {
          repo: 'o/r',
          localPath: project.repo,
          workspacePath: unsafeWorkspace,
          schedule: '02:00',
          enabled: false,
          createdAt: '2026-06-12T00:00:00Z'
        }
      }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => result(command, args, options?.cwd, ''));

    const output = await refreshFleet({
      cwd: project.repo,
      project: 'o-r',
      runCommand: runner
    });

    expect(output.ok).toBe(false);
    expect(output.projects[0].steps).toEqual([
      { name: 'config', ok: true },
      expect.objectContaining({
        name: 'workspace',
        ok: false,
        message: expect.stringContaining('Refusing to refresh unsafe workspace path for o-r')
      }),
      { name: 'setup', ok: false, message: 'skipped because workspace is not ready' },
      { name: 'verify', ok: false, message: 'skipped because workspace is not ready' }
    ]);
    expect(runner).not.toHaveBeenCalled();
  });
});

function fleetProject(overrides: Partial<FleetProjectResult>) {
  return { ...baseFleetProject(), ...overrides };
}

function baseFleetProject(): FleetProjectResult {
  return {
    slug: 'kaizen-agents-org-builder-agent',
    repo: 'kaizen-agents-org/builder-agent',
    localPath: '/tmp/fleet/builder-agent',
    configMigrated: false,
    workspaceEnsured: true,
    labelsEnsured: true,
    schedulerSynced: true,
    lockRepaired: false,
    verified: true,
    enabled: true
  };
}

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
  const entries = [];
  for (const project of projects) {
    project.workspace = path.join(home, 'workspaces', project.slug);
    await fs.mkdir(path.join(project.workspace, '.git'), { recursive: true });
    entries.push([
      project.slug,
      {
        repo: project.slug.replace('-', '/'),
        localPath: project.repo,
        workspacePath: project.workspace,
        schedule: '02:00',
        enabled: false,
        createdAt: '2026-06-12T00:00:00Z'
      }
    ]);
  }
  await saveRegistry({
    version: 1,
    projects: Object.fromEntries(entries)
  });
  return home;
}

function result(command: string, args: string[], cwd: string | undefined, stdout: string) {
  return {
    command,
    args,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
    cwd
  };
}
