import { describe, expect, it } from 'vitest';
import { isGeneratedPullRequest, pullRequestsInRepositories } from '../src/orchestrator/wipLimit.js';
import type { GitHubPullRequest } from '../src/github/types.js';

describe('isGeneratedPullRequest', () => {
  it.each(['kaizen/issue-321-fix', 'codex/improve-wip-limit', 'claude/update-tests'])(
    'classifies the human-authored %s branch as generated',
    (headRefName) => {
      expect(isGeneratedPullRequest(pullRequest({ headRefName }))).toBe(true);
    }
  );

  it.each(['[WIP] kaizen: Save checkpoint', '[scout] Improve WIP classification', '[monitor] Repair CI', 'kaizen: update generated docs'])(
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

  it('classifies a checkpoint pull request with a custom branch prefix as generated', () => {
    expect(isGeneratedPullRequest(pullRequest({
      headRefName: 'custom/issue-398-fix',
      title: '[WIP] kaizen: Save partial implementation (#398)',
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

describe('pullRequestsInRepositories', () => {
  it('keeps only pull requests whose repository is registered, case-insensitively', () => {
    const registered = pullRequest({ number: 1, repository: { nameWithOwner: 'Owner/Registered' } });
    const unregistered = pullRequest({ number: 2, repository: { nameWithOwner: 'owner/unregistered' } });

    expect(pullRequestsInRepositories([registered, unregistered], ['owner/registered'])).toEqual([registered]);
  });

  it('fails closed when a pull request has no repository identity', () => {
    expect(() => pullRequestsInRepositories([pullRequest({ number: 3 })], ['owner/registered']))
      .toThrow('Cannot scope pull request #3: repository is missing');
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
