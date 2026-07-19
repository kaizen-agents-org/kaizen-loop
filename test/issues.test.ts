import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { selectIssues } from '../src/orchestrator/issues.js';
import type { GitHubIssue } from '../src/github/types.js';

const config = configSchema.parse({ version: 1, run: { maxAttemptsPerIssue: 2 } });
const optInConfig = configSchema.parse({
  version: 1,
  run: { maxAttemptsPerIssue: 2 },
  issues: {
    selection: { mode: 'opt-in', includeLabel: 'kaizen:ready' }
  }
});
const manualOnlyConfig = configSchema.parse({
  version: 1,
  run: { maxAttemptsPerIssue: 2 },
  issues: {
    selection: { mode: 'manual-only' }
  }
});

describe('selectIssues', () => {
  it('sorts by priority then age and caps max issues', () => {
    const selection = selectIssues({
      config,
      maxIssues: 2,
      issues: [
        issue(3, 'new p1', '2026-06-12T03:00:00Z', ['kaizen', 'kaizen:P1']),
        issue(1, 'old p2', '2026-06-12T01:00:00Z', ['kaizen', 'kaizen:P2']),
        issue(2, 'old p1', '2026-06-12T02:00:00Z', ['kaizen', 'kaizen:P1'])
      ]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([2, 3]);
    expect(selection.skipped).toEqual([{ number: 1, reason: 'maxIssuesPerNight reached' }]);
  });

  it('skips needs-human and exhausted issues', () => {
    const selection = selectIssues({
      config,
      maxIssues: 10,
      issues: [
        issue(1, 'needs human', '2026-06-12T01:00:00Z', ['kaizen', 'kaizen:needs-human']),
        {
          ...issue(2, 'exhausted', '2026-06-12T02:00:00Z', ['kaizen', 'kaizen:attempts-exhausted']),
          comments: [
            { body: '<!-- kaizen-loop:result {"attempt":1} -->' },
            { body: '<!-- kaizen-loop:result {"attempt":2} -->' }
          ]
        },
        issue(3, 'ok', '2026-06-12T03:00:00Z', ['kaizen'])
      ]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([3]);
    expect(selection.skipped).toEqual([
      { number: 1, reason: 'needs-human' },
      { number: 2, reason: 'terminal disposition: kaizen:attempts-exhausted' }
    ]);
  });

  it('allows one new attempt after an operator removes attempts-exhausted', () => {
    const selection = selectIssues({
      config,
      maxIssues: 10,
      issues: [{
        ...issue(1, 'retry approved', '2026-06-12T01:00:00Z', ['kaizen']),
        comments: [
          { body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"failed"} -->' },
          { body: '<!-- kaizen-loop:result {"attempt":2,"outcome":"failed"} -->' }
        ]
      }]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([1]);
    expect(selection.skipped).toEqual([]);
  });

  it('does not retry a reopened issue while its unanswered needs-human label remains active', () => {
    const selection = selectIssues({
      config,
      maxIssues: 10,
      issues: [
        {
          ...issue(1, 'provider unavailable', '2026-06-12T01:00:00Z', ['kaizen', 'kaizen:needs-human']),
          comments: [
            {
              body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"blocked","retryableExternal":true} -->'
            }
          ]
        }
      ]
    });

    expect(selection.selected).toEqual([]);
    expect(selection.skipped).toEqual([{ number: 1, reason: 'needs-human' }]);
  });

  it.each([
    'kaizen:blocked',
    'kaizen:upstream-first',
    'kaizen:not-actionable',
    'kaizen:attempts-exhausted'
  ])('excludes terminal disposition %s from scheduled selection', (label) => {
    const result = selectIssues({
      issues: [issue(1, 'terminal', '2026-06-12T01:00:00Z', ['kaizen', label])],
      config,
      maxIssues: 1
    });
    expect(result.selected).toEqual([]);
    expect(result.skipped).toEqual([{ number: 1, reason: `terminal disposition: ${label}` }]);
  });

  it('excludes roadmap placeholders from selection by default', () => {
    const result = selectIssues({
      issues: [issue(1, 'roadmap placeholder', '2026-06-12T01:00:00Z', ['kaizen', 'kaizen:roadmap'])],
      config,
      maxIssues: 1
    });

    expect(result.selected).toEqual([]);
    expect(result.skipped).toEqual([{ number: 1, reason: 'excluded label: kaizen:roadmap' }]);
  });

  it('keeps retryable disposition eligible', () => {
    const result = selectIssues({
      issues: [issue(1, 'retryable', '2026-06-12T01:00:00Z', ['kaizen', 'kaizen:retryable'])],
      config,
      maxIssues: 1
    });
    expect(result.selected.map((item) => item.number)).toEqual([1]);
  });

  it('treats needs-human as authoritative when another excluded label is active', () => {
    const selection = selectIssues({
      config: configSchema.parse({
        version: 1,
        issues: { selection: { excludeLabels: ['kaizen:needs-human', 'do-not-run'] } }
      }),
      maxIssues: 10,
      issues: [{
        ...issue(1, 'provider unavailable', '2026-06-12T01:00:00Z', ['kaizen', 'kaizen:needs-human', 'do-not-run']),
        comments: [{
          body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"blocked","retryableExternal":true} -->'
        }]
      }]
    });

    expect(selection.selected).toEqual([]);
    expect(selection.skipped).toEqual([{ number: 1, reason: 'needs-human' }]);
  });

  it('skips issues that already have a pending pull request in automatic selection', () => {
    const selection = selectIssues({
      config,
      maxIssues: 10,
      openPullRequests: [{ number: 1, headRefName: 'kaizen/issue-1-has-pr', url: 'https://github.com/o/r/pull/1' }],
      issues: [
        {
          ...issue(1, 'has pr', '2026-06-12T01:00:00Z', ['kaizen']),
          comments: [
            {
              body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"pr-created","pr":"https://github.com/o/r/pull/1"} -->'
            }
          ]
        },
        issue(2, 'ok', '2026-06-12T02:00:00Z', ['kaizen'])
      ]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([2]);
    expect(selection.skipped).toEqual([{ number: 1, reason: 'pending pull request' }]);
  });

  it('does not skip issues when a pending pull request marker points to a closed PR', () => {
    const selection = selectIssues({
      config,
      maxIssues: 10,
      openPullRequests: [{ number: 9, headRefName: 'kaizen/issue-9-other', url: 'https://github.com/o/r/pull/9' }],
      issues: [
        {
          ...issue(1, 'closed pr', '2026-06-12T01:00:00Z', ['kaizen']),
          comments: [
            {
              body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"pr-created","pr":"https://github.com/o/r/pull/1"} -->'
            }
          ]
        }
      ]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([1]);
    expect(selection.skipped).toEqual([]);
  });

  it('allows explicit reruns for issues with a pending pull request marker', () => {
    const selection = selectIssues({
      config,
      maxIssues: 1,
      explicit: true,
      onlyIssue: 1,
      issues: [
        {
          ...issue(1, 'has pr', '2026-06-12T01:00:00Z', ['kaizen']),
          comments: [
            {
              body: '<!-- kaizen-loop:progress {"attempt":1,"outcome":"pr-monitoring","pr":"https://github.com/o/r/pull/1"} -->'
            }
          ]
        }
      ]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([1]);
    expect(selection.skipped).toEqual([]);
  });

  it('requires the selection label in opt-in mode for automatic selection', () => {
    const selection = selectIssues({
      config: optInConfig,
      maxIssues: 10,
      issues: [
        issue(1, 'not queued', '2026-06-12T01:00:00Z', ['kaizen']),
        issue(2, 'queued', '2026-06-12T02:00:00Z', ['kaizen', 'kaizen:ready'])
      ]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([2]);
    expect(selection.skipped).toEqual([{ number: 1, reason: 'missing selection label: kaizen:ready' }]);
  });

  it('allows explicit issue processing in opt-in mode without the selection label', () => {
    const selection = selectIssues({
      config: optInConfig,
      maxIssues: 1,
      explicit: true,
      onlyIssue: 1,
      issues: [
        issue(1, 'explicit', '2026-06-12T01:00:00Z', ['kaizen'])
      ]
    });

    expect(selection.selected.map((item) => item.number)).toEqual([1]);
    expect(selection.skipped).toEqual([]);
  });

  it('selects nothing automatically in manual-only mode', () => {
    const selection = selectIssues({
      config: manualOnlyConfig,
      maxIssues: 10,
      issues: [
        issue(1, 'queued', '2026-06-12T01:00:00Z', ['kaizen', 'kaizen:ready'])
      ]
    });

    expect(selection.selected).toEqual([]);
    expect(selection.skipped).toEqual([{ number: 1, reason: 'manual-only selection mode' }]);
  });

  it('skips issues without the base kaizen label', () => {
    const selection = selectIssues({
      config,
      maxIssues: 10,
      issues: [
        issue(1, 'plain issue', '2026-06-12T01:00:00Z', ['bug'])
      ]
    });

    expect(selection.selected).toEqual([]);
    expect(selection.skipped).toEqual([{ number: 1, reason: 'missing required label: kaizen' }]);
  });
});

function issue(number: number, title: string, createdAt: string, labels: string[]): GitHubIssue {
  return {
    number,
    title,
    createdAt,
    body: '',
    url: `https://github.com/o/r/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    comments: []
  };
}
