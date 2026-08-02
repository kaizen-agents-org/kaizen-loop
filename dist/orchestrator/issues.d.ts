import type { KaizenConfig } from '../config/schema.js';
import type { GitHubIssue, GitHubPullRequest } from '../github/types.js';
export interface IssueSelection {
    selected: GitHubIssue[];
    skipped: Array<{
        number: number;
        reason: string;
    }>;
}
export declare function selectIssues(options: {
    issues: GitHubIssue[];
    config: KaizenConfig;
    maxIssues: number;
    onlyIssue?: number;
    explicit?: boolean;
    openPullRequests?: GitHubPullRequest[];
    now?: Date;
}): IssueSelection;
export declare function labelNames(issue: GitHubIssue): string[];
export declare function priorityLabel(issue: GitHubIssue, config: KaizenConfig): string | undefined;
