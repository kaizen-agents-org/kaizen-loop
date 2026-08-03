import { type VerifierRuntimeInfo } from './verifier.js';
import type { KaizenConfig } from '../config/schema.js';
import { type CommandRunner } from '../utils/command.js';
export declare function assertVerifierRuntimeFresh(config: KaizenConfig, runCommand: CommandRunner, expectedCommitOverride?: string): Promise<{
    runtime: Extract<VerifierRuntimeInfo, {
        protocol: 'structured';
    }>;
    expectedCommit: string;
}>;
export declare function resolveExpectedVerifierCommit(options: {
    config: KaizenConfig;
    runCommand: CommandRunner;
}): Promise<string>;
