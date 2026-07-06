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
    expect(retryable).toContain('"retryableExternal":true');
    expect(countAttempts([{ body: retryable }])).toBe(0);
    expect(human).toContain('Blocked; needs human input');
    expect(countAttempts([{ body: human }])).toBe(1);
  });

  it('does not count legacy retryable provider blocks as attempts', () => {
    const legacyBody = [
      '## Kaizen Loop result',
      '| Result | Blocked; needs human input |',
      'Provider evidence:',
      '- codex: exitCode=1, status=fallback, failureClass=timeout, fallbackReason=timeout, payloadSource=none',
      'Agent command timed out after 600000ms.',
      '{"api_error_status":429,"result":"You have hit your session limit"}',
      '<!-- kaizen-loop:result {"run":"2026-07-06T03-15-50Z","issue":81,"attempt":1,"outcome":"blocked","trigger":"instant"} -->'
    ].join('\n');

    expect(countAttempts([{ body: legacyBody }])).toBe(0);
  });

  it('does not count legacy runner sandbox blocks as attempts', () => {
    const legacyBody = [
      '## Kaizen Loop result',
      '| Result | Blocked; needs human input |',
      'Raw output tail:',
      'WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)',
      'Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)',
      '{"result":"Not logged in · Please run /login"}',
      '<!-- kaizen-loop:result {"run":"2026-07-06T06-07-27Z","issue":81,"attempt":2,"outcome":"blocked","trigger":"instant"} -->'
    ].join('\n');

    expect(countAttempts([{ body: legacyBody }])).toBe(0);
  });
});
