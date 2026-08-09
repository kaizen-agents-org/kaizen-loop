import type { KaizenConfig } from '../config/schema.js';
import type { GitHubIssue, GitHubPullRequest } from '../github/types.js';
import { type CommandRunner } from '../utils/command.js';
import { type DiffStats } from '../workspace/manager.js';
import { RunLock } from './lock.js';
import { type ReflectionDecision } from './reflection.js';
import { type RunIssueSummary, type RunSummary } from './summary.js';
export interface RunOptions {
    cwd: string;
    project?: string;
    scheduled: boolean;
    trigger?: 'manual' | 'scheduled' | 'afternoon' | 'instant' | 'watch';
    job?: string;
    issue?: number;
    issueNumbers?: number[];
    dryRun: boolean;
    maxIssues?: number;
    agent?: 'claude' | 'codex';
    json: boolean;
    assumeYes?: boolean;
    confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<DirectCommitChoice>;
    existingLock?: RunLock;
    authorizationEventRetry?: {
        attempts: number;
        baseDelayMs: number;
    };
    runCommand: CommandRunner;
}
export type DirectCommitChoice = 'direct' | 'pr' | 'reject';
export interface DirectCommitConfirmation {
    issue: GitHubIssue;
    decision: ReflectionDecision;
    diff: DiffStats;
    verifyResults: Array<{
        command: string;
        ok: boolean;
        output: string;
    }>;
}
interface RunIssueSelection {
    selected: GitHubIssue[];
    skipped: Array<{
        number: number;
        reason: string;
    }>;
    backlogCount?: number;
    openPullRequests: GitHubPullRequest[];
    resumableIssueNumbers?: Set<number>;
    resumeBranches?: Set<string>;
    resumeBranchByIssue?: Map<number, string>;
}
export declare function runKaizen(options: RunOptions): Promise<RunSummary | {
    selected: GitHubIssue[];
    skipped: Array<{
        number: number;
        reason: string;
    }>;
}>;
export declare function preflightScheduledPublication(options: {
    scheduled: boolean;
    localPath: string;
    runCommand: CommandRunner;
}): Promise<void>;
export declare function preflightVerifier(options: {
    config: KaizenConfig;
    runCommand: CommandRunner;
    runDir: string;
}): Promise<string | undefined>;
export declare function applyImplementationBudget(selection: RunIssueSelection, maxIssues: number): RunIssueSelection;
export declare function selectPreferredBackends(config: KaizenConfig, issue: GitHubIssue, requested: 'claude' | 'codex' | undefined): Array<'claude' | 'codex'>;
export declare function resultFor(issues: RunIssueSummary[]): RunSummary['result'];
export {};
