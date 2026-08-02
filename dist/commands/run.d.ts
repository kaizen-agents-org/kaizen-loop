import { type RunOptions } from '../orchestrator/run.js';
export declare function executeRun(options: RunOptions): Promise<import("../index.js").RunSummary | {
    selected: import("../index.js").GitHubIssue[];
    skipped: Array<{
        number: number;
        reason: string;
    }>;
} | import("./smoke.js").SandboxSmokeArtifact>;
