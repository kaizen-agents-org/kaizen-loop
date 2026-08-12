import fs from 'node:fs/promises';
import path from 'node:path';
const MARKER_NAME = 'workspace-contents-untrusted';
export function workspaceContentsUntrustedMarker(stateDir) {
    return path.join(stateDir, MARKER_NAME);
}
export async function workspaceContentsAreUntrusted(stateDir) {
    try {
        await fs.access(workspaceContentsUntrustedMarker(stateDir));
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export async function markWorkspaceContentsUntrusted(stateDir) {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(workspaceContentsUntrustedMarker(stateDir), `${JSON.stringify({ detectedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}
export async function clearWorkspaceContentsUntrusted(stateDir) {
    await fs.rm(workspaceContentsUntrustedMarker(stateDir), { force: true });
}
//# sourceMappingURL=workspaceTrust.js.map