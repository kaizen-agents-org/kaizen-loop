export declare function workspaceContentsUntrustedMarker(stateDir: string): string;
export declare function workspaceContentsAreUntrusted(stateDir: string): Promise<boolean>;
export declare function markWorkspaceContentsUntrusted(stateDir: string): Promise<void>;
export declare function ensurePrivateProjectStateDirectory(stateDir: string): Promise<{
    contentsMayHaveBeenExposed: boolean;
}>;
export declare function clearWorkspaceContentsUntrusted(stateDir: string): Promise<void>;
