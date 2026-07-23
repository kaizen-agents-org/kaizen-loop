import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('queued issue authorization documentation', () => {
  it('documents authorization and selection as separate explicit labels', () => {
    const skills = fs.readFileSync('docs/10-skills.md', 'utf8');
    const conventions = fs.readFileSync('docs/05-issue-conventions.md', 'utf8');
    const reportRow = skills.split('\n').find((line) => line.startsWith('| File or record a bug |'));
    const queueRow = skills.split('\n').find((line) => line.startsWith('| Queue for the next loop |'));
    const runRow = skills.split('\n').find((line) => line.startsWith('| Run immediately |'));
    const reportCommand = conventions
      .split('\n')
      .find((line) => line.includes('kaizen report "<タイトル>" --body-file'));

    expect(reportRow).toContain('`kaizen`');
    expect(reportRow).not.toContain('issues.executionAuthorization.label');
    expect(reportCommand).not.toContain('kaizen:authorized');
    expect(queueRow).toContain('`kaizen`');
    expect(queueRow).toContain('issues.executionAuthorization.label');
    expect(queueRow).toContain('issues.selection.includeLabel');
    expect(runRow).toContain('`kaizen`');
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
