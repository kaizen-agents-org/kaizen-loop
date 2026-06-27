import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAllowlistedEnv, runCommand } from '../src/utils/command.js';

describe('buildAllowlistedEnv', () => {
  it('copies only allowlisted variables plus explicit extras', () => {
    const env = buildAllowlistedEnv(
      {
        PATH: '/bin',
        SECRET_TOKEN: 'secret'
      },
      ['PATH'],
      {
        KAIZEN_WORKSPACE_DIR: '/workspace'
      }
    );

    expect(env).toEqual({
      PATH: '/bin',
      KAIZEN_WORKSPACE_DIR: '/workspace'
    });
  });
});

describe('runCommand', () => {
  it('terminates background child processes when a command times out', async () => {
    if (process.platform === 'win32') return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-command-'));
    const leakPath = path.join(dir, 'leaked');

    await expect(
      runCommand('sh', ['-lc', `(sleep 0.3; echo leaked > ${JSON.stringify(leakPath)}) & wait`], {
        timeoutMs: 50
      })
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(fs.access(leakPath)).rejects.toThrow();
  });
});
