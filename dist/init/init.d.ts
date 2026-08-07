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
