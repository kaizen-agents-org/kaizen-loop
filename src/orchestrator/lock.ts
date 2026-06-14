import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';

export class RunLock {
  private constructor(private readonly lockPath: string) {}

  static async acquire(projectDir: string): Promise<RunLock> {
    await fs.mkdir(projectDir, { recursive: true });
    const lockPath = path.join(projectDir, 'run.lock');
    const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(content);
      await handle.close();
      return new RunLock(lockPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStale(lockPath)) {
        await fs.rm(lockPath, { force: true });
        return RunLock.acquire(projectDir);
      }
      throw new ConfigError(`Kaizen run is already active: ${lockPath}`);
    }
  }

  static isActiveError(error: unknown): boolean {
    return error instanceof ConfigError && error.message.startsWith('Kaizen run is already active:');
  }

  async release(): Promise<void> {
    await fs.rm(this.lockPath, { force: true });
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number };
    if (!parsed.pid) return true;
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}
