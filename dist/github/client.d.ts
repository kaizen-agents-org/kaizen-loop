import { type CommandRunner } from '../utils/command.js';
import type { GitHubIssue, GitHubLabelEvent, GitHubPullRequest, GitHubPullRequestDetails, GitHubPullRequestLinkage, GitHubPullRequestResolution, PullRequestResult } from './types.js';
export declare const KAIZEN_LABELS: string[];
export type RepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin';
export interface ExecutionAuthorization {
    authorized: boolean;
    actor?: string;
    permission?: RepositoryPermission;
    reason: string;
}
export declare class GitHubClient {
    private readonly run;
    private readonly cwd;
    constructor(run: CommandRunner, cwd: string);
    authStatus(): Promise<void>;
    createLabels(labels?: string[]): Promise<void>;
    listIssues(labels: string | string[], limit?: number): Promise<GitHubIssue[]>;
    getIssue(number: number): Promise<GitHubIssue>;
    getIssueLabelEvents(repo: string, issue: number, label: string): Promise<GitHubLabelEvent[]>;
    checkExecutionAuthorization(options: {
        repo: string;
        issue: number;
        label: string;
        minimumPermission: Exclude<RepositoryPermission, 'none' | 'read'>;
    }): Promise<ExecutionAuthorization>;
    listOpenPullRequests(limit?: number): Promise<GitHubPullRequest[]>;
    listAllOpenPullRequests(): Promise<GitHubPullRequest[]>;
    searchOpenPullRequestsForOwner(owner: string, limit?: number): Promise<GitHubPullRequest[]>;
    searchMergedPullRequestsForOwner(owner: string, mergedSince: string, limit?: number): Promise<GitHubPullRequest[]>;
    private completePullRequestCommits;
    getPullRequest(number: number): Promise<GitHubPullRequestDetails>;
    getRepositoryDefaultBranch(): Promise<string>;
    getBranchHeadSha(repo: string, branch: string): Promise<string>;
    getPullRequestLinkage(number: number): Promise<GitHubPullRequestLinkage>;
    getPullRequestResolution(number: number): Promise<GitHubPullRequestResolution>;
    addLabels(issue: number, labels: string[]): Promise<void>;
    removeLabels(issue: number, labels: string[]): Promise<void>;
    comment(issue: number, body: string): Promise<void>;
    findOpenIssueByTitle(options: {
        repo?: string;
        title: string;
        body?: string;
        evidence?: string;
        failureClass?: string;
    }): Promise<GitHubIssue | undefined>;
    findOpenIssueByBodyMarker(marker: string): Promise<GitHubIssue | undefined>;
    findOpenIssuesByBodyMarker(marker: string): Promise<GitHubIssue[]>;
    createIssue(options: {
        title: string;
        body: string;
        labels: string[];
        requiredLabels?: string[];
        repo?: string;
    }): Promise<GitHubIssue>;
    closeIssue(issue: number, comment?: string): Promise<void>;
    createPullRequest(options: {
        base: string;
        head: string;
        title: string;
        body: string;
        expectedClosingIssueNumber: number;
        draft?: boolean;
    }): Promise<PullRequestResult>;
    private waitForCreatedPullRequestLinkage;
    editPullRequest(number: number, options: {
        title: string;
        body: string;
    }): Promise<void>;
    markPullRequestReady(number: number): Promise<void>;
    markPullRequestDraft(number: number): Promise<void>;
    private gh;
}
export declare class CreatedPullRequestValidationError extends Error {
    readonly pr: PullRequestResult;
    readonly originalError: unknown;
    constructor(pr: PullRequestResult, originalError: unknown);
}
