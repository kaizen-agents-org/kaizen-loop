import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { enableScheduler } from '../src/scheduler/scheduler.js';
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
      schedule: '02:00',
      runCommand: runner,
      platform: 'linux'
    });

    await expect(fs.access(path.join(home, 'projects', 'owner-repo'))).resolves.toBeUndefined();
  });
});
