import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { fleetHasFailures, migrateLegacySchedulerConfig, syncFleet, type FleetProjectResult } from '../src/commands/fleet.js';
import type { CommandRunner } from '../src/utils/command.js';

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
