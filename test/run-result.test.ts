import { describe, expect, it } from 'vitest';
import { resultFor } from '../src/orchestrator/run.js';
import type { RunIssueSummary } from '../src/orchestrator/summary.js';

function issue(overrides: Partial<RunIssueSummary> = {}): RunIssueSummary {
  return {
    number: 1,
    title: 'Fix the issue',
    priority: 'kaizen:P1',
    agent: 'codex',
    attempt: 1,
    outcome: 'pr-created',
    summary: 'Created a PR',
    ...overrides
  };
}

describe('resultFor', () => {
  it('treats an already-fixed issue as successful', () => {
    expect(resultFor([issue({ outcome: 'already-fixed' })])).toBe('success');
  });

  it('does not report success when a created PR has a failed guardian', () => {
    expect(resultFor([issue({ guardian: { status: 'failed', summary: 'timed out' } })])).toBe('failed');
  });

  it('reports partial when another issue completed successfully', () => {
    expect(resultFor([
      issue({ guardian: { status: 'failed', summary: 'timed out' } }),
      issue({ number: 2, guardian: { status: 'success', summary: 'ready' } })
    ])).toBe('partial');
  });
});
