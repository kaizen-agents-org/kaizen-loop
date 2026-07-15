import type { AgentResult } from '../agents/types.js';
import type { GitHubPullRequest } from '../github/types.js';

export interface ResultCommentOptions {
  runId: string;
  issue: number;
  attempt: number;
  outcome: 'direct-commit' | 'pr-created' | 'failed' | 'blocked' | 'skipped';
  agent: string;
  summary: string;
  notes?: string;
  verifyResults?: Array<{ command: string; ok: boolean }>;
  prUrl?: string;
  commit?: string;
  reason?: string;
  trigger?: string;
  maxAttempts: number;
  blockDisposition?: 'human-input-required' | 'retryable' | 'blocked' | 'attempts-exhausted';
  resumeBranch?: string;
  checkpointPublished?: boolean;
}

export function buildResultComment(options: ResultCommentOptions): string {
  const verify = options.verifyResults?.length
    ? options.verifyResults.map((item) => `\`${item.command}\` ${item.ok ? 'passed' : 'failed'}`).join(' / ')
    : 'not configured';
  const marker = {
    run: options.runId,
    issue: options.issue,
    attempt: options.attempt,
    outcome: options.outcome,
    trigger: options.trigger,
    commit: options.commit,
    pr: options.prUrl,
    retryableExternal: options.blockDisposition === 'retryable' || undefined,
    humanConfirmationRequired: options.blockDisposition === 'human-input-required' || undefined,
    checkpointBranch: options.checkpointPublished ? options.resumeBranch : undefined
  };

  return `## Kaizen Loop result

| | |
|---|---|
| Result | ${formatOutcome(options)} |
| Reason | ${options.reason ?? '-'} |
| Agent | ${options.agent} (attempt ${options.attempt}/${options.maxAttempts}) |
| Verification | ${verify} |
${options.checkpointPublished && options.resumeBranch ? `| Resume | Checkpoint saved on \`${options.resumeBranch}\`; the next eligible run resumes from this branch. |` : ''}
${options.checkpointPublished && options.prUrl ? `| Draft PR | ${options.prUrl} |` : ''}

### Summary
${options.summary || '(no summary)'}
${formatNotes(options.notes)}

<!-- kaizen-loop:result ${JSON.stringify(marker)} -->`;
}

export function buildPrProgressComment(options: {
  runId: string;
  issue: number;
  attempt: number;
  prUrl: string;
  trigger?: string;
}): string {
  const marker = {
    run: options.runId,
    issue: options.issue,
    attempt: options.attempt,
    outcome: 'pr-monitoring',
    trigger: options.trigger,
    pr: options.prUrl
  };

  return `## Kaizen Loop progress

PR created (${options.prUrl}); monitoring CI and review feedback with pr-guardian.

