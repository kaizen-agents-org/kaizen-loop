import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
const PRIVATE_DIRECTORY_MODE = 0o700;
const execFileAsync = promisify(execFile);
export async function ensurePrivateDirectory(directory, options = {}) {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    return validatePrivateDirectory(directory, true, options.beforeExposureRepair);
}
export async function ensurePrivateStructureDirectory(directory) {
    const existed = await pathExists(directory);
    await ensurePrivateDirectory(directory, existed ? {
        // Generated worktree parents contain no trusted repository state. Their
        // child target is removed before reuse, so legacy exposure can be repaired
        // without laundering a registered workspace.
        beforeExposureRepair: async () => undefined
    } : undefined);
}
export async function assertPrivateDirectory(directory) {
    await validatePrivateDirectory(directory, false);
}
export async function privateDirectoryContentsMayHaveBeenExposed(directory) {
    const before = await fs.lstat(directory);
    assertOwnedRealDirectory(directory, before);
    if (process.platform === 'win32')
        return false;
    const exposed = (before.mode & 0o077) !== 0 ||
        (process.platform === 'darwin' && await hasExposureGrantAcl(directory));
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    assertSameDirectory(directory, before, await fs.lstat(directory), uid);
    return exposed;
}
export async function privateDirectoryMayBeModifiedByOthers(directory) {
    const before = await fs.lstat(directory);
    assertOwnedRealDirectory(directory, before);
    if (process.platform === 'win32')
        return false;
    const modifiable = (before.mode & 0o022) !== 0 ||
        (process.platform === 'darwin' && await hasExposureGrantAcl(directory));
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    assertSameDirectory(directory, before, await fs.lstat(directory), uid);
    return modifiable;
}
async function validatePrivateDirectory(directory, repairMode, beforeExposureRepair) {
    const before = await fs.lstat(directory);
    assertOwnedRealDirectory(directory, before);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (process.platform === 'win32')
        return { contentsMayHaveBeenExposed: false };
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(directory, constants.O_RDONLY | noFollow);
    try {
        const opened = await handle.stat();
        assertSameDirectory(directory, before, opened, uid);
        const aclEntries = process.platform === 'darwin' ? await extendedAclEntries(directory) : [];
        assertSameDirectory(directory, before, await fs.lstat(directory), uid);
        const contentsMayHaveBeenExposed = (opened.mode & 0o077) !== 0 || aclEntriesGrantExposure(aclEntries);
        if (repairMode && contentsMayHaveBeenExposed) {
            if (!beforeExposureRepair) {
                throw new Error(`Refusing to repair an exposed private directory without a durable taint handler: ${directory}`);
            }
            await beforeExposureRepair();
            assertSameDirectory(directory, before, await fs.lstat(directory), uid);
        }
        if (aclEntries.length > 0) {
            throw new Error(`Private directory path must not grant access through an extended ACL: ${directory}`);
        }
        if (!repairMode && (opened.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
            throw new Error(`Private directory path must have mode 0700: ${directory}`);
        }
        if (repairMode) {
            await handle.chmod(PRIVATE_DIRECTORY_MODE);
        }
        if (process.platform === 'darwin')
            await assertNoExtendedAcl(directory);
        const after = await fs.lstat(directory);
        const secured = await handle.stat();
        assertSameDirectory(directory, before, after, uid);
        assertSameDirectory(directory, before, secured, uid);
        if ((secured.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
            throw new Error(`Private directory path must have mode 0700: ${directory}`);
        }
        return { contentsMayHaveBeenExposed };
    }
    finally {
        await handle.close();
    }
}
function assertOwnedRealDirectory(directory, stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Private directory path must be a real directory: ${directory}`);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stats.uid !== uid) {
        throw new Error(`Private directory path is owned by a different user: ${directory}`);
    }
}
function assertSameDirectory(directory, expected, actual, uid) {
    if (!actual.isDirectory() ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        (uid !== undefined && actual.uid !== uid)) {
        throw new Error(`Private directory path changed while it was being validated: ${directory}`);
    }
}
async function assertNoExtendedAcl(directory) {
    if (await hasExtendedAcl(directory)) {
        throw new Error(`Private directory path must not grant access through an extended ACL: ${directory}`);
    }
}
async function hasExtendedAcl(directory) {
    return (await extendedAclEntries(directory)).length > 0;
}
async function hasExposureGrantAcl(directory) {
    return aclEntriesGrantExposure(await extendedAclEntries(directory));
}
function aclEntriesGrantExposure(entries) {
    const owner = os.userInfo().username;
    return entries.some((entry) => {
        if (!/\ballow\b/.test(entry))
            return false;
        const user = entry.match(/^\s*\d+:\s+user:(\S+)\s+/);
        return user?.[1] !== owner;
    });
}
async function extendedAclEntries(directory) {
    const { stdout } = await execFileAsync('/bin/ls', ['-lde', directory], { encoding: 'utf8' });
    return String(stdout).split('\n').slice(1).filter((line) => /^\s*\d+:/.test(line));
}
async function pathExists(target) {
    try {
        await fs.lstat(target);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
//# sourceMappingURL=privateDirectory.js.map