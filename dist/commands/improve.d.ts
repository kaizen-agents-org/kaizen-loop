import { type DirectCommitConfirmation } from '../orchestrator/run.js';
import type { IssueSelection } from '../orchestrator/issues.js';
import type { RunSummary } from '../orchestrator/summary.js';
import type { CommandRunner } from '../utils/command.js';
export interface ImproveOptions {
    cwd: string;
    project?: string;
    issueNumbers?: number[];
    dryRun: boolean;
    maxIssues?: number;
    agent?: 'claude' | 'codex';
    json: boolean;
    confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
    runCommand: CommandRunner;
}
export declare function planImprove(options: ImproveOptions): Promise<IssueSelection>;
export declare function runImprove(options: ImproveOptions): Promise<RunSummary | IssueSelection>;
