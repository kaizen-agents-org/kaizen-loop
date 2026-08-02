import os from 'node:os';
import path from 'node:path';
export function getKaizenHome() {
    return process.env.KAIZEN_HOME ?? path.join(os.homedir(), '.kaizen');
}
export function registryPath() {
    return path.join(getKaizenHome(), 'registry.json');
}
export function projectStateDir(slug) {
    return path.join(getKaizenHome(), 'projects', slug);
}
export function workspaceDir(slug) {
    return path.join(getKaizenHome(), 'workspaces', slug);
}
//# sourceMappingURL=paths.js.map