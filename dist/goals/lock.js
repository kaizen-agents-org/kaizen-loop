import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';
export class GoalLock {
    lockPath;
    constructor(lockPath) {
        this.lockPath = lockPath;
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
            return new GoalLock(lockPath);
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
    async release() {
        await fs.rm(this.lockPath, { force: true });
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