import type { KaizenConfig } from './schema.js';
export type BuilderProvider = 'claude' | 'codex';
export type RunnerProvider = 'local' | 'github-actions' | 'codex-automation' | 'claude-routine' | 'cursor' | 'external';
export interface NormalizedExecutionConfig {
    runner: {
        provider: RunnerProvider;
    };
    builder: {
        primary: {
            provider: BuilderProvider;
            model: string | null;
        };
        fallback: {
            provider: BuilderProvider;
            model: string | null;
        } | null;
    };
    legacy: boolean;
}
export declare function executionConfig(config: KaizenConfig): NormalizedExecutionConfig;
export declare function migrateLegacyExecutionConfig(config: Record<string, unknown>): boolean;
export declare function assertRunnerSupportedForLocalSync(config: KaizenConfig): void;
