import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  markWorkspaceContentsUntrusted,
  workspaceContentsAreUntrusted,
  workspaceContentsUntrustedMarker
} from '../src/utils/workspaceTrust.js';

describe('workspace trust marker', () => {
  it('writes an owner-only regular marker atomically', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-trust-state-'));

    await markWorkspaceContentsUntrusted(stateDir);

    const marker = workspaceContentsUntrustedMarker(stateDir);
    const stats = await fs.lstat(marker);
    expect(stats.isFile()).toBe(true);
    if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o600);
    await expect(workspaceContentsAreUntrusted(stateDir)).resolves.toBe(true);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlink marker without modifying its target', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-trust-symlink-'));
    const target = path.join(stateDir, 'target');
    await fs.writeFile(target, 'preserve');
    const marker = workspaceContentsUntrustedMarker(stateDir);
    await fs.symlink(target, marker);

    await expect(markWorkspaceContentsUntrusted(stateDir)).rejects.toThrow('regular file');

    await expect(fs.readFile(target, 'utf8')).resolves.toBe('preserve');
    expect((await fs.lstat(marker)).isSymbolicLink()).toBe(true);
    await expect(workspaceContentsAreUntrusted(stateDir)).rejects.toThrow('regular file');
  });
});
