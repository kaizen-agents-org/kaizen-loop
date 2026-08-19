import { describe, expect, it } from 'vitest';
import { isGeneratedPullRequest } from '../src/orchestrator/wipLimit.js';
import type { GitHubPullRequest } from '../src/github/types.js';

describe('isGeneratedPullRequest', () => {
  it.each(['kaizen/issue-321-fix', 'codex/improve-wip-limit', 'claude/update-tests'])(
    'classifies the human-authored %s branch as generated',
    (headRefName) => {
      expect(isGeneratedPullRequest(pullRequest({ headRefName }))).toBe(true);
    }
  );

  it.each(['[scout] Improve WIP classification', '[monitor] Repair CI', 'kaizen: update generated docs'])(
    'classifies the human-authored %s title as generated',
    (title) => {
      expect(isGeneratedPullRequest(pullRequest({ title }))).toBe(true);
    }
  );

  it('continues to exclude known sync pull requests', () => {
    expect(isGeneratedPullRequest(pullRequest({
      headRefName: 'codex/sync-kaizen-shared-skills',
      author: { login: 'github-actions[bot]', type: 'Bot' }
    }))).toBe(false);
  });

  it.each([
    { login: 'renovate[bot]', type: 'Bot' },
    { login: 'dependabot[bot]', type: 'Bot' },
    { login: 'github-actions[bot]', type: 'Bot' }
  ])('does not classify an unmarked bot-authored pull request as generated', (author) => {
    expect(isGeneratedPullRequest(pullRequest({
      headRefName: 'feature/dependency-update',
      title: 'Update dependency lockfile',
      author
    }))).toBe(false);
  });

  it('still classifies an explicitly marked bot-authored pull request as generated', () => {
    expect(isGeneratedPullRequest(pullRequest({
      headRefName: 'kaizen/issue-398-fix',
      author: { login: 'github-actions[bot]', type: 'Bot' }
    }))).toBe(true);
  });

  it('does not classify an ordinary human-authored pull request as generated', () => {
    expect(isGeneratedPullRequest(pullRequest({
      headRefName: 'feature/update-readme',
      title: 'Update the README'
    }))).toBe(false);
  });
});

function pullRequest(overrides: Partial<GitHubPullRequest>): GitHubPullRequest {
  return {
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    author: { login: 'maintainer', type: 'User' },
    ...overrides
  };
}
