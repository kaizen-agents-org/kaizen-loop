import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { ensurePrivateStructureDirectory } from '../utils/privateDirectory.js';
export class RunLock {
    lockPath;
    constructor(lockPath) {
        this.lockPath = lockPath;
    }
    static async acquire(projectDir) {
        await ensurePrivateStructureDirectory(projectDir);
        const lockPath = path.join(projectDir, 'run.lock');
        const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
        try {
            const handle = await fs.open(lockPath, 'wx');
            await handle.writeFile(content);
            await handle.close();
            return new RunLock(lockPath);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            if (await isStale(lockPath)) {
                await fs.rm(lockPath, { force: true });
                return RunLock.acquire(projectDir);
            }
            throw new ConfigError(`Kaizen run is already active: ${lockPath}`);
        }
    }
    static isActiveError(error) {
        return error instanceof ConfigError && error.message.startsWith('Kaizen run is already active:');
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