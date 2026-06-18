import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';

export class GoalLock {
  private constructor(private readonly lockPath: string) {}

  static async acquire(goalDir: string): Promise<GoalLock> {
    await fs.mkdir(goalDir, { recursive: true });
    const lockPath = path.join(goalDir, 'goal.lock');
    const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(content);
      await handle.close();
      return new GoalLock(lockPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStale(lockPath)) {
        await fs.rm(lockPath, { force: true });
        return GoalLock.acquire(goalDir);
      }
      throw new ConfigError(`Kaizen goal is already active: ${lockPath}`);
    }
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
