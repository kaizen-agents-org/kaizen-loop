import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../src/github/client.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('GitHubClient', () => {
  it('creates a pull request without draft mode', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: 'https://github.com/o/r/pull/7\n',
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    const pr = await client.createPullRequest({
      base: 'main',
      head: 'kaizen/issue-1-x',
      title: 'title',
      body: 'body'
    });

    expect(pr).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7 });
    expect(runner.mock.calls[0][1]).not.toContain('--draft');
  });

  it('retries issue creation without labels when target repo labels are missing', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args.includes('--label')) {
        throw new Error('GraphQL: Could not resolve to a Label with the name kaizen:P2');
      }
      return {
        command,
        args,
        exitCode: 0,
        stdout: 'https://github.com/kaizen-agents-org/verifier/issues/77\n',
        stderr: '',
        durationMs: 1
      };
    });
    const client = new GitHubClient(runner, '/repo');

    const issue = await client.createIssue({
      repo: 'kaizen-agents-org/verifier',
      title: 'follow-up',
      body: 'details',
      labels: ['kaizen', 'kaizen:P2']
    });

    expect(issue.url).toBe('https://github.com/kaizen-agents-org/verifier/issues/77');
    expect(issue.labels).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(4);
    expect(runner.mock.calls[0][1]).toContain('--label');
    expect(runner.mock.calls[3][1]).not.toContain('--label');
    expect(runner.mock.calls[3][1]).toContain('--repo');
    expect(runner.mock.calls[3][1]).toContain('kaizen-agents-org/verifier');
  });

  it('searches a broad candidate set before exact-title duplicate matching', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: '[]',
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    await client.findOpenIssueByTitle({ repo: 'kaizen-agents-org/verifier', title: 'follow-up' });

    const args = runner.mock.calls[0][1];
    expect(args.at(args.indexOf('--limit') + 1)).toBe('100');
  });
});
