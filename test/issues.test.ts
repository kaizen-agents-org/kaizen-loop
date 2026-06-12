import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { selectIssues } from '../src/orchestrator/issues.js';
import type { GitHubIssue } from '../src/github/types.js';

const config = configSchema.parse({ version: 1, run: { maxAttemptsPerIssue: 2 } });

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
          ...issue(2, 'exhausted', '2026-06-12T02:00:00Z', ['kaizen']),
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
      { number: 2, reason: 'max attempts reached' }
    ]);
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
