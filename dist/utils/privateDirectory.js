import fs from 'node:fs/promises';
const PRIVATE_DIRECTORY_MODE = 0o700;
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
        throw new Error(`Private workspace path must be a real directory: ${directory}`);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && before.uid !== uid) {
        throw new Error(`Private workspace path is owned by a different user: ${directory}`);
    }
    if (process.platform === 'win32')
        return;
    if (repairMode)
        await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
    const after = await fs.lstat(directory);
    if (!after.isDirectory() ||
        after.isSymbolicLink() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        (uid !== undefined && after.uid !== uid)) {
        throw new Error(`Private workspace path changed while it was being validated: ${directory}`);
    }
    if ((after.mode & 0o077) !== 0) {
        throw new Error(`Private workspace path must have mode 0700: ${directory}`);
    }
}
//# sourceMappingURL=privateDirectory.js.map