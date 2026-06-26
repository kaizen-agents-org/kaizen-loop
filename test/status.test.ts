import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { statusProject } from '../src/commands/status.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('statusProject', () => {
  it('reports pushed remote branches with no open pull request', async () => {
    const { repo, workspace } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, '[]');
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return result(
          command,
          args,
          repo,
          JSON.stringify([
            {
              number: 4,
              headRefName: 'kaizen/has-pr',
              headRepositoryOwner: { login: 'o' },
              url: 'https://github.com/o/r/pull/4'
            },
            {
              number: 5,
              headRefName: 'feature/fork-pr',
              headRepositoryOwner: { login: 'contributor' },
              url: 'https://github.com/o/r/pull/5'
            }
          ])
        );
      }
      if (command === 'git' && args.join(' ') === 'fetch --prune origin') {
        return result(command, args, workspace, '');
      }
      if (command === 'git' && args.join(' ') === 'for-each-ref --format=%(refname:short)%09%(objectname:short) refs/remotes/origin') {
        return result(
          command,
          args,
          workspace,
          [
            'origin/HEAD\t1111111',
            'origin/main\t2222222',
            'origin/codex/hidden-work\t3333333',
            'origin/kaizen/has-pr\t4444444',
            'origin/feature/no-diff\t5555555',
            'origin/feature/fork-pr\t6666666'
          ].join('\n')
        );
      }
      if (command === 'git' && args.join(' ') === 'rev-list --left-right --count origin/main...origin/codex/hidden-work') {
        return result(command, args, workspace, '23\t2\n');
      }
      if (command === 'git' && args.join(' ') === 'rev-list --left-right --count origin/main...origin/feature/no-diff') {
        return result(command, args, workspace, '0\t0\n');
      }
      if (command === 'git' && args.join(' ') === 'rev-list --left-right --count origin/main...origin/feature/fork-pr') {
        return result(command, args, workspace, '1\t3\n');
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const output = await statusProject({
      cwd: repo,
      project: 'o-r',
      runCommand: runner
    });

    expect(output.pullRequests.open).toBe(2);
    expect(output.branchHygiene).toEqual({
      checked: true,
      unreviewedRemoteBranches: [
        {
          branch: 'codex/hidden-work',
          remoteRef: 'origin/codex/hidden-work',
          headSha: '3333333',
          ahead: 2,
          behind: 23
        },
        {
          branch: 'feature/fork-pr',
          remoteRef: 'origin/feature/fork-pr',
          headSha: '6666666',
          ahead: 3,
          behind: 1
        }
      ]
    });
  });

  it('keeps status available when branch hygiene cannot be checked', async () => {
    const { repo, workspace } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return result(command, args, repo, '[]');
      if (command === 'git' && args.join(' ') === 'fetch --prune origin') {
        throw new Error('workspace is not a git checkout');
      }
      return result(command, args, workspace, '');
    });

    const output = await statusProject({
      cwd: repo,
      project: 'o-r',
      runCommand: runner
    });

    expect(output.branchHygiene.checked).toBe(false);
    expect(output.branchHygiene.unreviewedRemoteBranches).toEqual([]);
    expect(output.branchHygiene.error).toContain('workspace is not a git checkout');
  });
});

async function setupProject() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'claude', setup: null, verify: [] }));
  await saveRegistry({
    version: 1,
    projects: {
      'o-r': {
        repo: 'o/r',
        localPath: repo,
        workspacePath: workspace,
        schedule: '02:00',
        enabled: false,
        createdAt: '2026-06-12T00:00:00Z'
      }
    }
  });
  return { repo, workspace };
}

function result(command: string, args: string[], cwd: string | undefined, stdout: string) {
  return {
    command,
    args,
    cwd,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1
  };
}
