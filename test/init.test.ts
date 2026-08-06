import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initProject } from '../src/init/init.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('initProject', () => {
  it('requires publication auth before writing project state', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-init-'));
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: repo,
      exitCode: 0,
      stdout: args.join(' ') === 'rev-parse --show-toplevel'
        ? `${repo}\n`
        : args.join(' ') === 'remote get-url origin'
          ? 'https://github.com/o/r.git\n'
          : '',
      stderr: '',
      durationMs: 1
    }));

    const error = await initProject({
      cwd: repo,
      schedule: '02:00',
      yes: false,
      runCommand: runner
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ exitCode: 2 });
    expect(String(error)).toContain('GH_TOKEN or GITHUB_TOKEN');
    await expect(fs.access(path.join(repo, '.kaizen', 'config.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runner.mock.calls.some(([command, args]) => command === 'gh' && args[0] === 'label')).toBe(false);
  });
});
