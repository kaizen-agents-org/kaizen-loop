import type { GitHubPullRequest } from '../github/types.js';
export interface GeneratedPullRequestBacklog {
    repository: number;
    organization: number;
    limit: number;
    exceeded: boolean;
    oldestGeneratedPullRequestCreatedAt?: string;
    oldestGeneratedPullRequestAgeDays?: number;
}
export declare const GENERATED_PULL_REQUEST_FETCH_LIMIT = 1000;
export declare function summarizeGeneratedPullRequestBacklog(options: {
    pullRequests: GitHubPullRequest[];
    repo: string;
    wipLimit: number;
}): GeneratedPullRequestBacklog;
export declare function generatedPullRequestWipLimitReason(backlog: GeneratedPullRequestBacklog): string;
export declare function isGeneratedPullRequest(pullRequest: GitHubPullRequest): boolean;
export declare function isSyncPullRequest(pullRequest: GitHubPullRequest): boolean;
