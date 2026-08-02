import { z } from 'zod';
import type { CommandRunner } from '../utils/command.js';
import { type RuntimeIdentity } from '../utils/runtime.js';
export interface FleetSyncOptions {
    cwd: string;
    root?: string;
    manifestPath?: string;
    owner?: string;
    repos?: string[];
    migrateConfig: boolean;
    ensureWorkspace: boolean;
    ensureLabels: boolean;
    syncScheduler: boolean;
    repairLocks: boolean;
    verify: boolean;
    prune: boolean;
    dryRun: boolean;
    runCommand: CommandRunner;
}
export interface FleetProjectResult {
    slug: string;
    repo: string;
    localPath: string;
    configMigrated: boolean;
    workspaceEnsured: boolean;
    labelsEnsured: boolean;
    schedulerSynced: boolean;
    lockRepaired: boolean;
    verified: boolean;
    setupResult?: {
        command: string;
        ok: boolean;
        output: string;
    };
    verifyPassed?: boolean;
    verifyResults?: Array<{
        command: string;
        ok: boolean;
        output: string;
    }>;
    enabled: boolean;
    error?: string;
}
export interface FleetSyncResult {
    runtime: RuntimeIdentity;
    root: string;
    owner?: string;
    dryRun: boolean;
    projects: FleetProjectResult[];
    pruned: string[];
}
export interface FleetRefreshStep {
    name: string;
    ok: boolean;
    command?: string;
    message?: string;
    output?: string;
}
export interface FleetRefreshProject {
    slug: string;
    repo: string;
    localPath: string;
    workspacePath: string;
    defaultBranch?: string;
    ok: boolean;
    steps: FleetRefreshStep[];
}
export interface FleetRefreshResult {
    runtime: RuntimeIdentity;
    ok: boolean;
    sync: boolean;
    projects: FleetRefreshProject[];
}
export declare function syncFleet(options: FleetSyncOptions): Promise<FleetSyncResult>;
export declare function fleetHasFailures(result: FleetSyncResult): boolean;
export declare function refreshFleet(options: {
    cwd: string;
    project?: string;
    sync?: boolean;
    runCommand: CommandRunner;
}): Promise<FleetRefreshResult>;
declare const fleetManifestSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    owner: z.ZodString;
    projects: z.ZodArray<z.ZodObject<{
        repo: z.ZodString;
        localPath: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
type FleetManifest = z.infer<typeof fleetManifestSchema>;
export declare function loadFleetManifest(filePath: string): Promise<FleetManifest>;
export declare function migrateLegacySchedulerConfig(config: Record<string, unknown>): boolean;
export {};
