import type { CommandRunner } from '../utils/command.js';
import { type ImplementationState } from '../orchestrator/implementationState.js';
import type { RunQueueSummary } from '../orchestrator/summary.js';
import { type GeneratedPullRequestBacklog } from '../orchestrator/wipLimit.js';
interface UnreviewedRemoteBranch {
    branch: string;
    remoteRef: string;
    headSha: string;
    ahead: number;
    behind: number;
}
interface OpenGeneratedPullRequestMetric {
    number: number;
    url: string;
    repository?: string;
    headRefName?: string;
    createdAt?: string;
    ageDays?: number;
    authorLogin?: string;
    authorType?: string;
}
interface MergedGeneratedPullRequestMetric {
    number: number;
    url: string;
    repository?: string;
    headRefName?: string;
    createdAt?: string;
    mergedAt?: string | null;
    authorLogin?: string;
    authorType?: string;
    commitCount?: number;
    commits: PullRequestCommitMetric[];
    humanOrNonAutomationFollowUpCommits: PullRequestCommitMetric[];
}
interface PullRequestCommitMetric {
    oid: string;
    committedDate?: string;
    authorName?: string;
    authorEmail?: string;
    authorLogin?: string;
    authorType?: string;
}
export declare function statusProject(options: {
    cwd: string;
    project?: string;
    metrics?: boolean;
    runCommand: CommandRunner;
}): Promise<{
    slug: string;
    repo: string;
    configuration: {
        source: "local" | "workspace";
        path: string;
    };
    pullRequestReconciliation: {
        merged: number[];
        unknown: number[];
    };
    enabled: boolean;
    schedule: string;
    lastRun: any;
    queue: RunQueueSummary | undefined;
    issues: {
        open: number;
        selectionMode: "auto" | "opt-in" | "manual-only";
        queued: number;
        p0: number;
        p1: number;
        p2: number;
        needsHuman: number;
        retryable: number;
        blocked: number;
        upstreamFirst: number;
        notActionable: number;
        attemptsExhausted: number;
    };
    pullRequests: {
        open: number;
    };
    guardian: {
        jobs: number;
        pending: number;
        running: number;
        success: number;
        blocked: number;
        skipped: number;
        stale: number;
        latest: import("../orchestrator/prGuardian.js").PrGuardianJob | undefined;
    };
    implementations: {
        jobs: number;
        active: number;
        needsAttention: number;
        stale: number;
        latest: ImplementationState | undefined;
        items: ImplementationState[];
    };
    branchHygiene: {
        checked: boolean;
        unreviewedRemoteBranches: UnreviewedRemoteBranch[];
        error?: string;
    };
    metrics: {
        readableRuns: number;
        unreadableRuns: number;
        reviewWindow: {
            sandboxSmoke: {
                runs: number;
                passed: number;
                failed: number;
                unreadable: number;
                latestRunAt: string | null;
                latestResult: string | null;
            };
            runs: number;
            processed: number;
            prCreated: number;
            directCommit: number;
            alreadyFixed: number;
            failed: number;
            infrastructureFailed: number;
            blocked: number;
            skipped: number;
            verificationFailed: number;
            verifierBlocked: number;
            verifierNeedsContext: number;
            verifierFailed: number;
            guardian: {
                eligible: number;
                success: number;
                failed: number;
                queued: number;
                skipped: number;
            };
            since: string;
            until: string;
        };
        wipLimit: GeneratedPullRequestBacklog | undefined;
        generatedPullRequests: {
            open: {
                count: number;
                sourcePullRequests: OpenGeneratedPullRequestMetric[];
            };
            reviewWindow: {
                since: string;
                until: string;
                merged: {
                    count: number;
                    humanEditFree: number;
                    humanOrNonAutomationFollowUp: number;
                    humanOrNonAutomationFollowUpCommits: number;
                    sourcePullRequests: MergedGeneratedPullRequestMetric[];
                };
            };
        } | undefined;
        runs: number;
        processed: number;
        prCreated: number;
        directCommit: number;
        alreadyFixed: number;
        failed: number;
        infrastructureFailed: number;
        blocked: number;
        skipped: number;
        verificationFailed: number;
        verifierBlocked: number;
        verifierNeedsContext: number;
        verifierFailed: number;
        guardian: {
            eligible: number;
            success: number;
            failed: number;
            queued: number;
            skipped: number;
        };
    } | undefined;
}>;
export declare function listProjects(): Promise<{
    health: {
        state: "blocked" | "healthy" | "degraded" | "starved";
        affectedRepositories: {
            slug: string;
            repo: string;
            state: "blocked" | "degraded" | "starved";
            since: string | undefined;
            warning: string | undefined;
            reasonCode: "run_failed" | "eligible_not_processed" | "repeated_gate" | "empty_queue" | undefined;
        }[];
        starvedRepositories: {
            slug: string;
            repo: string;
            since: string | undefined;
            warning: string | undefined;
        }[];
    };
    projects: {
        [k: string]: {
            readonly lastRun: any;
            readonly queueHealth: {
                state: "healthy" | "idle" | "degraded" | "starved" | "blocked";
                consecutiveZeroThroughputRuns: number;
                reasonCode?: "run_failed" | "eligible_not_processed" | "repeated_gate" | "empty_queue";
                since?: string;
                warning?: string;
            } | undefined;
            readonly repo: string;
            readonly localPath: string;
            readonly workspacePath: string;
            readonly schedule: string;
            readonly enabled: boolean;
            readonly createdAt: string;
        };
    };
    version: 1;
}>;
export {};
