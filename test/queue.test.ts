import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listQueuedIssues, queueIssues, unqueueIssues } from '../src/commands/queue.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('queueIssues', () => {
  it('adds the base, configured authorization, and queue labels to each issue', async () => {
    const { repo } = await setupProject({ authorizationLabel: 'kaizen:trusted' });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => result(command, args, options?.cwd, ''));

    const output = await queueIssues({
      cwd: repo,
      project: 'o-r',
      issues: [3, 3, 4],
      runCommand: runner
    });

    expect(output).toEqual({ queued: [3, 4], labels: ['kaizen', 'kaizen:trusted', 'kaizen:ready'] });
    const labelCreates = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('label create'));
    expect(labelCreates.map(([, args]) => args[2])).toEqual(['kaizen', 'kaizen:trusted', 'kaizen:ready']);
    const edits = runner.mock.calls.filter(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue edit'));
    expect(edits.map(([, args]) => [args[2], args.at(-1)])).toEqual([
      ['3', 'kaizen,kaizen:trusted,kaizen:ready'],
      ['4', 'kaizen,kaizen:trusted,kaizen:ready']
    ]);
  });
});

describe('unqueueIssues', () => {
  it('removes only the queue label', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => result(command, args, options?.cwd, ''));

    const output = await unqueueIssues({
      cwd: repo,
      project: 'o-r',
      issues: [8],
      runCommand: runner
    });

    expect(output).toEqual({ unqueued: [8], label: 'kaizen:ready' });
    const edit = runner.mock.calls.find(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue edit'));
    expect(edit?.[1]).toEqual(['issue', 'edit', '8', '--remove-label', 'kaizen:ready']);
  });
});

describe('listQueuedIssues', () => {
  it('lists queued issues that have the base and configured authorization labels', async () => {
    const { repo } = await setupProject({ authorizationLabel: 'kaizen:trusted' });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return result(command, args, repo, JSON.stringify([
          issue(1, ['kaizen', 'kaizen:trusted', 'kaizen:ready']),
          issue(2, ['kaizen', 'kaizen:ready']),
          issue(3, ['kaizen:trusted', 'kaizen:ready'])
        ]));
      }
      return result(command, args, options?.cwd, '');
    });

    const output = await listQueuedIssues({
      cwd: repo,
      project: 'o-r',
      runCommand: runner
    });

    expect(output.label).toBe('kaizen:ready');
    expect(output.issues.map((item) => item.number)).toEqual([1]);
    const list = runner.mock.calls.find(([command, args]) => command === 'gh' && args.join(' ').startsWith('issue list'));
    expect(list?.[1]).toContain('--label');
    expect(list?.[1]).toContain('kaizen:ready');
  });
});

async function setupProject(options: { authorizationLabel?: string } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  let config = defaultConfigYaml({ agent: 'claude', setup: null, verify: [] });
  if (options.authorizationLabel) {
    config = config.replace('label: kaizen:authorized', `label: ${options.authorizationLabel}`);
  }
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), config);
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
  return { repo };
}

function issue(number: number, labels: string[]) {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    labels: labels.map((name) => ({ name })),
    createdAt: '2026-06-12T00:00:00Z',
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
