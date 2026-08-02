import { type DirectCommitConfirmation } from '../orchestrator/run.js';
import type { CommandRunner } from '../utils/command.js';
import type { RunLock } from '../orchestrator/lock.js';
export interface ReportIssueOptions {
    cwd: string;
    project?: string;
    title: string;
    body: string;
    priority?: 'P0' | 'P1' | 'P2';
    direct?: boolean;
    prOnly?: boolean;
    agent?: 'claude' | 'codex';
    queue?: boolean;
    extraLabels: string[];
    runCommand: CommandRunner;
}
export interface ReportIssueNowOptions extends ReportIssueOptions {
    json: boolean;
    assumeYes?: boolean;
    scheduled?: boolean;
    job?: string;
    existingLock?: RunLock;
    confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
}
export declare function reportIssue(options: ReportIssueOptions): Promise<import("../index.js").GitHubIssue>;
export declare function reportIssueNow(options: ReportIssueNowOptions): Promise<{
    issue: import("../index.js").GitHubIssue;
    fix: import("../index.js").RunSummary | {
        selected: import("../index.js").GitHubIssue[];
        skipped: Array<{
            number: number;
            reason: string;
        }>;
    };
}>;
