import type { KaizenConfig } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';
import { RunLock } from './lock.js';
export declare function refreshCanonicalVerifier(options: {
    config: KaizenConfig;
    expectedCommit: string;
    previousPackageRoot: string;
    runCommand: CommandRunner;
}): Promise<CanonicalVerifierRefresh>;
export declare class CanonicalVerifierRefresh {
    readonly packageRoot: string;
    private readonly previousPackageRoot;
    private readonly globalLink;
    private readonly lock;
    private released;
    constructor(packageRoot: string, previousPackageRoot: string, globalLink: string, lock: RunLock);
    rollback(): Promise<void>;
    release(): Promise<void>;
}
