export interface GitHubLabel {
  name: string;
  createdAt?: string;
}

export interface GitHubComment {
  body: string;
  createdAt?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: GitHubLabel[];
  createdAt: string;
  comments: GitHubComment[];
  url?: string;
}

export interface PullRequestResult {
  number?: number;
  url: string;
}

export interface GitHubPullRequest {
  number: number;
  isDraft?: boolean;
  body?: string;
  baseRefName?: string;
  headRefOid?: string;
  headRefName?: string;
  headRepositoryOwner?: { login?: string };
  author?: { login?: string; type?: string; is_bot?: boolean };
  repository?: { nameWithOwner?: string };
  createdAt?: string;
  url: string;
}

export interface GitHubPullRequestDetails extends GitHubPullRequest {
  baseRefName: string;
  headRefOid: string;
  isDraft?: boolean;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
}

export interface GitHubClosingIssueReference {
  number: number;
  url?: string;
}

export interface GitHubPullRequestLinkage {
  number: number;
  url: string;
  baseRefName: string;
  isDraft: boolean;
  closingIssuesReferences: GitHubClosingIssueReference[];
}

export interface GitHubPullRequestResolution {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string | null;
  baseRefName?: string;
  closingIssuesReferences: GitHubClosingIssueReference[];
}
