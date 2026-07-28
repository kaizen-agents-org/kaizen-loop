import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('third-party adopter guide', () => {
  it('is linked from both documentation entry points', () => {
    const rootReadme = fs.readFileSync('README.md', 'utf8');
    const docsReadme = fs.readFileSync('docs/README.md', 'utf8');

    expect(rootReadme).toContain('./docs/15-third-party-adopter-guide.md');
    expect(docsReadme).toContain('./15-third-party-adopter-guide.md');
  });

  it('preserves the external Actions safety contract', () => {
    const guide = fs.readFileSync('docs/15-third-party-adopter-guide.md', 'utf8');

    for (const requiredText of [
      'operationMode: external',
      'mode: pr-only',
      'command: "verifier"',
      'kaizen:authorized',
      'minimumPermission: triage',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'KAIZEN_GITHUB_TOKEN',
      'runtime-ref',
      'safety.envAllowlist',
      'protected paths',
      'forbidden paths',
      'kaizen:needs-human',
      'scheduler disable'
    ]) {
      expect(guide).toContain(requiredText);
    }

    expect(guide).toContain('does not merge the pull request');
    expect(guide).toContain('Do not use a moving branch');
    expect(guide).toContain('These local labels are not the Actions fallback mechanism.');
  });
});
