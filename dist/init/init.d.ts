import { type CommandRunner } from '../utils/command.js';
export interface InitOptions {
    cwd: string;
    agent?: 'claude' | 'codex';
    schedule: string;
    yes: boolean;
    profile?: string;
    profilesDir?: string;
    runCommand: CommandRunner;
}
export interface InitResult {
    slug: string;
    repo: string;
    configPath: string;
    profile?: string;
    safetyFloorCorrections: string[];
}
export declare function initProject(options: InitOptions): Promise<InitResult>;
export declare function createInitialConfig(options: {
    agent: 'claude' | 'codex';
    schedule?: string;
    setup: string | null;
    verify: string[];
}, kaizenHome?: string): Promise<Record<string, unknown>>;
export declare function readInstalledVerifierRef(kaizenHome?: string): Promise<string | undefined>;
