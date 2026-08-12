import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateDirectory, ensurePrivateStructureDirectory } from './privateDirectory.js';

const MARKER_NAME = 'workspace-contents-untrusted';

export function workspaceContentsUntrustedMarker(stateDir: string): string {
  return path.join(stateDir, MARKER_NAME);
}

export async function workspaceContentsAreUntrusted(stateDir: string): Promise<boolean> {
  try {
    await assertPrivateDirectory(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    await fs.access(workspaceContentsUntrustedMarker(stateDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function markWorkspaceContentsUntrusted(stateDir: string): Promise<void> {
  await ensurePrivateStructureDirectory(stateDir);
  await fs.writeFile(
    workspaceContentsUntrustedMarker(stateDir),
    `${JSON.stringify({ detectedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
}

export async function clearWorkspaceContentsUntrusted(stateDir: string): Promise<void> {
  await fs.rm(workspaceContentsUntrustedMarker(stateDir), { force: true });
}
