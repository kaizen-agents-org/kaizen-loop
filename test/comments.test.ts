import { describe, expect, it } from 'vitest';
import { buildResultComment, countAttempts, hasRetryableExternalBlock, markedPullRequestNumbers } from '../src/report/comments.js';

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

  it('tells users where a failed implementation will resume', () => {
    const body = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 42,
      attempt: 1,
      outcome: 'failed',
      agent: 'codex',
      summary: 'verification failed',
      resumeBranch: 'kaizen/issue-42-resume-me',
      prUrl: 'https://github.com/o/r/pull/7',
      checkpointPublished: true,
      maxAttempts: 3
    });

    expect(body).toContain('Checkpoint saved on `kaizen/issue-42-resume-me`');
    expect(body).toContain('the next eligible run resumes from this branch');
    expect(body).toContain('| Draft PR | https://github.com/o/r/pull/7 |');
    expect(body).toContain('"checkpointBranch":"kaizen/issue-42-resume-me"');
  });

  it('does not promise resumption when no checkpoint draft was published', () => {
    const body = buildResultComment({
      runId: '2026-06-12T02-00-00Z',
      issue: 42,
      attempt: 1,
      outcome: 'failed',
      agent: 'codex',
      summary: 'no changes',
      resumeBranch: 'kaizen/issue-42-no-diff',
      maxAttempts: 3
    });

    expect(body).not.toContain('| Resume |');
    expect(body).not.toContain('checkpointBranch');
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
    expect(hasRetryableExternalBlock([{ body: retryable }])).toBe(true);
    expect(hasRetryableExternalBlock([{ body: human }])).toBe(false);
  });

  it('uses the latest result when deciding whether a blocked issue is retryable', () => {
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
      runId: '2026-06-13T02-00-00Z',
      issue: 42,
      attempt: 2,
      outcome: 'blocked',
      agent: 'codex',
      summary: 'needs credentials',
      maxAttempts: 3
    });

    expect(hasRetryableExternalBlock([{ body: retryable }, { body: human }])).toBe(false);
    expect(hasRetryableExternalBlock([{ body: human }, { body: retryable }])).toBe(true);
  });

  it('recognizes legacy retryable provider evidence without the marker flag', () => {
    expect(hasRetryableExternalBlock([{
      body: [
        'failureClass=command_missing; fallbackReason=auth_failed',
        '<!-- kaizen-loop:result {"attempt":1,"outcome":"blocked"} -->'
      ].join('\n')
    }])).toBe(true);
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

  it('ignores empty pull request markers', () => {
    const comments = [
      { body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"pr-created","pr":""} -->' },
      { body: '<!-- kaizen-loop:progress {"outcome":"pr-monitoring","pr":"https://github.com/o/r/pull/4"} -->' }
    ];

    expect(markedPullRequestNumbers(comments)).toEqual([4]);
  });
});
