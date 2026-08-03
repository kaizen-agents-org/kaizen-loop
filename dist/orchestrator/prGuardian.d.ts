import type { KaizenConfig } from '../config/schema.js';
import type { GitHubPullRequest } from '../github/types.js';
import { type CommandRunner } from '../utils/command.js';
export declare const MANAGED_PR_GUARDIAN_MARKER = "<!-- kaizen-pr-guardian:managed -->";
export interface PrGuardianSkillRequest {
    config: KaizenConfig;
    workspaceDir: string;
    repo: string;
    prUrl: string;
    prNumber: number;
    branch: string;
    baseBranch: string;
    runDeadlineAt?: number;
}
export type PrGuardianJobStatus = 'pending' | 'running' | 'success' | 'blocked' | 'skipped';
export interface PrGuardianJob {
    version: 1;
    id: string;
    repo: string;
    prUrl: string;
    prNumber: number;
    issueNumber?: number;
    branch: string;
    baseBranch: string;
    headSha: string;
    retryBudget: number;
    attemptCount: number;
    status: PrGuardianJobStatus;
    createdAt: string;
    updatedAt: string;
    lastCheckedAt?: string;
    lastBlocker?: string;
    reactivationCount?: number;
    lastObservedFingerprint?: string;
}
export interface PrGuardianSkillResult {
    status: 'success' | 'failed' | 'skipped' | 'queued';
    summary: string;
    raw: string;
    durationMs: number;
    jobId?: string;
    activityFingerprint?: string;
    headRefOid?: string;
}
export declare function guardianJobsDir(stateDir: string): string;
export declare function enqueuePrGuardianJob(options: {
    stateDir: string;
    config: KaizenConfig;
    repo: string;
    prUrl: string;
    prNumber: number;
    issueNumber?: number;
    branch: string;
    baseBranch: string;
    headSha: string;
}): Promise<PrGuardianJob>;
export declare function enqueueManagedPrGuardianJobs(options: {
    stateDir: string;
    config: KaizenConfig;
    repo: string;
    pullRequests: GitHubPullRequest[];
}): Promise<PrGuardianJob[]>;
export declare function listPrGuardianJobs(stateDir: string): Promise<PrGuardianJob[]>;
export declare function findPrGuardianJob(stateDir: string, pr: number): Promise<PrGuardianJob | undefined>;
export declare function runPrGuardianJob(options: {
    stateDir: string;
    config: KaizenConfig;
    workspaceDir: string;
    runCommand: CommandRunner;
    job: PrGuardianJob;
    isolateWorktree?: boolean;
}): Promise<PrGuardianJob>;
export declare function runPendingPrGuardianJobs(options: {
    stateDir: string;
    config: KaizenConfig;
    workspaceDir: string;
    runCommand: CommandRunner;
    isolateWorktree?: boolean;
}): Promise<PrGuardianJob[]>;
export declare function runPrGuardianSkill(runCommand: CommandRunner, req: PrGuardianSkillRequest): Promise<PrGuardianSkillResult>;
export declare function isPrGuardianSkillRunnerAvailable(config: KaizenConfig, runCommand: CommandRunner): Promise<boolean>;
