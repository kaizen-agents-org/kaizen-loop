export interface RunDiscoveredFollowupSummary {
    title: string;
    repo: string;
    status: 'created' | 'duplicate';
    url?: string;
}
export interface RunIssueSummary {
    number: number;
    title: string;
    priority?: string;
    agent?: string;
    attempt?: number;
    outcome: 'direct-commit' | 'pr-created' | 'failed' | 'blocked' | 'skipped' | 'infrastructure-failure';
    branch?: string;
    commit?: string;
    pr?: number;
    prUrl?: string;
    guardian?: {
        status: 'success' | 'failed' | 'skipped' | 'queued';
        summary: string;
        jobId?: string;
    };
    reason?: string;
    changedFiles?: number;
    changedLines?: number;
    verifyRetries?: number;
    durationMs?: number;
    discoveredFollowups?: RunDiscoveredFollowupSummary[];
}
export interface RunQueueSummary {
    backlogCount: number;
    eligibleCount: number;
    processedCount: number;
    skipReasons: Array<{
        reason: string;
        count: number;
    }>;
    health: {
        state: 'healthy' | 'idle' | 'degraded' | 'starved' | 'blocked';
        consecutiveZeroThroughputRuns: number;
        reasonCode?: 'run_failed' | 'eligible_not_processed' | 'repeated_gate' | 'empty_queue';
        since?: string;
        warning?: string;
    };
}
export interface RunSummary {
    version: 1;
    project: string;
    startedAt: string;
    finishedAt: string;
    trigger: string;
    result: 'success' | 'failed' | 'partial';
    issues: RunIssueSummary[];
    skipped: Array<{
        number: number;
        reason: string;
    }>;
    queue?: RunQueueSummary;
}
export declare function summarizeQueue(options: {
    backlogCount: number;
    eligibleCount: number;
    processedCount: number;
    result: RunSummary['result'];
    skipped: Array<{
        number: number;
        reason: string;
    }>;
    previousSummaries: RunSummary[];
    starvationRuns: number;
    observedAt: string;
}): RunQueueSummary;
