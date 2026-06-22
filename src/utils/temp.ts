import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function resolveKaizenTempDir(cwd?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.KAIZEN_TMPDIR) return env.KAIZEN_TMPDIR;
  if (cwd) return path.join(cwd, '.kaizen', 'tmp');
  if (env.KAIZEN_HOME) return path.join(env.KAIZEN_HOME, 'tmp');
  return os.tmpdir();
}

export async function ensureKaizenTempDir(cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const tempDir = resolveKaizenTempDir(cwd, env);
  await fs.mkdir(tempDir, { recursive: true });
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
