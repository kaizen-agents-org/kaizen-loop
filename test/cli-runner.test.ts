import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../src/github/client.js';
import {
  processCommandRunner,
  type CommandRunner
} from '../src/utils/command.js';

describe('CLI command runner', () => {
  it('attaches startup-resolved executables before GitHubClient uses the runner', async () => {
    const baseRunner = vi.fn<CommandRunner>(async (command, args, options) => ({
      command,
      args,
      cwd: options?.cwd,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1
    }));
    const runner = processCommandRunner(baseRunner, {
      git: '/trusted/bin/git',
      githubCli: '/trusted/bin/gh'
    });

    await new GitHubClient(runner, '/repo').authStatus();

    expect(baseRunner).toHaveBeenCalledWith(
      '/trusted/bin/gh',
      ['auth', 'status'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });
});
