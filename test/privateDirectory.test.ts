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
    await fs.chmod(root, 0o600);

    await expect(assertPrivateDirectory(root)).rejects.toThrow('mode 0700');

    const repair = await ensurePrivateDirectory(root);
    expect(repair.contentsMayHaveBeenExposed).toBe(false);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform !== 'win32')('does not chmod a replacement path during exposure repair', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-private-swap-'));
    const directory = path.join(parent, 'workspace');
    const original = path.join(parent, 'original');
    await fs.mkdir(directory);
    await fs.chmod(directory, 0o755);

    await expect(ensurePrivateDirectory(directory, {
      beforeExposureRepair: async () => {
        await fs.rename(directory, original);
        await fs.mkdir(directory);
        await fs.chmod(directory, 0o777);
      }
    })).rejects.toThrow('changed while it was being validated');

    expect((await fs.stat(original)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o777);
  });

  it.runIf(process.platform === 'darwin')('rejects extended ACL grants without mutating them by pathname', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-private-acl-'));
    await fs.chmod(root, 0o700);
    await execFileAsync('/bin/chmod', [
      '+a',
      'everyone allow list,search,readattr,readextattr,readsecurity',
      root
    ]);

    await expect(assertPrivateDirectory(root)).rejects.toThrow('extended ACL');

    await expect(ensurePrivateDirectory(root, { beforeExposureRepair: async () => undefined }))
      .rejects.toThrow('extended ACL');
    await expect(assertPrivateDirectory(root)).rejects.toThrow('extended ACL');
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === 'darwin')('rejects a deny-only ACL without mutating the directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-private-deny-acl-'));
    const sentinel = path.join(root, 'sentinel');
    await fs.writeFile(sentinel, 'preserve');
    await fs.chmod(root, 0o700);
    await execFileAsync('/bin/chmod', ['+a', 'everyone deny delete', root]);

    await expect(assertPrivateDirectory(root)).rejects.toThrow('extended ACL');

    await expect(ensurePrivateDirectory(root)).rejects.toThrow('extended ACL');
    await expect(assertPrivateDirectory(root)).rejects.toThrow('extended ACL');
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('preserve');
  });
});
