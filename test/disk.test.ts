import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertMinFreeDisk } from '../src/utils/disk.js';

describe('assertMinFreeDisk', () => {
  it('checks the nearest existing parent for missing workspace paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-disk-'));

    await expect(assertMinFreeDisk(path.join(root, 'missing', 'workspace'), 1)).resolves.toBeUndefined();
  });

  it('fails when the configured minimum exceeds available disk space', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-disk-'));

    await expect(assertMinFreeDisk(root, Number.MAX_SAFE_INTEGER)).rejects.toThrow('Insufficient free disk space');
  });

  it('does not walk past permission-denied ancestors', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-disk-'));
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o000);

    try {
      await expect(assertMinFreeDisk(path.join(locked, 'workspace'), 1)).rejects.toMatchObject({
        code: expect.stringMatching(/EACCES|EPERM/)
      });
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });
});
