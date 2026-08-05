import type { AgentResult } from '../agents/types.js';
import type { GitHubPullRequest } from '../github/types.js';
export interface ResultCommentOptions {
    runId: string;
    issue: number;
    attempt: number;
    outcome: 'direct-commit' | 'pr-created' | 'already-fixed' | 'failed' | 'blocked' | 'skipped' | 'infrastructure-failure';
    agent: string;
    summary: string;
    notes?: string;
    verifyResults?: Array<{
        command: string;
        ok: boolean;
    }>;
    prUrl?: string;
    commit?: string;
    reason?: string;
    trigger?: string;
    maxAttempts: number;
    blockDisposition?: 'human-input-required' | 'retryable' | 'blocked' | 'attempts-exhausted';
    resumeBranch?: string;
    checkpointPublished?: boolean;
}
export declare function buildResultComment(options: ResultCommentOptions): string;
export declare function buildPrProgressComment(options: {
    runId: string;
    issue: number;
    attempt: number;
    prUrl: string;
    trigger?: string;
}): string;
export declare function countAttempts(comments: Array<{
    body: string;
}>): number;
export declare function hasRetryableExternalBlock(comments: Array<{
    body: string;
}>): boolean;
export declare function countConsecutiveRetryableBlocks(comments: Array<{
    body: string;
}>): number;
export declare function hasPendingPullRequest(comments: Array<{
    body: string;
}>, openPullRequests?: GitHubPullRequest[]): boolean;
export declare function markedPullRequestNumbers(comments: Array<{
    body: string;
}>): number[];
export declare function agentSummary(result: AgentResult): string;
