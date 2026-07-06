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

  it('does not count retryable external dependency blocks as attempts', () => {
    const body = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 42,
      attempt: 1,
      outcome: 'blocked',
      agent: 'codex',
      summary: 'Provider capacity hit a 429 rate limit',
      reason: 'Provider capacity hit a 429 rate limit',
      maxAttempts: 3,
      retryableExternal: true
    });

    expect(body).toContain('Blocked; retryable external dependency');
    expect(body).not.toContain('Blocked; needs human input');
    expect(body).toContain('"retryableExternal":true');
    expect(countAttempts([{ body }])).toBe(0);
  });

  it('labels retryable external failed results distinctly', () => {
    const body = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 42,
      attempt: 1,
      outcome: 'failed',
      agent: 'verifier',
      summary: 'Verifier timed out waiting for provider capacity',
      reason: 'Verifier timed out waiting for provider capacity',
      maxAttempts: 3,
      retryableExternal: true
    });

    expect(body).toContain('Failed; retryable external dependency');
    expect(body).not.toContain('| Result | Failed |');
    expect(countAttempts([{ body }])).toBe(0);
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
});
