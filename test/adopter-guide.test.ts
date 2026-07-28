import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('third-party adopter guide', () => {
  it('is linked from both documentation entry points', () => {
    const guidePath = path.resolve('docs/15-third-party-adopter-guide.md');

    for (const readmePath of ['README.md', 'docs/README.md']) {
      const readme = fs.readFileSync(readmePath, 'utf8');
      const targets = [...readme.matchAll(/\[[^\]]+]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
        .map((match) => path.resolve(path.dirname(readmePath), match[1]));

      expect(targets).toContain(guidePath);
      expect(fs.existsSync(guidePath)).toBe(true);
    }
  });

  it('preserves the external Actions safety contract', () => {
    const guide = fs.readFileSync('docs/15-third-party-adopter-guide.md', 'utf8');
    const yamlBlocks = [...guide.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(yamlBlocks).toHaveLength(3);

    const config = parse(yamlBlocks[0]);
    expect(config).toMatchObject({
      safety: { operationMode: 'external' },
      verifier: { enabled: true, command: 'verifier' },
      policy: { mode: 'pr-only' },
      issues: {
        label: 'kaizen',
        executionAuthorization: {
          label: 'kaizen:authorized',
          minimumPermission: 'triage'
        },
        selection: {
          mode: 'opt-in',
          includeLabel: 'kaizen:ready'
        }
      }
    });

    const exampleSha = 'a'.repeat(40);
    const workflowSource = yamlBlocks[1].replaceAll('<FULL-KAIZEN-COMMIT-SHA>', exampleSha);
    const workflow = parse(workflowSource);
    const fix = workflow.jobs.fix;
    expect(workflow.permissions).toEqual({
      contents: 'write',
      issues: 'read',
      'pull-requests': 'write'
    });
    expect(fix.uses).toMatch(new RegExp(`@${exampleSha}$`));
    expect(fix.with['runtime-ref']).toBe(exampleSha);
    expect(fix.secrets).toEqual({
      OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}',
      KAIZEN_GITHUB_TOKEN: '${{ secrets.KAIZEN_GITHUB_TOKEN }}'
    });
    expect(workflowSource).not.toContain('secrets: inherit');

    const localConfig = parse(yamlBlocks[2]);
    expect(localConfig).toEqual({
      issues: {
        selection: {
          mode: 'opt-in',
          includeLabel: 'kaizen:ready'
        }
      }
    });

    for (const requiredText of [
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
    expect(guide.indexOf('npx kaizen-loop run --dry-run --json'))
      .toBeLessThan(guide.indexOf('npx kaizen-loop scheduler sync'));
  });
});
