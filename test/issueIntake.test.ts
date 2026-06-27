import { describe, expect, it } from 'vitest';
import { evaluateIssueIntake } from '../src/orchestrator/issueIntake.js';
import type { GitHubIssue } from '../src/github/types.js';

describe('evaluateIssueIntake', () => {
  it('proceeds for a scoped improvement', () => {
    expect(evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [],
      issue: issue({
        body: '## Problem\nThe status command omits useful queue counts.\n\n## Expected behavior\nShow the counts in status output.'
      })
    }).status).toBe('proceed');
  });

  it('routes source-of-truth sync work upstream first', () => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: 'The downstream copy drifted from source-of-truth kaizen-agents-org/.github. Syncing it directly would copy the wrong behavior.'
      })
    });

    expect(decision.status).toBe('upstream_first');
    expect(decision.reason).toContain('kaizen-agents-org/.github');
  });

  it('rejects recommended actions that weaken review guardrails', () => {
    const decision = evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [],
      issue: issue({
        body: 'Suggested design: should remove PR Guardian review feedback checks so pull requests finish faster.'
      })
    });

    expect(decision.status).toBe('not_improvement');
  });

  it('detects already resolved work from current PR markers', () => {
    const decision = evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [{ number: 4, headRefName: 'kaizen/issue-12-fix', url: 'https://github.com/o/r/pull/4' }],
      issue: issue({
        number: 12,
        comments: [
          {
            body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"pr-created","pr":"https://github.com/o/r/pull/4"} -->'
          }
        ]
      })
    });

    expect(decision.status).toBe('already_resolved');
  });

  it('asks for context on vague title-only issues', () => {
    expect(evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [],
      issue: issue({ title: 'Fix bug', body: '' })
    }).status).toBe('needs_context');
  });
});

function issue(options: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: options.number ?? 1,
    title: options.title ?? 'Improve behavior',
    body: options.body ?? 'Enough detail to proceed.',
    labels: options.labels ?? [{ name: 'kaizen' }],
    createdAt: options.createdAt ?? '2026-06-12T00:00:00Z',
    comments: options.comments ?? []
  };
}
