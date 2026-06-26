import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { runPrGuardianSkill } from '../src/orchestrator/prGuardian.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('runPrGuardianSkill', () => {
  it('requires review feedback to be inspected before declaring a PR mergeable', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 3 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh' ? reviewThreadsResponse([]) : 'done',
      stderr: '',
      durationMs: 1
    }));

    await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    const prompt = String(runner.mock.calls[0][1].at(-1));

    expect(prompt).toContain('Always inspect PR review feedback before declaring the PR mergeable');
    expect(prompt).toContain('PullRequest.reviewThreads');
    expect(prompt).toContain('hasNextPage=false');
    expect(prompt).toContain('no non-outdated unresolved review threads or actionable PR comments remain');
    expect(prompt).toContain('CLEAN/checks passing alone is not enough');
    expect(prompt).toContain('required checks are passing');
    expect(prompt).toContain('unresolved/skipped feedback with reasons');
  });

  it('reruns while unresolved review threads remain and fails after the retry budget', async () => {
    const config = configSchema.parse({
      version: 1,
      guardian: { enabled: true, command: 'codex', timeoutMinutes: 1, maxAttempts: 2 }
    });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: command === 'gh'
        ? reviewThreadsResponse([{ path: 'src/file.ts', line: 12, author: 'reviewer', body: 'Please fix this.' }])
        : 'guardian pass complete',
      stderr: '',
      durationMs: 1
    }));

    const result = await runPrGuardianSkill(runner, {
      config,
      workspaceDir: '/tmp/workspace',
      repo: 'o/r',
      prUrl: 'https://github.com/o/r/pull/4',
      prNumber: 4,
      branch: 'kaizen/issue-1-fix',
      baseBranch: 'main'
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('unresolved review feedback');
    expect(result.raw).toContain('src/file.ts:12 by reviewer');
    expect(runner.mock.calls.filter(([command]) => command === 'codex')).toHaveLength(2);
    expect(runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('api graphql'))).toHaveLength(2);
  });
});

function reviewThreadsResponse(threads: Array<{ path: string; line: number; author: string; body: string }>): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage: false,
              endCursor: null
            },
            nodes: threads.map((thread) => ({
              isResolved: false,
              isOutdated: false,
              path: thread.path,
              line: thread.line,
              comments: {
                nodes: [
                  {
                    body: thread.body,
                    author: {
                      login: thread.author
                    }
                  }
                ]
              }
            }))
          }
        }
      }
    }
  });
}
