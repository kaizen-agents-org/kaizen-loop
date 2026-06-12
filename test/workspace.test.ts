import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';
import { GitClient } from '../src/workspace/git.js';
import { WorkspaceManager } from '../src/workspace/manager.js';

describe('workspace branch handling', () => {
  it('replaces an existing deterministic issue branch before retrying', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const workspace = new WorkspaceManager(runner, '/workspace', 'https://github.com/o/r.git');
    const config = configSchema.parse({ version: 1 });

    const branch = await workspace.createIssueBranch(config, { number: 12, title: 'Retry branch' });

    expect(branch).toBe('kaizen/issue-12-retry-branch');
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ['branch', '-D', 'kaizen/issue-12-retry-branch'],
      ['switch', '-c', 'kaizen/issue-12-retry-branch']
    ]);
  });

  it('can force-with-lease when pushing regenerated issue branches', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const git = new GitClient(runner, '/workspace');

    await git.push('kaizen/issue-12-retry-branch', { forceWithLease: true });

    expect(runner.mock.calls[0][1]).toEqual([
      'push',
      '-u',
      '--force-with-lease',
      'origin',
      'kaizen/issue-12-retry-branch'
    ]);
  });
});
