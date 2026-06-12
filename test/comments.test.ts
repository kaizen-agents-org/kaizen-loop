import { describe, expect, it } from 'vitest';
import { buildResultComment, countAttempts } from '../src/report/comments.js';

describe('result comments', () => {
  it('includes a machine-readable marker and counts attempts', () => {
    const body = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 42,
      attempt: 1,
      outcome: 'pr-created',
      agent: 'claude',
      summary: 'summary',
      prUrl: 'https://github.com/o/r/pull/1',
      maxAttempts: 3
    });

    expect(body).toContain('<!-- kaizen-loop:result');
    expect(countAttempts([{ body }, { body: 'not a marker' }])).toBe(1);
  });
});
