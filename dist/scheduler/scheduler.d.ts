import type { KaizenConfig, RegistryProject, SchedulerJobConfig } from '../config/schema.js';
import { type CommandRunner } from '../utils/command.js';
import { type LocalSchedulerProviderName } from './provider.js';
export interface SchedulerSyncResult {
    type: LocalSchedulerProviderName;
    path?: string;
    paths?: string[];
    jobs: SchedulerJob[];
    kaizenHome: string;
}
export interface SchedulerDisableResult {
    type: LocalSchedulerProviderName;
    path?: string;
    paths?: string[];
}
export declare function enableScheduler(options: {
    slug: string;
    project: RegistryProject;
    config: KaizenConfig;
    runCommand: CommandRunner;
    platform?: NodeJS.Platform;
    launcherTrust?: (launcher: string) => boolean;
}): Promise<SchedulerSyncResult>;
export declare function disableScheduler(options: {
    slug: string;
    runCommand: CommandRunner;
    terminateRunning?: boolean;
    platform?: NodeJS.Platform;
}): Promise<SchedulerDisableResult>;
export interface SchedulerJob {
    name: string;
    config: SchedulerJobConfig;
}
export declare function schedulerJobs(config: KaizenConfig): SchedulerJob[];
export declare function schedulerJob(config: KaizenConfig, jobName: string): SchedulerJob | undefined;
export declare function schedulerKaizenHome(): string;
export interface SchedulerLauncherStatus {
    scheduledLauncher: string | null;
    operatorLauncher: string | null;
    ready: boolean;
    error?: string;
}
export declare function schedulerLauncherStatus(options?: {
    required?: boolean;
    launcherTrust?: (launcher: string) => boolean;
}): Promise<SchedulerLauncherStatus>;
