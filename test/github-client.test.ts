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
});
