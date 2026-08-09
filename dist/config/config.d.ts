import { type KaizenConfig } from './schema.js';
export declare function loadConfig(repoDir: string): Promise<KaizenConfig>;
export declare function defaultConfigYaml(options: {
    agent: 'claude' | 'codex';
    schedule?: string;
    setup: string | null;
    verify: string[];
}): string;
export declare function defaultConfigObject(options: {
    agent: 'claude' | 'codex';
    schedule?: string;
    setup: string | null;
    verify: string[];
    expectedVerifierRef?: string;
}): Record<string, unknown>;
