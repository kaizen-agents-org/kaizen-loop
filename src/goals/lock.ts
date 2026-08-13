import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';

export class GoalLock {
  private constructor(
    private readonly lockPath: string,
    private readonly identity: { dev: number; ino: number }
  ) {}

  static async acquire(goalDir: string): Promise<GoalLock> {
    await fs.mkdir(goalDir, { recursive: true });
    const lockPath = path.join(goalDir, 'goal.lock');
    const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      const stats = await fs.lstat(lockPath);
      return new GoalLock(lockPath, { dev: stats.dev, ino: stats.ino });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStale(lockPath)) {
        await fs.rm(lockPath, { force: true });
        return GoalLock.acquire(goalDir);
      }
      throw new ConfigError(`Kaizen goal is already active: ${lockPath}`);
    }
  }

  async assertHeld(): Promise<void> {
    const stats = await fs.lstat(this.lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Kaizen goal lock disappeared while the goal was running: ${this.lockPath}`);
      }
      throw error;
    });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) {
      throw new Error(`Kaizen goal lock changed while the goal was running: ${this.lockPath}`);
    }
  }

  async release(): Promise<void> {
    try {
      await this.assertHeld();
    } catch {
      return;
    }
    await fs.rm(this.lockPath);
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
