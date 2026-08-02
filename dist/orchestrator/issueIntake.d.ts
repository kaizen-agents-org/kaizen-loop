import type { GitHubIssue, GitHubPullRequest } from '../github/types.js';
export type IssueIntakeDecisionStatus = 'proceed' | 'needs_human' | 'needs_context' | 'upstream_first' | 'not_improvement' | 'already_resolved';
export interface IssueIntakeDecision {
    status: IssueIntakeDecisionStatus;
    reason: string;
    evidence: string[];
}
export declare function hasIssueIntakeDecisionComment(issue: GitHubIssue, status: IssueIntakeDecisionStatus): boolean;
export declare function evaluateIssueIntake(options: {
    issue: GitHubIssue;
    repo: string;
    openPullRequests: GitHubPullRequest[];
}): IssueIntakeDecision;
export declare function buildIssueIntakeComment(runId: string, decision: IssueIntakeDecision): string;
