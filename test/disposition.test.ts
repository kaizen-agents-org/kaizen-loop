import { describe, expect, it, vi } from 'vitest';
import type { AgentResult } from '../src/agents/types.js';
import {
  applyIssueDisposition,
  dispositionForBlockedAgent,
  dispositionForIntake,
  humanRequestForIntake
} from '../src/orchestrator/disposition.js';

describe('issue disposition', () => {
  it.each([
    ['proceed', undefined],
    ['already_resolved', undefined],
    ['needs_human', 'human-input-required'],
    ['needs_context', 'human-input-required'],
    ['upstream_first', 'upstream-first'],
    ['not_improvement', 'not-actionable']
  ] as const)('maps intake %s exhaustively', (status, expected) => {
    expect(dispositionForIntake(status)).toBe(expected);
  });

  it('reserves human disposition for a structured request', () => {
    expect(dispositionForBlockedAgent(agentResult({
      blockedReason: 'Needs human approval in free-form text.'
    }))).toBe('blocked');
    expect(dispositionForBlockedAgent(agentResult({
      humanRequest: {
        reasonCode: 'credentials',
        requestKey: 'deployment-credentials',
        question: 'Provide the deployment credential?'
      }
    }))).toBe('human-input-required');
  });

  it('maps provider failures to retryable and ordinary failures to blocked', () => {
    expect(dispositionForBlockedAgent(agentResult({ notes: 'failureClass=rate_limited' }))).toBe('retryable');
    expect(dispositionForBlockedAgent(agentResult({ blockedReason: 'Correct fix belongs upstream.' }))).toBe('blocked');
  });

  it('maps only human intake decisions to concrete requests', () => {
    expect(humanRequestForIntake({ status: 'needs_context', reason: 'missing', evidence: [] })).toMatchObject({
      reasonCode: 'missing_information'
    });
    expect(humanRequestForIntake({ status: 'upstream_first', reason: 'upstream', evidence: [] })).toBeUndefined();
  });

  it('replaces incompatible disposition labels without touching unrelated labels', async () => {
    const github = {
      addLabels: vi.fn(async () => undefined),
      removeLabels: vi.fn(async () => undefined)
    };
    await applyIssueDisposition(github, 7, 'blocked');
    expect(github.addLabels).toHaveBeenCalledWith(7, ['kaizen:blocked']);
    expect(github.removeLabels).toHaveBeenCalledWith(7, expect.arrayContaining([
      'kaizen:retryable',
      'kaizen:upstream-first'
    ]));
    expect(github.removeLabels.mock.calls[0][1]).not.toContain('kaizen:needs-human');
    expect(github.removeLabels.mock.calls[0][1]).not.toContain('kaizen:blocked');
    expect(github.removeLabels.mock.calls[0][1]).not.toContain('kaizen');
  });
});

function agentResult(overrides: Partial<AgentResult>): AgentResult {
  return {
    status: 'blocked',
    summary: 'blocked',
    notes: '',
    discoveredIssues: [],
    raw: '',
    durationMs: 1,
    ...overrides
  };
}
