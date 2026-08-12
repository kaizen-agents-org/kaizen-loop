import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
const PRIVATE_DIRECTORY_MODE = 0o700;
const execFileAsync = promisify(execFile);
export async function ensurePrivateDirectory(directory, options = {}) {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    return validatePrivateDirectory(directory, true, options.beforeExposureRepair);
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
        (process.platform === 'darwin' && await hasExtendedAcl(directory));
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    assertSameDirectory(directory, before, await fs.lstat(directory), uid);
    return exposed;
}
async function validatePrivateDirectory(directory, repairMode, beforeExposureRepair) {
    const before = await fs.lstat(directory);
    assertOwnedRealDirectory(directory, before);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (process.platform === 'win32')
        return { contentsMayHaveBeenExposed: false };
    const contentsMayHaveBeenExposed = (before.mode & 0o077) !== 0 ||
        (process.platform === 'darwin' && await hasExtendedAcl(directory));
    if (repairMode && contentsMayHaveBeenExposed)
        await beforeExposureRepair?.();
    if (!repairMode && (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw new Error(`Private directory path must have mode 0700: ${directory}`);
    }
    if (repairMode && (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        if (process.platform === 'darwin')
            await execFileAsync('/bin/chmod', ['-h', '700', directory]);
        else
            await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
        assertSameDirectory(directory, before, await fs.lstat(directory), uid);
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(directory, constants.O_RDONLY | noFollow);
    try {
        const opened = await handle.stat();
        assertSameDirectory(directory, before, opened, uid);
        if (repairMode) {
            if (process.platform === 'darwin') {
                await execFileAsync('/bin/chmod', ['-h', '-N', directory]);
            }
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
    }
    finally {
        await handle.close();
    }
    return { contentsMayHaveBeenExposed };
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
    const { stdout } = await execFileAsync('/bin/ls', ['-lde', directory], { encoding: 'utf8' });
    return String(stdout).split('\n').slice(1).some((line) => /^\s*\d+:/.test(line));
}
//# sourceMappingURL=privateDirectory.js.map