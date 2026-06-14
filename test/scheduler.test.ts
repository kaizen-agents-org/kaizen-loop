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
      schedule: '02:00',
      runCommand: runner,
      platform: 'linux'
    });

    await expect(fs.access(path.join(home, 'projects', 'owner-repo'))).resolves.toBeUndefined();
  });

  it('installs configured nightly and poll cron jobs', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('KAIZEN_HOME', home);
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout:
        command === 'crontab' && args[0] === '-l'
          ? [
              '# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) nightly',
              '30 1 * * * node kaizen run --project owner-repo --scheduled --trigger scheduled',
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
          nightly: { enabled: true, time: '01:30' },
          poll: { enabled: true, intervalMinutes: 5, skipIfRunning: true }
        }
      }),
      schedule: '01:30',
      runCommand: runner,
      platform: 'linux'
    });

    expect(scheduler.jobs).toEqual([
      { name: 'nightly', trigger: 'scheduled', time: '01:30' },
      { name: 'poll', trigger: 'watch', intervalMinutes: 5 }
    ]);
    const crontabInput = String(runner.mock.calls.find(([command, args]) => command === 'crontab' && args[0] === '-')?.[2]?.input);
    expect(crontabInput).not.toContain('node kaizen run --project owner-repo --scheduled --trigger scheduled');
    expect(crontabInput).toContain('node kaizen run --project other-repo --scheduled');
    expect(crontabInput).toContain('30 1 * * * ');
    expect(crontabInput).toContain('*/5 * * * * ');
    expect(crontabInput).toContain("run --project 'owner-repo' --scheduled --trigger 'scheduled'");
    expect(crontabInput).toContain("run --project 'owner-repo' --scheduled --trigger 'watch'");
    expect(crontabInput).toContain('# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) nightly');
    expect(crontabInput).toContain('# KAIZEN-LOOP owner-repo (managed by kaizen-loop; do not edit) poll');
  });

  it('installs configured poll launchd job with StartInterval', async () => {
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
          nightly: { enabled: false, time: '02:00' },
          poll: { enabled: true, intervalMinutes: 5, skipIfRunning: true }
        }
      }),
      schedule: '02:00',
      runCommand: runner,
      platform: 'darwin'
    });

    expect(scheduler.paths).toHaveLength(1);
    const bootoutCalls = runner.mock.calls.filter(([command, args]) => command === 'launchctl' && args[0] === 'bootout');
    expect(bootoutCalls).toHaveLength(3);
    const plist = await fs.readFile(scheduler.paths![0], 'utf8');
    expect(plist).toContain('<key>StartInterval</key><integer>300</integer>');
    expect(plist).toContain('<string>--trigger</string><string>watch</string>');
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
      schedule: '02:00',
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
