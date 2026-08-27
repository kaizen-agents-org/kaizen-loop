import type { KaizenConfig } from '../config/schema.js';
export type LocalSchedulerProviderName = 'launchd' | 'cron';
export declare function resolveLocalSchedulerProvider(config: KaizenConfig, platform?: NodeJS.Platform): LocalSchedulerProviderName;
