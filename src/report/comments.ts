import type { AgentResult } from '../agents/types.js';

export interface ResultCommentOptions {
  runId: string;
  issue: number;
  attempt: number;
  outcome: 'direct-commit' | 'pr-created' | 'failed' | 'blocked' | 'skipped';
  agent: string;
  summary: string;
  verifyResults?: Array<{ command: string; ok: boolean }>;
  prUrl?: string;
  commit?: string;
  reason?: string;
  trigger?: 'manual' | 'scheduled' | 'instant' | 'watch';
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

<!-- kaizen-loop:result ${JSON.stringify(marker)} -->`;
}

export function countAttempts(comments: Array<{ body: string }>): number {
  return comments.filter((comment) => /<!--\s*kaizen-loop:result\s+{/.test(comment.body)).length;
}

export function agentSummary(result: AgentResult): string {
  if (result.status === 'blocked') return result.blockedReason || result.summary;
  return result.summary;
}

function formatOutcome(options: ResultCommentOptions): string {
  if (options.outcome === 'pr-created') return `PR created${options.prUrl ? ` (${options.prUrl})` : ''}`;
  if (options.outcome === 'direct-commit') return `Direct commit${options.commit ? ` (${options.commit})` : ''}`;
  if (options.outcome === 'blocked') return 'Blocked; needs human input';
  if (options.outcome === 'skipped') return 'Skipped';
  return 'Failed';
}
