import { describe, expect, it, vi } from 'vitest';
import { CreatedPullRequestValidationError, GitHubClient } from '../src/github/client.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('GitHubClient', () => {
  it('creates a pull request without draft mode', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'repo') {
        return ghResult(command, args, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return ghResult(
          command,
          args,
          JSON.stringify({
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            baseRefName: 'main',
            isDraft: false,
            closingIssuesReferences: [{ number: 1, url: 'https://github.com/o/r/issues/1' }]
          })
        );
      }
      return ghResult(command, args, 'https://github.com/o/r/pull/7\n');
    });
    const client = new GitHubClient(runner, '/repo');

    const pr = await client.createPullRequest({
      base: 'main',
      head: 'kaizen/issue-1-x',
      title: 'title',
      body: 'Closes #1',
      expectedClosingIssueNumber: 1
    });

    expect(pr).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7 });
    expect(runner.mock.calls[0][1]).not.toContain('--draft');
    expect(runner.mock.calls[1][1]).toEqual(['repo', 'view', '--json', 'defaultBranchRef']);
    expect(runner.mock.calls[2][1]).toEqual([
      'pr',
      'view',
      '7',
      '--json',
      'number,url,baseRefName,isDraft,closingIssuesReferences'
    ]);
  });

  it('rejects a created pull request that does not target the repository default branch', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'repo') {
        return ghResult(command, args, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return ghResult(
          command,
          args,
          JSON.stringify({
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            baseRefName: 'release',
            isDraft: false,
            closingIssuesReferences: [{ number: 1 }]
          })
        );
      }
      return ghResult(command, args, 'https://github.com/o/r/pull/7\n');
    });
    const client = new GitHubClient(runner, '/repo');

    await expect(
      client.createPullRequest({
        base: 'release',
        head: 'kaizen/issue-1-x',
        title: 'title',
        body: 'Closes #1',
        expectedClosingIssueNumber: 1
      })
    ).rejects.toThrow('expected repository default branch main');
  });

  it('rejects a created pull request that is still a draft', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'repo') {
        return ghResult(command, args, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return ghResult(
          command,
          args,
          JSON.stringify({
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            baseRefName: 'main',
            isDraft: true,
            closingIssuesReferences: [{ number: 1 }]
          })
        );
      }
      return ghResult(command, args, 'https://github.com/o/r/pull/7\n');
    });
    const client = new GitHubClient(runner, '/repo');

    await expect(
      client.createPullRequest({
        base: 'main',
        head: 'kaizen/issue-1-x',
        title: 'title',
        body: 'Closes #1',
        expectedClosingIssueNumber: 1
      })
    ).rejects.toThrow('pull request is a draft');
  });

  it('rejects a created pull request without recognized closing issue linkage', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'repo') {
        return ghResult(command, args, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return ghResult(
          command,
          args,
          JSON.stringify({
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            baseRefName: 'main',
            isDraft: false,
            closingIssuesReferences: []
          })
        );
      }
      return ghResult(command, args, 'https://github.com/o/r/pull/7\n');
    });
    const client = new GitHubClient(runner, '/repo');

    const create = client.createPullRequest({
        base: 'main',
        head: 'kaizen/issue-1-x',
        title: 'title',
        body: 'Closes #1',
        expectedClosingIssueNumber: 1
      });
    await expect(create).rejects.toThrow('closing issue reference #1 was not recognized by GitHub');
    await expect(create).rejects.toMatchObject({
      pr: { url: 'https://github.com/o/r/pull/7', number: 7 }
    });
    await expect(create).rejects.toBeInstanceOf(CreatedPullRequestValidationError);
  });

  it('lists open pull requests for backlog limiting', async () => {
    const previousGhToken = process.env.GH_TOKEN;
    const previousSecretToken = process.env.SECRET_TOKEN;
    process.env.GH_TOKEN = 'token-only-auth';
    process.env.SECRET_TOKEN = 'do-not-pass';
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 7,
          headRefName: 'kaizen/issue-1-x',
          headRepositoryOwner: { login: 'o' },
          createdAt: '2026-07-01T00:00:00Z',
          url: 'https://github.com/o/r/pull/7'
        }
      ]),
      stderr: '',
      durationMs: 1
    }));
    try {
      const client = new GitHubClient(runner, '/repo');

      const prs = await client.listOpenPullRequests(3);

      expect(prs).toEqual([
        {
          number: 7,
          headRefName: 'kaizen/issue-1-x',
          headRepositoryOwner: { login: 'o' },
          createdAt: '2026-07-01T00:00:00Z',
          url: 'https://github.com/o/r/pull/7'
        }
      ]);
      expect(runner.mock.calls[0][1]).toEqual([
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,headRefName,headRepositoryOwner,createdAt,url',
        '--limit',
        '3'
      ]);
      expect(runner.mock.calls[0][2]?.env?.GH_TOKEN).toBe('token-only-auth');
      expect(runner.mock.calls[0][2]?.env?.SECRET_TOKEN).toBeUndefined();
    } finally {
      if (previousGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
      if (previousSecretToken === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = previousSecretToken;
    }
  });

  it('searches owner pull requests for generated backlog metrics', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                headRefName: 'codex/sync-kaizen-shared-skills',
                createdAt: '2026-07-01T00:00:00Z',
                author: { login: 'github-actions[bot]', __typename: 'Bot' },
                repository: { nameWithOwner: 'o/r' },
                url: 'https://github.com/o/r/pull/7'
              }
            ]
          }
        }
      }),
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    const prs = await client.searchOpenPullRequestsForOwner('o', 5);

    expect(prs[0]).toMatchObject({
      number: 7,
      headRefName: 'codex/sync-kaizen-shared-skills',
      createdAt: '2026-07-01T00:00:00Z',
      author: { login: 'github-actions[bot]', type: 'Bot' },
      repository: { nameWithOwner: 'o/r' }
    });
    expect(runner.mock.calls[0][1]).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringContaining('query='),
      '-F',
      'searchQuery=is:pr is:open owner:o',
      '-F',
      'limit=5'
    ]);
  });

  it('preserves the base label when an optional target repo label is missing', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      const labelValue = String(args.at(args.indexOf('--label') + 1));
      if (labelValue.includes('kaizen:P2')) {
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
    expect(issue.labels).toEqual([{ name: 'kaizen' }]);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][1]).toContain('--label');
    expect(runner.mock.calls[1][1]).toContain('--label');
    expect(runner.mock.calls[1][1]).toContain('kaizen');
    expect(runner.mock.calls[1][1]).toContain('--repo');
    expect(runner.mock.calls[1][1]).toContain('kaizen-agents-org/verifier');
  });

  it('preserves a custom base label when optional labels are missing', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      const labelValue = String(args.at(args.indexOf('--label') + 1));
      if (labelValue.includes('custom:P2')) {
        throw new Error('GraphQL: Could not resolve to a Label with the name custom:P2');
      }
      return {
        command,
        args,
        exitCode: 0,
        stdout: 'https://github.com/o/r/issues/78\n',
        stderr: '',
        durationMs: 1
      };
    });
    const client = new GitHubClient(runner, '/repo');

    const issue = await client.createIssue({
      repo: 'o/r',
      title: 'follow-up',
      body: 'details',
      labels: ['custom:kaizen', 'custom:P2']
    });

    expect(issue.labels).toEqual([{ name: 'custom:kaizen' }]);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][1]).toContain('custom:kaizen');
  });

  it('searches by title before broad fuzzy duplicate matching', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      const hasSearch = args.includes('--search');
      return {
        command,
        args,
        exitCode: 0,
        stdout: hasSearch
          ? '[]'
          : JSON.stringify([
              {
                number: 20,
                title: '[monitor] Add baseline CI for kaizen-loop pull requests',
                body: 'Run npm test, npm run typecheck, and npm run build for PRs.',
                labels: [],
                createdAt: '2026-06-12T00:00:00Z',
                comments: [],
                url: 'https://github.com/kaizen-agents-org/kaizen-loop/issues/20'
              }
            ]),
        stderr: '',
        durationMs: 1
      };
    });
    const client = new GitHubClient(runner, '/repo');

    const issue = await client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/kaizen-loop',
      title: '[monitor] Add GitHub CI checks for PR validation'
    });

    expect(issue?.number).toBe(20);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][1]).toContain('--search');
    expect(runner.mock.calls[0][1]).toContain('in:title "[monitor] Add GitHub CI checks for PR validation"');
    expect(runner.mock.calls[1][1]).not.toContain('--search');
  });

  it('returns exact-title matches from targeted search', async () => {
    const existingIssue = {
      number: 77,
      title: 'follow-up',
      body: 'details',
      labels: [],
      createdAt: '2026-06-12T00:00:00Z',
      comments: [],
      url: 'https://github.com/kaizen-agents-org/verifier/issues/77'
    };
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify([existingIssue]),
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    const issue = await client.findOpenIssueByTitle({ repo: 'kaizen-agents-org/verifier', title: 'follow-up' });

    expect(issue).toEqual(existingIssue);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('matches equivalent open monitor issues when wording differs', async () => {
    const existingIssue = {
      number: 20,
      title: '[monitor] Add baseline CI for kaizen-loop pull requests',
      body: 'Run npm test, npm run typecheck, and npm run build for PRs.',
      labels: [],
      createdAt: '2026-06-12T00:00:00Z',
      comments: [],
      url: 'https://github.com/kaizen-agents-org/kaizen-loop/issues/20'
    };
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify([
        existingIssue,
        {
          number: 26,
          title: '[monitor] Clarify source-of-truth remotes for kaizen-loop and verifier',
          body: 'Document canonical remotes.',
          labels: [],
          createdAt: '2026-06-12T00:00:00Z',
          comments: []
        }
      ]),
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    const issue = await client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/kaizen-loop',
      title: '[monitor] Add GitHub CI checks for PR validation'
    });

    expect(issue?.number).toBe(20);
  });

  it('does not match unrelated open monitor issues', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 26,
          title: '[monitor] Clarify source-of-truth remotes for kaizen-loop and verifier',
          body: 'Document canonical remotes.',
          labels: [],
          createdAt: '2026-06-12T00:00:00Z',
          comments: []
        }
      ]),
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    const issue = await client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/kaizen-loop',
      title: '[monitor] Add GitHub CI checks for PR validation'
    });

    expect(issue).toBeUndefined();
  });

  it('does not match an existing monitor issue against a non-monitor target', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: args.includes('--search')
        ? '[]'
        : JSON.stringify([
            {
              number: 20,
              title: '[monitor] Add baseline CI for kaizen-loop pull requests',
              body: 'Run npm test, npm run typecheck, and npm run build for PRs.',
              labels: [],
              createdAt: '2026-06-12T00:00:00Z',
              comments: [],
              url: 'https://github.com/kaizen-agents-org/kaizen-loop/issues/20'
            }
          ]),
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    const issue = await client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/kaizen-loop',
      title: 'Add GitHub CI checks for PR validation'
    });

    expect(issue).toBeUndefined();
  });
});

function ghResult(command: string, args: string[], stdout: string) {
  return {
    command,
    args,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1
  };
}
