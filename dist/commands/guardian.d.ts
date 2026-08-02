import { type PrGuardianJob } from '../orchestrator/prGuardian.js';
import type { CommandRunner } from '../utils/command.js';
export declare function listGuardianJobs(options: {
    cwd: string;
    project?: string;
}): Promise<{
    jobs: PrGuardianJob[];
}>;
export declare function runGuardianForPullRequest(options: {
    cwd: string;
    project?: string;
    pr: number;
    runCommand: CommandRunner;
}): Promise<PrGuardianJob>;
export declare function watchGuardianJobs(options: {
    cwd: string;
    project?: string;
    runCommand: CommandRunner;
}): Promise<{
    jobs: PrGuardianJob[];
}>;
