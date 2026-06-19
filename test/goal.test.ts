import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoal, getGoalStatus, listGoals, runGoal, stopGoal } from '../src/commands/goal.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('goal commands', () => {
  it('persists, lists, and stops local goal state under KAIZEN_HOME', async () => {
    const { home, repo } = await setupProject();

    const created = await createGoal({
      cwd: repo,
      project: 'o-r',
      objective: 'Make onboarding reliable',
      maxIterations: 2
    });

    expect(created.status).toBe('active');
    expect(created.maxIterations).toBe(2);
    await expect(fs.access(path.join(home, 'projects', 'o-r', 'goals', `${created.id}.json`))).resolves.toBeUndefined();

    const listed = await listGoals({ cwd: repo, project: 'o-r' });
    expect(listed.map((goal) => goal.id)).toEqual([created.id]);

    const stopped = await stopGoal({ cwd: repo, project: 'o-r', goalId: created.id, reason: 'No longer needed' });
    expect(stopped.status).toBe('stopped');
    expect(stopped.stoppedReason).toBe('No longer needed');

    const status = await getGoalStatus({ cwd: repo, project: 'o-r', goalId: created.id });
    expect(status.status).toBe('stopped');
  });

  it('uses a mechanical evaluator to create a Goal-linked issue and finish the goal', async () => {
    const { repo, workspace } = await setupProject({
      config: defaultConfigYaml({ agent: 'claude', setup: null, verify: [] })
        .replace('goalEvaluate: null', 'goalEvaluate: goal-eval')
        .replace('verifier:\n  enabled: true', 'verifier:\n  enabled: false')
        .replace('guardian:\n  enabled: true', 'guardian:\n  enabled: false')
    });
    const created = await createGoal({ cwd: repo, project: 'o-r', objective: 'Ship goal orchestration' });
    const calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd, env: options?.env });
      if (command === 'sh' && args.join(' ') === '-lc goal-eval') {
        const payload = options?.env?.KAIZEN_GOAL_PHASE === 'before'
          ? {
              status: 'continue',
              summary: 'Create the next issue.',
              nextIssue: {
                title: 'Scoped goal step',
                body: 'Do one scoped Goal step.',
                priority: 'P1',
                labels: ['area:goal']
              }
            }
          : { status: 'succeeded', summary: 'Goal is complete.' };
        return result(command, args, options?.cwd, `${JSON.stringify(payload)}\n`);
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/issues/14\n');
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(14, 'Scoped goal step')));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh') return result(command, args, repo, '');
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: 'goal fixed', notes: '' });
        return result(command, args, options?.cwd, 'built');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, options?.cwd, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, options?.cwd, 'src/goal.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, options?.cwd, '3\t1\tsrc/goal.ts\n');
      return result(command, args, options?.cwd, '');
    });

    const finished = await runGoal({
      cwd: repo,
      project: 'o-r',
      goalId: created.id,
      maxIterations: 1,
      json: true,
      runCommand: runner
    });

    expect(finished.status).toBe('succeeded');
    expect(finished.issueNumbers).toEqual([14]);
    expect(finished.lastEvaluation?.summary).toBe('Goal is complete.');
    const createArgs = calls.find((call) => call.command === 'gh' && call.args.join(' ').startsWith('issue create'))?.args;
    expect(createArgs?.[createArgs.indexOf('--label') + 1]).toBe('kaizen,kaizen:P1,kaizen:goal,area:goal,kaizen:ready,kaizen:pr-only');
    expect(createArgs?.[createArgs.indexOf('--body') + 1]).toContain('kaizen-goal');
    expect(calls.some((call) => call.command === 'builder-agent' && call.args.length === 0)).toBe(true);
  });
});

async function setupProject(options: { config?: string } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), options.config ?? defaultConfigYaml({ agent: 'claude', setup: null, verify: [] }));
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
  return { home, repo, workspace };
}

function issue(number: number, title: string) {
  return {
    number,
    title,
    body: '',
    labels: [{ name: 'kaizen' }, { name: 'kaizen:P1' }, { name: 'kaizen:ready' }, { name: 'kaizen:pr-only' }],
    createdAt: '2026-06-12T00:00:00Z',
    comments: [],
    url: `https://github.com/o/r/issues/${number}`
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

async function writeJsonResult(filePath: unknown, payload: unknown) {
  if (typeof filePath !== 'string') throw new Error('missing result path');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload));
}