<!-- kaizen-loop:progress ${JSON.stringify(marker)} -->`;
}

export function countAttempts(comments: Array<{ body: string }>): number {
  return comments.filter((comment) => {
    const marker = parseKaizenMarker(comment.body, 'result');
    return marker !== undefined && !marker.retryableExternal && !hasRetryableExternalEvidence(comment.body);
  }).length;
}

export function hasRetryableExternalBlock(comments: Array<{ body: string }>): boolean {
  const marker = [...comments]
    .reverse()
    .map((comment) => ({ comment, marker: parseKaizenMarker(comment.body, 'result') }))
    .find((candidate) => candidate.marker !== undefined);
  return Boolean(
    marker?.marker?.outcome === 'blocked' &&
      marker.marker.humanConfirmationRequired !== true &&
      (marker.marker.retryableExternal === true || hasRetryableExternalEvidence(marker.comment.body))
  );
}

export function countConsecutiveRetryableBlocks(comments: Array<{ body: string }>): number {
  let count = 0;
  for (const comment of [...comments].reverse()) {
    const marker = parseKaizenMarker(comment.body, 'result');
    if (!marker) continue;
    if (
      marker.outcome === 'blocked' &&
      marker.humanConfirmationRequired !== true &&
      (marker.retryableExternal === true || hasRetryableExternalEvidence(comment.body))
    ) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

export function hasPendingPullRequest(comments: Array<{ body: string }>, openPullRequests: GitHubPullRequest[] = []): boolean {
  return comments.some((comment) => {
    const marker = parseKaizenMarker(comment.body, 'result') ?? parseKaizenMarker(comment.body, 'progress');
    if (!marker) return false;
    return (
      typeof marker.pr === 'string' &&
      marker.pr.length > 0 &&
      (marker.outcome === 'pr-created' || marker.outcome === 'pr-monitoring') &&
      isOpenPullRequest(marker.pr, openPullRequests)
    );
  });
}

export function markedPullRequestNumbers(comments: Array<{ body: string }>): number[] {
  const numbers = comments
    .flatMap((comment) => [
      parseKaizenMarker(comment.body, 'result')?.pr,
      parseKaizenMarker(comment.body, 'progress')?.pr
    ])
    .map((pr) => (pr ? pullRequestNumber(pr) : undefined))
    .filter((number): number is number => number !== undefined);
  return [...new Set(numbers)];
}

export function agentSummary(result: AgentResult): string {
  if (result.status === 'blocked') return result.blockedReason || result.summary;
  return result.summary;
}

function parseKaizenMarker(body: string, kind: 'result' | 'progress'): {
  outcome?: string;
  pr?: string;
  retryableExternal?: boolean;
  humanConfirmationRequired?: boolean;
} | undefined {
  const match = body.match(new RegExp(`<!--\\s*kaizen-loop:${kind}\\s+({.*?})\\s*-->`, 's'));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as {
      outcome?: string;
      pr?: string;
      retryableExternal?: boolean;
      humanConfirmationRequired?: boolean;
    };
  } catch {
    return undefined;
  }
}

function isOpenPullRequest(markerPr: string, openPullRequests: GitHubPullRequest[]): boolean {
  const markerNumber = pullRequestNumber(markerPr);
  return openPullRequests.some((pr) => pr.url === markerPr || (markerNumber !== undefined && pr.number === markerNumber));
}

function pullRequestNumber(value: string): number | undefined {
  const match = value.match(/\/pull\/(\d+)(?:\b|$)/) ?? value.match(/^#?(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function formatOutcome(options: ResultCommentOptions): string {
  if (options.outcome === 'pr-created') return `PR created${options.prUrl ? ` (${options.prUrl})` : ''}`;
  if (options.outcome === 'direct-commit') return `Direct commit${options.commit ? ` (${options.commit})` : ''}`;
  if (options.outcome === 'blocked') {
    if (options.blockDisposition === 'retryable') return 'Blocked; retryable external dependency';
    if (options.blockDisposition === 'human-input-required') return 'Blocked; needs human input';
    if (options.blockDisposition === 'attempts-exhausted') return 'Blocked; retry budget exhausted';
    return 'Blocked; automation cannot proceed';
  }
  if (options.outcome === 'skipped') return 'Skipped';
  return 'Failed';
}

function hasRetryableExternalEvidence(body: string): boolean {
  return [
    /\bfailureclass\s*[:=]\s*(timeout|rate_limited|rate limited)\b/i,
    /\bfallbackreason\s*[:=]\s*(timeout|rate_limited|rate limited)\b/i,
    /\bapi_error_status["']?\s*[:=]\s*429\b/i,
    /\b(?:http|status)\s*[:=]\s*429\b/i,
    /\bagent command timed out after \d+ms\b/i,
    /["']result["']\s*:\s*["'][^"']*(session limit|rate limit exceeded|too many requests)/i,
    /\bfailed to initialize in-process app-server client:\s*operation not permitted\b/i,
    /\bcould not create path aliases:\s*operation not permitted\b/i,
    /\bfailureclass\s*[:=]\s*(command_missing|auth_failed|authentication_failed|login_required)\b/i,
    /\bfallbackreason\s*[:=]\s*(command_missing|auth_failed|authentication_failed|login_required)\b/i
  ].some((pattern) => pattern.test(body));
}

function formatNotes(notes: string | undefined): string {
  const trimmed = notes?.trim();
  return trimmed ? `\n### Notes\n${trimmed}\n` : '';
}
