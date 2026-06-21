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
      stdout: 'done',
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
    expect(prompt).toContain('no unresolved actionable review feedback remains');
    expect(prompt).toContain('required checks are passing');
    expect(prompt).toContain('unresolved/skipped feedback with reasons');
  });
});
