import { describe, expect, it } from 'vitest';
import { summarizeQueue, type RunSummary } from '../src/orchestrator/summary.js';

describe('summarizeQueue', () => {
  it.each([
    ['selection-label mismatch', 'missing selection label: kaizen:ready'],
    ['authorization mismatch', 'missing execution authorization label: kaizen:authorized'],
    ['pending-PR throttling', 'pending pull request']
  ])('marks repeated %s as starved', (_name, reason) => {
    const first = summaryWithQueue(reason, '2026-07-19T02:00:00.000Z');
    const queue = summarizeQueue({
      backlogCount: 2,
      eligibleCount: 0,
      processedCount: 0,
      skipped: [{ number: 1, reason }, { number: 2, reason }],
      previousSummaries: [first],
      starvationRuns: 2,
      observedAt: '2026-07-20T02:00:00.000Z'
    });

    expect(queue).toMatchObject({
      backlogCount: 2,
      eligibleCount: 0,
      processedCount: 0,
      skipReasons: [{ reason, count: 2 }],
      health: {
        state: 'starved',
        consecutiveZeroThroughputRuns: 2,
        since: '2026-07-19T02:00:00.000Z'
      }
    });
    expect(queue.health.warning).toContain(reason);
  });

  it('keeps an empty backlog healthy and quiet as idle', () => {
    const queue = summarizeQueue({
      backlogCount: 0,
      eligibleCount: 0,
      processedCount: 0,
      skipped: [],
      previousSummaries: [],
      starvationRuns: 2,
      observedAt: '2026-07-20T02:00:00.000Z'
    });

    expect(queue.health).toEqual({
      state: 'idle',
      consecutiveZeroThroughputRuns: 0,
      since: undefined,
      warning: undefined
    });
  });

  it('does not call a mixed-gate backlog starved', () => {
    const queue = summarizeQueue({
      backlogCount: 2,
      eligibleCount: 0,
      processedCount: 0,
      skipped: [
        { number: 1, reason: 'pending pull request' },
        { number: 2, reason: 'missing selection label: kaizen:ready' }
      ],
      previousSummaries: [],
      starvationRuns: 2,
      observedAt: '2026-07-20T02:00:00.000Z'
    });

    expect(queue.health.state).toBe('healthy');
  });

  it('normalizes per-issue gate details without changing displayed skip reasons', () => {
    const first = summaryWithQueue(
      'execution authorization could not be verified: actor alice lacks write permission',
      '2026-07-19T02:00:00.000Z'
    );
    const queue = summarizeQueue({
      backlogCount: 2,
      eligibleCount: 0,
      processedCount: 0,
      skipped: [
        { number: 1, reason: 'execution authorization could not be verified: actor bob lacks write permission' },
        { number: 2, reason: 'execution authorization could not be verified: actor carol lacks maintain permission' }
      ],
      previousSummaries: [first],
      starvationRuns: 2,
      observedAt: '2026-07-20T02:00:00.000Z'
    });

    expect(queue.skipReasons).toEqual([
      { reason: 'execution authorization could not be verified: actor bob lacks write permission', count: 1 },
      { reason: 'execution authorization could not be verified: actor carol lacks maintain permission', count: 1 }
    ]);
    expect(queue.health).toMatchObject({
      state: 'starved',
      consecutiveZeroThroughputRuns: 2,
      since: '2026-07-19T02:00:00.000Z'
    });
    expect(queue.health.warning).toContain('execution authorization could not be verified');
  });
});

function summaryWithQueue(reason: string, startedAt: string): RunSummary {
  return {
    version: 1,
    project: 'o-r',
    startedAt,
    finishedAt: startedAt,
    trigger: 'maintenance',
    result: 'success',
    issues: [],
    skipped: [{ number: 1, reason }, { number: 2, reason }],
    queue: {
      backlogCount: 2,
      eligibleCount: 0,
      processedCount: 0,
      skipReasons: [{ reason, count: 2 }],
      health: {
        state: 'degraded',
        consecutiveZeroThroughputRuns: 1,
        since: startedAt
      }
    }
  };
}
