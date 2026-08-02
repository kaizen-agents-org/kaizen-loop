import { type Registry, type RegistryProject } from './schema.js';
export declare function loadRegistry(filePath?: string): Promise<Registry>;
export declare function saveRegistry(registry: Registry, filePath?: string): Promise<void>;
export declare function updateRegistry(update: (registry: Registry) => void | Promise<void>, filePath?: string): Promise<Registry>;
export declare function registryTransaction<T>(transact: (registry: Registry) => Promise<{
    registry?: Registry;
    value: T;
}>, filePath?: string, options?: {
    recoverInvalid?: boolean;
}): Promise<T>;
export declare function loadRegistryForRecovery(filePath?: string): Promise<Registry>;
export declare function upsertProject(slug: string, project: RegistryProject): Promise<Registry>;
export declare function findProjectByCwd(cwd: string): Promise<{
    slug: string;
    project: RegistryProject;
} | undefined>;
export declare function resolveProject(projectSlug: string | undefined, cwd: string): Promise<{
    slug: string;
    project: RegistryProject;
}>;
