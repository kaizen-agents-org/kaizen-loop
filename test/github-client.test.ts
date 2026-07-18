import { describe, expect, it, vi } from 'vitest';
import { CreatedPullRequestValidationError, GitHubClient, KAIZEN_LABELS } from '../src/github/client.js';
import { buildDiscoveredIssueFingerprint } from '../src/discovered-issue-fingerprint.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('GitHubClient', () => {
  it('includes the roadmap classification in the default label set', () => {
    expect(KAIZEN_LABELS).toContain('kaizen:roadmap');
  });

  it('returns normalized label transitions for acknowledgement checks', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ghResult(command, args, JSON.stringify([
      [
        {
          event: 'labeled',
          label: { name: 'Kaizen:Needs-Human' },
          actor: { login: 'maintainer' },
          created_at: '2026-07-16T00:00:00Z'
        },
        { event: 'commented', created_at: '2026-07-16T00:00:30Z' }
      ],
      [{ event: 'unlabeled', label: { name: 'kaizen:needs-human' }, created_at: '2026-07-16T00:01:00Z' }]
    ])));

    await expect(new GitHubClient(runner, '/repo').getIssueLabelEvents(
      'o/r', 1, 'kaizen:needs-human'
    )).resolves.toEqual([
      {
        event: 'labeled',
        label: 'Kaizen:Needs-Human',
        actor: 'maintainer',
        createdAt: '2026-07-16T00:00:00Z'
      },
      {
        event: 'unlabeled',
        label: 'kaizen:needs-human',
        actor: undefined,
        createdAt: '2026-07-16T00:01:00Z'
      }
    ]);
  });

  it('accepts an active authorization label applied by a triage maintainer', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'issue') {
        return ghResult(command, args, JSON.stringify(issueWithLabels(['kaizen', 'Kaizen:Authorized'])));
      }
      if (args.at(-1)?.endsWith('/events')) {
        return ghResult(command, args, JSON.stringify([
          [{ event: 'labeled', label: { name: 'kaizen:authorized' }, actor: { login: 'maintainer' } }]
        ]));
      }
      return ghResult(command, args, JSON.stringify({ role_name: 'triage' }));
    });

    const decision = await new GitHubClient(runner, '/repo').checkExecutionAuthorization({
      repo: 'o/r', issue: 1, label: 'kaizen:authorized', minimumPermission: 'triage'
    });

    expect(decision).toMatchObject({ authorized: true, actor: 'maintainer', permission: 'triage' });
    expect(runner.mock.calls[1][1]).toEqual([
      'api', '--paginate', '--slurp', 'repos/o/r/issues/1/events'
    ]);
  });

  it('fails closed when the latest authorization transition is removal', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'issue') return ghResult(command, args, JSON.stringify(issueWithLabels(['kaizen:authorized'])));
      return ghResult(command, args, JSON.stringify([
        [{ event: 'labeled', label: { name: 'kaizen:authorized' }, actor: { login: 'maintainer' } }],
        [{ event: 'unlabeled', label: { name: 'KAIZEN:AUTHORIZED' }, actor: { login: 'maintainer' } }]
      ]));
    });

    const decision = await new GitHubClient(runner, '/repo').checkExecutionAuthorization({
      repo: 'o/r', issue: 1, label: 'kaizen:authorized', minimumPermission: 'triage'
    });

    expect(decision).toEqual({ authorized: false, reason: 'qualifying authorization label event not found: kaizen:authorized' });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('rejects an authorization label applied by a read-only actor', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'issue') return ghResult(command, args, JSON.stringify(issueWithLabels(['kaizen:authorized'])));
      if (args.at(-1)?.endsWith('/events')) {
        return ghResult(command, args, JSON.stringify([
          [{ event: 'labeled', label: { name: 'kaizen:authorized' }, actor: { login: 'reader' } }]
        ]));
      }
      return ghResult(command, args, JSON.stringify({ permission: 'read' }));
    });

    const decision = await new GitHubClient(runner, '/repo').checkExecutionAuthorization({
      repo: 'o/r', issue: 1, label: 'kaizen:authorized', minimumPermission: 'triage'
    });

    expect(decision).toMatchObject({ authorized: false, actor: 'reader', permission: 'read' });
  });

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

  it('creates an explicitly requested draft pull request and can promote it', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'repo') return ghResult(command, args, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'pr' && args[1] === 'view') {
        return ghResult(command, args, JSON.stringify({
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          baseRefName: 'main',
          isDraft: true,
          closingIssuesReferences: [{ number: 1 }]
        }));
      }
      return ghResult(command, args, args[1] === 'create' ? 'https://github.com/o/r/pull/7\n' : '');
    });
    const client = new GitHubClient(runner, '/repo');

    await client.createPullRequest({
      base: 'main',
      head: 'kaizen/issue-1-x',
      title: '[WIP] title',
      body: 'Closes #1',
      expectedClosingIssueNumber: 1,
      draft: true
    });
    await client.editPullRequest(7, { title: 'ready title', body: 'Closes #1\n\nReady.' });
    await client.markPullRequestReady(7);

    expect(runner.mock.calls[0][1]).toContain('--draft');
    expect(runner.mock.calls.at(-2)?.[1]).toEqual(['pr', 'edit', '7', '--title', 'ready title', '--body', 'Closes #1\n\nReady.']);
    expect(runner.mock.calls.at(-1)?.[1]).toEqual(['pr', 'ready', '7']);
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
    await expect(create).rejects.toThrow('closing issue reference #1 was not recognized by GitHub after 5 attempts');
    await expect(create).rejects.toMatchObject({
      pr: { url: 'https://github.com/o/r/pull/7', number: 7 }
    });
    await expect(create).rejects.toBeInstanceOf(CreatedPullRequestValidationError);
  });

  it('retries a newly created pull request until GitHub recognizes its closing issue', async () => {
    let linkageReads = 0;
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[0] === 'repo') return ghResult(command, args, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'pr' && args[1] === 'view') {
        linkageReads += 1;
        return ghResult(command, args, JSON.stringify({
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          baseRefName: 'main',
          isDraft: false,
          closingIssuesReferences: linkageReads === 1 ? [] : [{ number: 1 }]
        }));
      }
      return ghResult(command, args, 'https://github.com/o/r/pull/7\n');
    });

    const pr = await new GitHubClient(runner, '/repo').createPullRequest({
      base: 'main',
      head: 'kaizen/issue-1-x',
      title: 'title',
      body: 'Closes #1',
      expectedClosingIssueNumber: 1
    });

    expect(pr.number).toBe(7);
    expect(linkageReads).toBe(2);
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
        'number,body,baseRefName,headRefName,headRefOid,headRepositoryOwner,createdAt,url,isDraft',
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

  it('lists every open pull request page for guardian discovery', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => restPullRequest(index + 1));
    const managed = restPullRequest(101, {
      body: '<!-- kaizen-pr-guardian:managed -->',
      head: {
        ref: 'codex/daily-dogfood-sync',
        sha: 'managed-head',
        repo: { owner: { login: 'o' } }
      }
    });
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      ghResult(command, args, JSON.stringify([firstPage, [managed]]))
    );

    const pullRequests = await new GitHubClient(runner, '/repo').listAllOpenPullRequests();

    expect(pullRequests).toHaveLength(101);
    expect(pullRequests[100]).toMatchObject({
      number: 101,
      body: '<!-- kaizen-pr-guardian:managed -->',
      headRefName: 'codex/daily-dogfood-sync',
      headRefOid: 'managed-head',
      headRepositoryOwner: { login: 'o' }
    });
    expect(runner.mock.calls[0][1]).toEqual([
      'api',
      '--paginate',
      '--slurp',
      'repos/{owner}/{repo}/pulls?state=open&per_page=100'
    ]);
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

  it('searches owner merged pull requests with commit source fields', async () => {
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
                number: 8,
                headRefName: 'kaizen/issue-8-x',
                createdAt: '2026-07-01T00:00:00Z',
                mergedAt: '2026-07-02T00:00:00Z',
                author: { login: 'github-actions[bot]', __typename: 'Bot' },
                repository: { nameWithOwner: 'o/r' },
                url: 'https://github.com/o/r/pull/8',
                commits: {
                  totalCount: 1,
                  nodes: [{
                    commit: {
                      oid: 'abc123',
                      committedDate: '2026-07-01T01:00:00Z',
                      author: {
                        name: 'Maintainer',
                        email: 'maintainer@example.com',
                        user: { login: 'maintainer', __typename: 'User' }
                      }
                    }
                  }]
                }
              }
            ]
          }
        }
      }),
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    const prs = await client.searchMergedPullRequestsForOwner('o', '2026-07-01', 5);

    expect(prs[0]).toMatchObject({
      number: 8,
      mergedAt: '2026-07-02T00:00:00Z',
      commitCount: 1,
      commits: [{
        oid: 'abc123',
        committedDate: '2026-07-01T01:00:00Z',
        author: { login: 'maintainer', type: 'User' }
      }]
    });
    expect(runner.mock.calls[0][1]).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringContaining('query='),
      '-F',
      'searchQuery=is:pr is:merged owner:o merged:>=2026-07-01',
      '-F',
      'limit=5'
    ]);
  });

  it('paginates merged pull request commits before returning metrics data', async () => {
    const firstPageCommits = Array.from({ length: 100 }, (_, index) => ({
      commit: {
        oid: `generated-${index}`,
        committedDate: '2026-07-01T00:00:00Z',
        author: {
          name: 'github-actions[bot]',
          email: '41898282+github-actions[bot]@users.noreply.github.com',
          user: { login: 'github-actions[bot]', __typename: 'Bot' }
        }
      }
    }));
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args.includes('searchQuery=is:pr is:merged owner:o merged:>=2026-07-01')) {
        return ghResult(command, args, JSON.stringify({
          data: {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                number: 8,
                headRefName: 'kaizen/issue-8-x',
                createdAt: '2026-07-01T00:00:00Z',
                mergedAt: '2026-07-02T00:00:00Z',
                repository: { nameWithOwner: 'o/r' },
                url: 'https://github.com/o/r/pull/8',
                commits: {
                  totalCount: 101,
                  pageInfo: { hasNextPage: true, endCursor: 'commit-cursor-100' },
                  nodes: firstPageCommits
                }
              }]
            }
          }
        }));
      }
      return ghResult(command, args, JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  commit: {
                    oid: 'human-follow-up',
                    committedDate: '2026-07-01T01:00:00Z',
                    author: {
                      name: 'Maintainer',
                      email: 'maintainer@example.com',
                      user: { login: 'maintainer', __typename: 'User' }
                    }
                  }
                }]
              }
            }
          }
        }
      }));
    });

    const [pullRequest] = await new GitHubClient(runner, '/repo')
      .searchMergedPullRequestsForOwner('o', '2026-07-01', 5);

    expect(pullRequest.commitCount).toBe(101);
    expect(pullRequest.commits).toHaveLength(101);
    expect(pullRequest.commits?.at(-1)).toMatchObject({
      oid: 'human-follow-up',
      author: { login: 'maintainer', type: 'User' }
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][1]).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringContaining('query='),
      '-F',
      'owner=o',
      '-F',
      'name=r',
      '-F',
      'number=8',
      '-F',
      'cursor=commit-cursor-100'
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

  it('searches goal issue markers with a quote-free goal id token', async () => {
    const marker = '<!-- kaizen-loop:goal {"goalId":"goal-123","iteration":1} -->';
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify([{ number: 9, title: 'Goal issue', body: marker, labels: [], createdAt: '', comments: [] }]),
      stderr: '',
      durationMs: 1
    }));
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByBodyMarker(marker)).resolves.toMatchObject({ number: 9 });
    expect(runner.mock.calls[0][1]).toContain('goal-123 in:body');
    expect(runner.mock.calls[0][1]).not.toContain(expect.stringContaining('"goalId"'));
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

  it('looks up a versioned discovered-issue fingerprint before title matching in the target repository', async () => {
    const fingerprint = buildDiscoveredIssueFingerprint({
      repo: 'kaizen-agents-org/verifier',
      evidence: 'provider=codex path=/opt/codex-host exit=127',
      failureClass: 'command_missing'
    });
    const existingIssue = {
      number: 91,
      title: 'A differently worded provider outage',
      body: fingerprint?.marker,
      labels: [],
      createdAt: '2026-07-12T00:00:00Z',
      comments: [],
      url: 'https://github.com/kaizen-agents-org/verifier/issues/91'
    };
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      const search = String(args.at(args.indexOf('--search') + 1));
      return ghResult(command, args, search.includes('kaizen-loop:discovered-issue:v1') ? JSON.stringify([existingIssue]) : '[]');
    });
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/verifier',
      title: 'Code mode host is unavailable',
      evidence: 'provider=codex path=/opt/codex-host exit=127',
      failureClass: 'command_missing'
    })).resolves.toEqual(existingIssue);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'issue', 'list', '--repo', 'kaizen-agents-org/verifier', '--state', 'open', '--limit', '1000', '--search'
    ]));
    expect(String(runner.mock.calls[0][1].at(runner.mock.calls[0][1].indexOf('--search') + 1)))
      .toContain('kaizen-loop:discovered-issue:v1');
  });

  it('requires an exact, complete fingerprint marker match', async () => {
    const fingerprint = buildDiscoveredIssueFingerprint({
      repo: 'kaizen-agents-org/verifier',
      evidence: 'provider=codex path=/opt/codex-host exit=127',
      failureClass: 'command_missing'
    });
    const runner = vi.fn<CommandRunner>(async (command, args) => ghResult(command, args,
      args.includes('--search') && String(args.at(args.indexOf('--search') + 1)).includes('kaizen-loop:discovered-issue:v1')
        ? JSON.stringify([{
            number: 94, title: 'Near collision', body: `${fingerprint?.marker.slice(0, -4)}-extra -->`,
            labels: [], createdAt: '2026-07-12T00:00:00Z', comments: []
          }])
        : '[]'));
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/verifier', title: 'Host executable missing',
      evidence: 'provider=codex path=/opt/codex-host exit=127', failureClass: 'command_missing'
    })).resolves.toBeUndefined();
  });

  it('rechecks exact fingerprint markers in the broad open-issue fallback', async () => {
    const target = {
      repo: 'kaizen-agents-org/verifier', title: 'Code mode host is unavailable',
      evidence: 'provider=codex path=/opt/codex-host exit=127', failureClass: 'command_missing'
    };
    const existingIssue = {
      number: 96, title: 'Differently titled provider failure',
      body: buildDiscoveredIssueFingerprint(target)?.marker,
      labels: [], createdAt: '2026-07-12T00:00:00Z', comments: [],
      url: 'https://github.com/kaizen-agents-org/verifier/issues/96'
    };
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      ghResult(command, args, args.includes('--search') ? '[]' : JSON.stringify([existingIssue]))
    );
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByTitle(target)).resolves.toEqual(existingIssue);
  });

  it('normalizes only CRLF and whitespace when fingerprinting substantive evidence', async () => {
    const markerSearches: string[] = [];
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args.includes('--search')) markerSearches.push(String(args.at(args.indexOf('--search') + 1)));
      return ghResult(command, args, '[]');
    });
    const client = new GitHubClient(runner, '/repo');
    const base = { repo: 'kaizen-agents-org/verifier', title: 'Provider failed', failureClass: 'timeout' };

    await client.findOpenIssueByTitle({ ...base, evidence: 'request 42\r\n  timed out at https://api.example.test/jobs/42' });
    await client.findOpenIssueByTitle({ ...base, evidence: ' request 42 timed out at https://api.example.test/jobs/42 ' });
    await client.findOpenIssueByTitle({ ...base, evidence: 'request 43 timed out at https://api.example.test/jobs/42' });

    expect(markerSearches[0]).toBe(markerSearches[2]);
    expect(markerSearches[0]).not.toBe(markerSearches[4]);
  });

  it('scopes discovered-issue fingerprints to the target repository', () => {
    const finding = { evidence: 'provider=codex path=/opt/codex-host exit=127', failureClass: 'command_missing' };

    const verifier = buildDiscoveredIssueFingerprint({ ...finding, repo: 'kaizen-agents-org/verifier' });
    const builder = buildDiscoveredIssueFingerprint({ ...finding, repo: 'kaizen-agents-org/builder-agent' });

    expect(verifier?.marker).not.toBe(builder?.marker);
  });

  it('conservatively reuses a legacy unmarked issue only for substantive evidence and the same present failureClass', async () => {
    const legacyIssue = {
      number: 92,
      title: 'Older wording for the outage',
      body: '## Evidence\nprovider=codex path=/opt/codex-host exit=127\n\nfailureClass=command_missing',
      labels: [], createdAt: '2026-07-12T00:00:00Z', comments: [],
      url: 'https://github.com/kaizen-agents-org/verifier/issues/92'
    };
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      ghResult(command, args, args.includes('--search') ? '[]' : JSON.stringify([legacyIssue]))
    );
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/verifier', title: 'Host executable missing',
      evidence: ' provider=codex\r\npath=/opt/codex-host   exit=127 ', failureClass: 'command_missing'
    })).resolves.toEqual(legacyIssue);
  });

  it.each([
    ['candidate class absent', undefined, 'failureClass=command_missing', 'provider=codex path=/opt/codex-host exit=127'],
    ['legacy class absent', 'command_missing', '', 'provider=codex path=/opt/codex-host exit=127'],
    ['different class', 'timeout', 'failureClass=command_missing', 'provider=codex path=/opt/codex-host exit=127'],
    ['different material evidence', 'command_missing', 'failureClass=command_missing', 'provider=codex path=/usr/bin/other-host exit=126'],
    ['generic evidence', 'command_missing', 'failureClass=command_missing', 'error']
  ])('does not evidence-deduplicate when %s', async (_case, failureClass, legacyClass, evidence) => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ghResult(command, args, args.includes('--search')
      ? '[]'
      : JSON.stringify([{
          number: 93, title: 'Unrelated wording',
          body: `## Evidence\nprovider=codex path=/opt/codex-host exit=127\n\n${legacyClass}`,
          labels: [], createdAt: '2026-07-12T00:00:00Z', comments: []
        }])));
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/verifier', title: 'Host executable missing', evidence, failureClass
    })).resolves.toBeUndefined();
  });

  it('does not read failure metadata from a section after Evidence', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ghResult(command, args, args.includes('--search')
      ? '[]'
      : JSON.stringify([{
          number: 95, title: 'Unrelated wording',
          body: '## Evidence\nprovider=codex path=/opt/codex-host exit=127\n\n## Expected\nfailureClass=command_missing',
          labels: [], createdAt: '2026-07-12T00:00:00Z', comments: []
        }])));
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByTitle({
      repo: 'kaizen-agents-org/verifier', title: 'Host executable missing',
      evidence: 'provider=codex path=/opt/codex-host exit=127', failureClass: 'command_missing'
    })).resolves.toBeUndefined();
  });

  it('uses a quote-free goal id when searching for an issue body marker', async () => {
    const marker = '<!-- kaizen-loop:goal {"goalId":"goal-1","iteration":1} -->';
    const existingIssue = {
      number: 77,
      title: 'follow-up',
      body: marker,
      labels: [],
      createdAt: '2026-06-12T00:00:00Z',
      comments: [],
      url: 'https://github.com/o/r/issues/77'
    };
    const runner = vi.fn<CommandRunner>(async (command, args) => ghResult(command, args, JSON.stringify([existingIssue])));
    const client = new GitHubClient(runner, '/repo');

    await expect(client.findOpenIssueByBodyMarker(marker)).resolves.toEqual(existingIssue);
    expect(runner.mock.calls[0][1]).toContain('goal-1 in:body');
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

function restPullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    draft: false,
    body: '',
    base: { ref: 'main' },
    head: {
      ref: `feature/${number}`,
      sha: `head-${number}`,
      repo: { owner: { login: 'o' } }
    },
    user: { login: 's-hiraoku', type: 'User' },
    created_at: '2026-07-01T00:00:00Z',
    html_url: `https://github.com/o/r/pull/${number}`,
    ...overrides
  };
}

function issueWithLabels(labels: string[]) {
  return {
    number: 1,
    title: 'issue',
    body: '',
    labels: labels.map((name) => ({ name })),
    createdAt: '2026-07-01T00:00:00Z',
    comments: []
  };
}
