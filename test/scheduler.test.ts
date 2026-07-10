import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { disableScheduler, enableScheduler } from '../src/scheduler/scheduler.js';
import type { RegistryProject } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('enableScheduler', () => {
  it('creates the project state directory before installing a cron job', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: command === 'crontab' && args[0] === '-l' ? '' : '',
      stderr: '',
      durationMs: 1
    }));
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    await enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({ version: 1 }),
      runCommand: runner,
      platform: 'linux'
    });

    await expect(fs.access(path.join(home, 'projects', 'owner-repo'))).resolves.toBeUndefined();
  });

  it('installs configured scheduler cron jobs', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout:
        command === 'crontab' && args[0] === '-l'
          ? [
              '# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) maintenance',
              '30 1 * * * node kaizen run --project owner-repo --scheduled --trigger scheduled',
              '# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) old-job',
              '30 13 * * * node kaizen run --project owner-repo --scheduled --trigger afternoon',
              '0 9 * * * node kaizen run --project other-repo --scheduled'
            ].join('\n')
          : '',
      stderr: '',
      durationMs: 1
    }));
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    const scheduler = await enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({
        version: 1,
        scheduler: {
          jobs: {
            maintenance: {
              schedule: { type: 'times', times: ['01:30', '14:30'] },
              run: { mode: 'maintenance', lateStartGuard: true }
            },
            'issue-watch': {
              schedule: { type: 'interval', everyMinutes: 5 },
              run: { mode: 'watch', skipIfRunning: true }
            }
          }
        }
      }),
      runCommand: runner,
      platform: 'linux'
    });

    expect(scheduler.jobs).toEqual([
      {
        name: 'maintenance',
        config: {
          enabled: true,
          schedule: { type: 'times', times: ['01:30', '14:30'] },
          run: { mode: 'maintenance', lateStartGuard: true }
        }
      },
      {
        name: 'issue-watch',
        config: {
          enabled: true,
          schedule: { type: 'interval', everyMinutes: 5 },
          run: { mode: 'watch', skipIfRunning: true }
        }
      }
    ]);
    const crontabInput = String(runner.mock.calls.find(([command, args]) => command === 'crontab' && args[0] === '-')?.[2]?.input);
    expect(crontabInput).not.toContain('node kaizen run --project owner-repo --scheduled --trigger scheduled');
    expect(crontabInput).toContain('node kaizen run --project other-repo --scheduled');
    expect(crontabInput).toContain('30 1 * * * ');
    expect(crontabInput).toContain('30 14 * * * ');
    expect(crontabInput).toContain('*/5 * * * * ');
    expect(crontabInput).toContain("/bin/sh '");
    expect(crontabInput).toContain("bin/run-scheduled.sh'");
    expect(crontabInput).toContain("'owner-repo' 'maintenance'");
    expect(crontabInput).toContain("'owner-repo' 'issue-watch'");
    expect(crontabInput).toContain('# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) maintenance');
    expect(crontabInput).toContain('# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) issue-watch');
    await expect(fs.access(path.join(home, 'bin', 'run-scheduled.sh'))).resolves.toBeUndefined();
  });

  it('installs scheduler jobs with anchored hourly cron schedules', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: command === 'crontab' && args[0] === '-l' ? '' : '',
      stderr: '',
      durationMs: 1
    }));
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    await enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({
        version: 1,
        scheduler: {
          jobs: {
            maintenance: {
              schedule: { type: 'interval', everyHours: 8, anchorTime: '02:45' },
              run: { mode: 'maintenance', lateStartGuard: false }
            }
          }
        }
      }),
      runCommand: runner,
      platform: 'linux'
    });

    const crontabInput = String(runner.mock.calls.find(([command, args]) => command === 'crontab' && args[0] === '-')?.[2]?.input);
    expect(crontabInput).toContain("45 2 * * * ");
    expect(crontabInput).toContain("45 10 * * * ");
    expect(crontabInput).toContain("45 18 * * * ");
    expect(crontabInput).toContain("'owner-repo' 'maintenance'");
  });

  it('rejects hourly cron schedules that cannot be represented exactly', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: command === 'crontab' && args[0] === '-l' ? '' : '',
      stderr: '',
      durationMs: 1
    }));
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    await expect(enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({
        version: 1,
        scheduler: {
          jobs: {
            maintenance: {
              schedule: { type: 'interval', everyHours: 7 },
              run: { mode: 'maintenance', lateStartGuard: false }
            }
          }
        }
      }),
      runCommand: runner,
      platform: 'linux'
    })).rejects.toThrow('Unsupported cron hourly interval: everyHours 7');
  });

  it('installs configured watch launchd job with StartInterval', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    const scheduler = await enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({
        version: 1,
        scheduler: {
          jobs: {
            'issue-watch': {
              schedule: { type: 'interval', everyMinutes: 5 },
              run: { mode: 'watch', skipIfRunning: true }
            }
          }
        }
      }),
      runCommand: runner,
      platform: 'darwin'
    });

    expect(scheduler.paths).toHaveLength(1);
    const bootoutCalls = runner.mock.calls.filter(([command, args]) => command === 'launchctl' && args[0] === 'bootout');
    expect(bootoutCalls).toHaveLength(4);
    const plist = await fs.readFile(scheduler.paths![0], 'utf8');
    expect(plist).toContain('<key>StartInterval</key><integer>300</integer>');
    expect(plist).toContain('<string>/bin/sh</string>');
    expect(plist).toContain('<string>issue-watch</string>');
    expect(plist).toContain('bin/run-scheduled.sh</string>');
  });

  it('installs configured maintenance launchd job with StartCalendarInterval', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    const scheduler = await enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({
        version: 1,
        scheduler: {
          jobs: {
            maintenance: {
              schedule: { type: 'daily', time: '14:30' },
              run: { mode: 'maintenance', lateStartGuard: false }
            }
          }
        }
      }),
      runCommand: runner,
      platform: 'darwin'
    });

    expect(scheduler.paths).toHaveLength(1);
    const plist = await fs.readFile(scheduler.paths![0], 'utf8');
    expect(plist).toContain('<key>Label</key><string>com.kaizen-loop.owner-repo.maintenance</string>');
    expect(plist).toContain('<dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer></dict>');
    expect(plist).toContain('<string>maintenance</string>');
  });

  it('installs configured weekly launchd jobs with weekdays', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    const scheduler = await enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({
        version: 1,
        scheduler: {
          jobs: {
            maintenance: {
              schedule: { type: 'weekly', days: ['MO', 'FR'], time: '14:30' },
              run: { mode: 'maintenance', lateStartGuard: false }
            }
          }
        }
      }),
      runCommand: runner,
      platform: 'darwin'
    });

    const plist = await fs.readFile(scheduler.paths![0], 'utf8');
    expect(plist).toContain('<array>');
    expect(plist).toContain('<key>Weekday</key><integer>1</integer>');
    expect(plist).toContain('<key>Weekday</key><integer>5</integer>');
    expect(plist).toContain('<key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer>');
  });

  it('fails when launchd bootstrap fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'launchctl' && args[0] === 'bootstrap') throw new Error('bootstrap failed');
      return {
        command,
        args,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1
      };
    });
    const project: RegistryProject = {
      repo: 'owner/repo',
      localPath: '/repo',
      workspacePath: '/workspace',
      schedule: '02:00',
      enabled: false,
      createdAt: '2026-06-13T00:00:00Z'
    };

    await expect(enableScheduler({
      slug: 'owner-repo',
      project,
      config: configSchema.parse({ version: 1 }),
      runCommand: runner,
      platform: 'darwin'
    })).rejects.toThrow('bootstrap failed');
  });

  it('removes legacy and configured scheduler entries when disabling', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout:
        command === 'crontab' && args[0] === '-l'
          ? [
              '# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) nightly',
              '30 1 * * * node kaizen run --project owner-repo --scheduled --trigger scheduled',
              '# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) afternoon',
              '30 14 * * * node kaizen run --project owner-repo --scheduled --trigger afternoon',
              '# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) poll',
              '*/5 * * * * node kaizen run --project owner-repo --scheduled --trigger watch',
              '# KAIZEN-LOOP owner-repo',
              '0 2 * * * node kaizen run --project owner-repo --scheduled',
              '0 4 * * * node kaizen run --project owner-repo --scheduled --unmanaged'
            ].join('\n')
          : '',
      stderr: '',
      durationMs: 1
    }));

    await disableScheduler({ slug: 'owner-repo', runCommand: runner, platform: 'linux' });

    const crontabInput = String(runner.mock.calls.find(([command, args]) => command === 'crontab' && args[0] === '-')?.[2]?.input);
    expect(crontabInput).not.toContain('KAIZEN-LOOP owner-repo');
    expect(crontabInput).not.toContain('--trigger scheduled');
    expect(crontabInput).not.toContain('--trigger afternoon');
    expect(crontabInput).not.toContain('--trigger watch');
    expect(crontabInput).toContain('0 4 * * * node kaizen run --project owner-repo --scheduled --unmanaged');
  });

  it('does not remove legacy cron entries for slugs with the same prefix', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout:
        command === 'crontab' && args[0] === '-l'
          ? [
              '# KAIZEN-LOOP owner',
              '0 2 * * * node kaizen run --project owner --scheduled',
              '# KAIZEN-LOOP owner-repo',
              '0 3 * * * node kaizen run --project owner-repo --scheduled'
            ].join('\n')
          : '',
      stderr: '',
      durationMs: 1
    }));

    await disableScheduler({ slug: 'owner', runCommand: runner, platform: 'linux' });

    const crontabInput = String(runner.mock.calls.find(([command, args]) => command === 'crontab' && args[0] === '-')?.[2]?.input);
    expect(crontabInput).not.toContain('--project owner --scheduled');
    expect(crontabInput).toContain('# KAIZEN-LOOP owner-repo');
    expect(crontabInput).toContain('--project owner-repo --scheduled');
  });
});
