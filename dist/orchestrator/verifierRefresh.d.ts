import type { KaizenConfig } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';
export declare function refreshCanonicalVerifier(options: {
    config: KaizenConfig;
    expectedCommit: string;
    previousPackageRoot: string;
    runCommand: CommandRunner;
}): Promise<{
    packageRoot: string;
}>;
export declare function rollbackVerifierLink(options: {
    currentPackageRoot: string;
    previousPackageRoot: string;
    runCommand: CommandRunner;
}): Promise<void>;
