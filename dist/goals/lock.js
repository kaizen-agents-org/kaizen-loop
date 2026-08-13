import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';
export class GoalLock {
    lockPath;
    identity;
    constructor(lockPath, identity) {
        this.lockPath = lockPath;
        this.identity = identity;
    }
    static async acquire(goalDir) {
        await fs.mkdir(goalDir, { recursive: true });
        const lockPath = path.join(goalDir, 'goal.lock');
        const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
        try {
            const handle = await fs.open(lockPath, 'wx');
            try {
                await handle.writeFile(content);
            }
            finally {
                await handle.close();
            }
            const stats = await fs.lstat(lockPath);
            return new GoalLock(lockPath, { dev: stats.dev, ino: stats.ino });
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            if (await isStale(lockPath)) {
                await fs.rm(lockPath, { force: true });
                return GoalLock.acquire(goalDir);
            }
            throw new ConfigError(`Kaizen goal is already active: ${lockPath}`);
        }
    }
    async assertHeld() {
        const stats = await fs.lstat(this.lockPath).catch((error) => {
            if (error.code === 'ENOENT') {
                throw new Error(`Kaizen goal lock disappeared while the goal was running: ${this.lockPath}`);
            }
            throw error;
        });
        if (!stats.isFile() || stats.isSymbolicLink() || stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) {
            throw new Error(`Kaizen goal lock changed while the goal was running: ${this.lockPath}`);
        }
    }
    async release() {
        try {
            await this.assertHeld();
        }
        catch {
            return;
        }
        await fs.rm(this.lockPath);
    }
}
async function isStale(lockPath) {
    try {
        const raw = await fs.readFile(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed.pid)
            return true;
        try {
            process.kill(parsed.pid, 0);
            return false;
        }
        catch {
            return true;
        }
    }
    catch {
        return true;
    }
}
//# sourceMappingURL=lock.js.map