import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { assertPrivateDirectory, ensurePrivateDirectory } from '../src/utils/privateDirectory.js';

const execFileAsync = promisify(execFile);

describe('private directory validation', () => {
  it.runIf(process.platform !== 'win32')('rejects owner permission sets weaker than 0700', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-private-mode-'));
    await fs.chmod(root, 0o000);

    await expect(assertPrivateDirectory(root)).rejects.toThrow('mode 0700');

    await ensurePrivateDirectory(root);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === 'darwin')('rejects extended ACL grants and removes them during repair', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-private-acl-'));
    await fs.chmod(root, 0o700);
    await execFileAsync('/bin/chmod', [
      '+a',
      'everyone allow list,search,readattr,readextattr,readsecurity',
      root
    ]);

    await expect(assertPrivateDirectory(root)).rejects.toThrow('extended ACL');

    await ensurePrivateDirectory(root);

    await expect(assertPrivateDirectory(root)).resolves.toBeUndefined();
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  });
});
