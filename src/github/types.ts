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
