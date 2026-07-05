import type { GitHubPullRequest } from '../github/types.js';

export interface GeneratedPullRequestBacklog {
  repository: number;
  organization: number;
  limit: number;
  exceeded: boolean;
  oldestGeneratedPullRequestCreatedAt?: string;
  oldestGeneratedPullRequestAgeDays?: number;
}

export const GENERATED_PULL_REQUEST_FETCH_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeGeneratedPullRequestBacklog(options: {
  pullRequests: GitHubPullRequest[];
  repo: string;
  wipLimit: number;
}): GeneratedPullRequestBacklog {
  const generatedPullRequests = options.pullRequests.filter(isGeneratedPullRequest);
  const normalizedRepo = options.repo.toLowerCase();
  const organization = generatedPullRequests.length;
  const repository = generatedPullRequests.filter(
    (pullRequest) => pullRequest.repository?.nameWithOwner?.toLowerCase() === normalizedRepo
  ).length;
  const oldestGeneratedPullRequestCreatedAt = oldestPullRequestCreatedAt(generatedPullRequests);

  return {
    repository,
    organization,
    limit: options.wipLimit,
    exceeded: options.wipLimit === 0 || organization >= options.wipLimit,
    oldestGeneratedPullRequestCreatedAt,
    oldestGeneratedPullRequestAgeDays: oldestGeneratedPullRequestCreatedAt
      ? elapsedDaysSince(oldestGeneratedPullRequestCreatedAt)
      : undefined
  };
}

export function generatedPullRequestWipLimitReason(backlog: GeneratedPullRequestBacklog): string {
  return `generated pull request WIP limit reached (organization ${backlog.organization}/${backlog.limit}, repository ${backlog.repository})`;
}

export function isGeneratedPullRequest(pullRequest: GitHubPullRequest): boolean {
  if (isSyncPullRequest(pullRequest)) return false;
  const author = pullRequest.author;
  return Boolean(author?.is_bot || author?.type?.toLowerCase() === 'bot' || author?.login?.endsWith('[bot]'));
}

export function isSyncPullRequest(pullRequest: GitHubPullRequest): boolean {
  return [
    'codex/daily-dogfood-sync',
    'codex/sync-kaizen-dogfood',
    'codex/sync-kaizen-shared-skills'
  ].includes(pullRequest.headRefName ?? '');
}

function oldestPullRequestCreatedAt(pullRequests: GitHubPullRequest[]): string | undefined {
  return pullRequests.reduce<string | undefined>((oldest, pullRequest) => {
    if (!isValidIsoDate(pullRequest.createdAt)) return oldest;
    if (!oldest) return pullRequest.createdAt;
    return Date.parse(pullRequest.createdAt) < Date.parse(oldest) ? pullRequest.createdAt : oldest;
  }, undefined);
}

function elapsedDaysSince(isoDate: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(isoDate)) / DAY_MS));
}

function isValidIsoDate(value: string | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
