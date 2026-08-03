import type { KaizenConfig } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';
export declare function refreshCanonicalVerifier(options: {
    config: KaizenConfig;
    expectedCommit: string;
    runCommand: CommandRunner;
}): Promise<{
    packageRoot: string;
}>;
export declare function rollbackVerifierLink(options: {
    packageRoot: string;
    timeoutMinutes: number;
    runCommand: CommandRunner;
}): Promise<void>;
