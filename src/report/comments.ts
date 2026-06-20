import type { AgentResult } from '../agents/types.js';

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
  trigger?: 'manual' | 'scheduled' | 'afternoon' | 'instant' | 'watch';
  maxAttempts: number;
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
    pr: options.prUrl
  };

  return `## Kaizen Loop result

| | |
|---|---|
| Result | ${formatOutcome(options)} |
| Reason | ${options.reason ?? '-'} |
| Agent | ${options.agent} (attempt ${options.attempt}/${options.maxAttempts}) |
| Verification | ${verify} |

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
  trigger?: 'manual' | 'scheduled' | 'afternoon' | 'instant' | 'watch';
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
  return comments.filter((comment) => /<!--\s*kaizen-loop:result\s+{/.test(comment.body)).length;
}

export function hasPendingPullRequest(comments: Array<{ body: string }>): boolean {
  return comments.some((comment) => {
    const marker = parseKaizenMarker(comment.body, 'result') ?? parseKaizenMarker(comment.body, 'progress');
    if (!marker) return false;
    return (
      typeof marker.pr === 'string' &&
      marker.pr.length > 0 &&
      (marker.outcome === 'pr-created' || marker.outcome === 'pr-monitoring')
    );
  });
}

export function agentSummary(result: AgentResult): string {
  if (result.status === 'blocked') return result.blockedReason || result.summary;
  return result.summary;
}

function parseKaizenMarker(body: string, kind: 'result' | 'progress'): { outcome?: string; pr?: string } | undefined {
  const match = body.match(new RegExp(`<!--\\s*kaizen-loop:${kind}\\s+({.*?})\\s*-->`, 's'));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as { outcome?: string; pr?: string };
  } catch {
    return undefined;
  }
}

function formatOutcome(options: ResultCommentOptions): string {
  if (options.outcome === 'pr-created') return `PR created${options.prUrl ? ` (${options.prUrl})` : ''}`;
  if (options.outcome === 'direct-commit') return `Direct commit${options.commit ? ` (${options.commit})` : ''}`;
  if (options.outcome === 'blocked') return 'Blocked; needs human input';
  if (options.outcome === 'skipped') return 'Skipped';
  return 'Failed';
}

function formatNotes(notes: string | undefined): string {
  const trimmed = notes?.trim();
  return trimmed ? `\n### Notes\n${trimmed}\n` : '';
}
