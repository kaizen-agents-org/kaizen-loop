import type { KaizenConfig, RegistryProject } from './schema.js';
export interface OperationalConfig {
    config: KaizenConfig;
    source: 'local' | 'workspace';
    path: string;
}
export declare function loadOperationalConfig(project: RegistryProject, options: {
    preferWorkspace: boolean;
    requireWorkspace?: boolean;
}): Promise<OperationalConfig>;
export declare function configDrift(local: KaizenConfig, workspace: KaizenConfig, paths: {
    localPath: string;
    workspacePath: string;
}): {
    detected: boolean;
    localPath: string;
    workspacePath: string;
    message: string | undefined;
};
