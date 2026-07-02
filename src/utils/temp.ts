import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function resolveKaizenTempDir(cwd?: string, env: NodeJS.ProcessEnv = process.env): string {
  const scope = cwd ?? env.KAIZEN_HOME ?? 'default';
  const root = env.KAIZEN_TMPDIR ?? shortKaizenTempRoot();
  return path.join(root, `workspace-${hashTempScope(scope)}`);
}

export async function ensureKaizenTempDir(cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const tempDir = resolveKaizenTempDir(cwd, env);
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  await fs.chmod(tempDir, 0o700).catch(() => undefined);
  const probe = path.join(tempDir, `.kaizen-tmp-check-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, '');
  await fs.rm(probe, { force: true });
  return tempDir;
}

export async function envWithKaizenTemp(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string
): Promise<NodeJS.ProcessEnv> {
  const tempDir = await ensureKaizenTempDir(cwd, env);
  return {
    ...env,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir
  };
}

function shortKaizenTempRoot(): string {
  if (process.platform === 'win32') return path.join(os.tmpdir(), 'kaizen-loop');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join('/tmp', `kaizen-loop-${uid}`);
}

function hashTempScope(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 12);
}
