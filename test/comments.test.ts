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

  it('surfaces builder notes when present', () => {
    const body = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 42,
      attempt: 1,
      outcome: 'pr-created',
      agent: 'codex',
      summary: 'summary',
      notes: 'Protected path changed: .github/workflows/ci.yml',
      maxAttempts: 3
    });

    expect(body).toContain('### Notes');
    expect(body).toContain('Protected path changed');
  });

  it('distinguishes retryable external blocks from human-input blocks', () => {
    const retryable = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 42,
      attempt: 1,
      outcome: 'blocked',
      agent: 'codex',
      summary: 'provider capacity exhausted',
      requiresHuman: false,
      maxAttempts: 3
    });
    const human = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 43,
      attempt: 1,
      outcome: 'blocked',
      agent: 'codex',
      summary: 'needs credentials',
      maxAttempts: 3
    });

    expect(retryable).toContain('Blocked; retryable external dependency');
    expect(human).toContain('Blocked; needs human input');
  });
});
