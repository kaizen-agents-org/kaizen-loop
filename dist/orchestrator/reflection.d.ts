import type { KaizenConfig } from '../config/schema.js';
import type { DiffStats } from '../workspace/manager.js';
export type ReflectionAction = 'direct' | 'pr';
export interface ReflectionDecision {
    action: ReflectionAction;
    reason: string;
}
export declare function decideReflection(options: {
    config: KaizenConfig;
    labels: string[];
    diff: DiffStats;
    verifyConfigured: boolean;
}): ReflectionDecision;
