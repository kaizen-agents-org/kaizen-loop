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
