import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planImprove, runImprove } from '../src/commands/improve.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('planImprove', () => {
  it('plans queued issues with the existing selection rules', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([
          issue(3, 'P2 later', 'kaizen:P2', '2026-06-12T02:00:00Z'),
          issue(1, 'P1 first', 'kaizen:P1', '2026-06-12T03:00:00Z'),
          issue(2, 'P2 earlier', 'kaizen:P2', '2026-06-12T01:00:00Z')
        ]));
      }
      return result(command, args, options?.cwd, '');
    });

    const plan = await planImprove({
      cwd: repo,
      project: 'o-r',
      dryRun: true,
      maxIssues: 2,
      json: true,
      runCommand: runner
    });

    expect(plan.selected.map((item) => item.number)).toEqual([1, 2]);
    expect(plan.skipped).toEqual([{ number: 3, reason: 'maxIssuesPerNight reached' }]);
  });

  it('uses explicit issue numbers as the default max issue limit', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(Number(args[2]), `Issue ${args[2]}`, 'kaizen:P2')));
      }
      return result(command, args, options?.cwd, '');
    });

    const plan = await planImprove({
      cwd: repo,
      project: 'o-r',
      issueNumbers: [4, 5],
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect(plan.selected.map((item) => item.number)).toEqual([4, 5]);
    const issueViewCalls = runner.mock.calls.filter(([, args]) => args[0] === 'issue' && args[1] === 'view');
    expect(issueViewCalls).toHaveLength(2);
  });
});

describe('runImprove', () => {
  it('delegates dry-run execution to the instant improvement path', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(Number(args[2]), `Issue ${args[2]}`, 'kaizen:P2')));
      }
      return result(command, args, options?.cwd, '');
    });

    const output = await runImprove({
      cwd: repo,
      project: 'o-r',
      issueNumbers: [7],
      dryRun: true,
      json: true,
      runCommand: runner
    });

    expect('selected' in output && output.selected[0].number).toBe(7);
  });
});

async function setupProject() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
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

function issue(number: number, title: string, priority: string, createdAt = '2026-06-12T00:00:00Z') {
  return {
    number,
    title,
    body: '',
    labels: [{ name: 'kaizen' }, { name: priority }],
    createdAt,
    comments: []
  };
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
