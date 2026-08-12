import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getKaizenHome } from './paths.js';
import { assertPrivateDirectory, ensurePrivateStructureDirectory } from './privateDirectory.js';
const MARKER_NAME = 'workspace-contents-untrusted';
export function workspaceContentsUntrustedMarker(stateDir) {
    return path.join(stateDir, MARKER_NAME);
}
export async function workspaceContentsAreUntrusted(stateDir) {
    if (!(await assertPrivateProjectStateDirectory(stateDir)))
        return false;
    const marker = workspaceContentsUntrustedMarker(stateDir);
    try {
        const stats = await fs.lstat(marker);
        assertRegularOwnedMarker(marker, stats);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export async function markWorkspaceContentsUntrusted(stateDir) {
    await ensurePrivateProjectStateDirectory(stateDir);
    const marker = workspaceContentsUntrustedMarker(stateDir);
    try {
        const existing = await fs.lstat(marker);
        assertRegularOwnedMarker(marker, existing);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const temporary = path.join(stateDir, `.${MARKER_NAME}.${process.pid}.${Date.now()}.tmp`);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
        try {
            await handle.writeFile(`${JSON.stringify({ detectedAt: new Date().toISOString() })}\n`);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fs.rename(temporary, marker);
    }
    catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
    }
}
export async function ensurePrivateProjectStateDirectory(stateDir) {
    for (const directory of projectStateHierarchy(stateDir)) {
        await ensurePrivateStructureDirectory(directory);
    }
}
async function assertPrivateProjectStateDirectory(stateDir) {
    for (const directory of projectStateHierarchy(stateDir)) {
        try {
            await assertPrivateDirectory(directory);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        }
    }
    return true;
}
function projectStateHierarchy(stateDir) {
    const home = path.resolve(getKaizenHome());
    const projects = path.join(home, 'projects');
    const resolvedState = path.resolve(stateDir);
    if (path.dirname(resolvedState) !== projects) {
        throw new Error(`Project state directory must be a direct child of ${projects}: ${stateDir}`);
    }
    return [home, projects, resolvedState];
}
export async function clearWorkspaceContentsUntrusted(stateDir) {
    await fs.rm(workspaceContentsUntrustedMarker(stateDir), { force: true });
}
function assertRegularOwnedMarker(marker, stats) {
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Workspace trust marker must be a regular file: ${marker}`);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stats.uid !== uid) {
        throw new Error(`Workspace trust marker is owned by a different user: ${marker}`);
    }
}
//# sourceMappingURL=workspaceTrust.js.map