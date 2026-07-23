import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('queued issue authorization documentation', () => {
  it('documents authorization and selection as separate explicit labels', () => {
    const skills = fs.readFileSync('docs/10-skills.md', 'utf8');
    const conventions = fs.readFileSync('docs/05-issue-conventions.md', 'utf8');
    const queueRow = skills.split('\n').find((line) => line.startsWith('| Queue for the next loop |'));
    const runRow = skills.split('\n').find((line) => line.startsWith('| Run immediately |'));

    expect(queueRow).toContain('issues.executionAuthorization.label');
    expect(queueRow).toContain('issues.selection.includeLabel');
    expect(runRow).toContain('issues.executionAuthorization.label');
    expect(runRow).toContain('issues.selection.includeLabel');
    expect(conventions).toContain(
      'gh issue create --label kaizen --label kaizen:authorized --label kaizen:ready'
    );
    expect(conventions).toContain(
      'gh issue create --label kaizen --title "..." --body "..."'
    );
  });
});
