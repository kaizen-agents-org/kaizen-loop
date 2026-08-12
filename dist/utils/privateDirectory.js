import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
const PRIVATE_DIRECTORY_MODE = 0o700;
const execFileAsync = promisify(execFile);
export async function ensurePrivateDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await validatePrivateDirectory(directory, true);
}
export async function assertPrivateDirectory(directory) {
    await validatePrivateDirectory(directory, false);
}
async function validatePrivateDirectory(directory, repairMode) {
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error(`Private directory path must be a real directory: ${directory}`);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && before.uid !== uid) {
        throw new Error(`Private directory path is owned by a different user: ${directory}`);
    }
    if (process.platform === 'win32')
        return;
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
        if ((secured.mode & 0o077) !== 0) {
            throw new Error(`Private directory path must have mode 0700: ${directory}`);
        }
    }
    finally {
        await handle.close();
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
    const { stdout } = await execFileAsync('/bin/ls', ['-lde', directory], { encoding: 'utf8' });
    if (String(stdout).split('\n').slice(1).some((line) => /^\s*\d+:/.test(line))) {
        throw new Error(`Private directory path must not grant access through an extended ACL: ${directory}`);
    }
}
//# sourceMappingURL=privateDirectory.js.map