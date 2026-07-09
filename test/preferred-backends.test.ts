import { describe, expect, it } from 'vitest';
import { selectPreferredBackends } from '../src/orchestrator/run.js';
import { configSchema } from '../src/config/schema.js';
import type { GitHubIssue } from '../src/github/types.js';

function issueWithLabels(labels: string[]): GitHubIssue {
  return {
    number: 1,
    title: 'Do work',
    body: '',
    labels: labels.map((name) => ({ name })),
    createdAt: '2026-07-09T00:00:00Z',
    comments: []
  };
}

describe('selectPreferredBackends', () => {
  it('keeps configured fallback after the preferred backend', () => {
    const config = configSchema.parse({
      version: 1,
      agent: {
        default: 'codex',
        fallback: true,
        model: { claude: null, codex: null }
      }
    });

    expect(selectPreferredBackends(config, issueWithLabels([]), undefined)).toEqual(['codex', 'claude']);
    expect(selectPreferredBackends(config, issueWithLabels(['kaizen:agent:claude']), undefined)).toEqual([
      'claude',
      'codex'
    ]);
  });

  it('honors fallback=false as a single-provider run', () => {
    const config = configSchema.parse({
      version: 1,
      agent: {
        default: 'codex',
        fallback: false,
        model: { claude: null, codex: null }
      }
    });

    expect(selectPreferredBackends(config, issueWithLabels([]), undefined)).toEqual(['codex']);
  });
});
