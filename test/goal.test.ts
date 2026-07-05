import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { createGoal, goalStatus, listGoals, runGoalCommand, stopGoal } from '../src/commands/goal.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import { createGoalState, goalDir } from '../src/goals/state.js';
import type { CommandRunner } from '../src/utils/command.js';
import { resolveKaizenTempDir } from '../src/utils/temp.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('goal commands', () => {
  it('rejects missing or blank success criteria', async () => {
    const { repo } = await setupProject();
    const base = {
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      constraints: []
    };

    await expect(createGoal({ ...base, successCriteria: [] })).rejects.toThrow(
      /At least one --success criterion is required/
    );
    await expect(createGoal({ ...base, successCriteria: ['  '] })).rejects.toThrow(
      /At least one --success criterion is required/
    );
  });

  it('creates, lists, reads, and stops a goal', async () => {
    const { repo } = await setupProject();

    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: ['Do not change secrets']
    });

    expect(goal.status).toBe('active');
    expect(goal.maxIterations).toBe(3);
    expect(goal.successCriteria).toEqual(['npm test passes']);

    await expect(goalStatus({ cwd: repo, project: 'o-r', goalId: goal.id })).resolves.toMatchObject({ id: goal.id });
    await expect(listGoals({ cwd: repo, project: 'o-r' })).resolves.toHaveLength(1);

    const stopped = await stopGoal({ cwd: repo, project: 'o-r', goalId: goal.id, reason: 'manual pause' });
    expect(stopped.status).toBe('stopped');
    expect(stopped.stoppedReason).toBe('manual pause');
  });

  it('runs one goal iteration through a goal-linked issue and marks the goal succeeded', async () => {
    const { repo, workspace } = await setupProject();
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'succeeded' });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('succeeded');
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]).toMatchObject({
      issue: 42,
      outcome: 'succeeded'
    });

    const issueCreate = runner.mock.calls.find(([command, args]) => command === 'gh' && args[0] === 'issue' && args[1] === 'create');
    expect(issueCreate?.[1]).toContain('--label');
    expect(String(issueCreate?.[1].at(-1))).toContain('kaizen:goal');
    expect(String(issueCreate?.[1].at(5))).toContain(`"goalId":"${goal.id}"`);
    expect(String(issueCreate?.[1].at(5))).toContain('## Success Criteria');

    const plannerCalls = runner.mock.calls.filter(([command, , options]) => command === 'goal-agent' && options?.env?.KAIZEN_GOAL_MODE === 'planner');
    const evaluatorCalls = runner.mock.calls.filter(([command, , options]) => command === 'goal-agent' && options?.env?.KAIZEN_GOAL_MODE === 'evaluator');
    expect(plannerCalls).toHaveLength(1);
    expect(evaluatorCalls).toHaveLength(1);
  });

  it('preserves milliseconds in generated goal ids', async () => {
    await setupProject();

    const first = await createGoalState({
      projectSlug: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: [],
      maxIterations: 3,
      now: new Date('2026-06-18T00:00:00.001Z')
    });
    const second = await createGoalState({
      projectSlug: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: [],
      maxIterations: 3,
      now: new Date('2026-06-18T00:00:00.002Z')
    });

    expect(first.id).toContain('20260618T000000001Z');
    expect(second.id).toContain('20260618T000000002Z');
    expect(first.id).not.toBe(second.id);
  });

  it('blocks an active goal when maxIterations is reached', async () => {
    const { repo, workspace } = await setupProject({ maxIterations: 1 });
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['coverage >= 80'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'continue' });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('blocked');
    expect(result.finalReason).toBe('maxIterations(1) reached');
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].outcome).toBe('processed');
  });

  it('rejects concurrent runs with a goal-level lock', async () => {
    const { repo } = await setupProject();
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: []
    });
    await fs.mkdir(goalDir('o-r', goal.id), { recursive: true });
    await fs.writeFile(path.join(goalDir('o-r', goal.id), 'goal.lock'), JSON.stringify({ pid: process.pid }));
    const runner = vi.fn<CommandRunner>(async (command, args, runOptions) => result(command, args, runOptions?.cwd, ''));

    await expect(runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    })).rejects.toThrow(/Kaizen goal is already active/);

    expect(runner).not.toHaveBeenCalledWith('goal-agent', expect.anything(), expect.anything());
    await expect(goalStatus({ cwd: repo, project: 'o-r', goalId: goal.id })).resolves.toMatchObject({ status: 'active' });
  });

  it('marks the current iteration and goal failed when the issue pipeline throws', async () => {
    const { repo, workspace } = await setupProject();
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'succeeded', failRunPipeline: true });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('failed');
    expect(result.finalReason).toContain('remote unavailable');
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]).toMatchObject({
      issue: 42,
      outcome: 'failed'
    });
  });

  it('does not call the evaluator when runKaizen returns a failed issue summary', async () => {
    const { repo, workspace } = await setupProject();
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'succeeded', noDiff: true });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('failed');
    expect(result.finalReason).toContain('Agent produced no changes');
    expect(result.iterations[0]).toMatchObject({
      issue: 42,
      outcome: 'failed'
    });
    const evaluatorCalls = runner.mock.calls.filter(([command, , options]) => command === 'goal-agent' && options?.env?.KAIZEN_GOAL_MODE === 'evaluator');
    expect(evaluatorCalls).toHaveLength(0);
  });

  it('marks the goal failed when planner output is invalid before an issue is created', async () => {
    const { repo, workspace } = await setupProject();
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'succeeded', invalidPlanner: true });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('failed');
    expect(result.finalReason).toContain('Goal planner failed');
    expect(result.iterations).toHaveLength(0);
    const issueCreates = runner.mock.calls.filter(([command, args]) => command === 'gh' && args[0] === 'issue' && args[1] === 'create');
    expect(issueCreates).toHaveLength(0);
  });

  it('rejects running a stopped goal', async () => {
    const { repo } = await setupProject();
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: []
    });
    await stopGoal({ cwd: repo, project: 'o-r', goalId: goal.id, reason: 'manual stop' });
    const runner = vi.fn<CommandRunner>(async (command, args, runOptions) => result(command, args, runOptions?.cwd, ''));

    await expect(runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    })).rejects.toThrow(/only active goals can run/);
  });

  it('marks the current iteration and goal failed when evaluator output is invalid', async () => {
    const { repo, workspace } = await setupProject();
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['npm test passes'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'succeeded', invalidEvaluator: true });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('failed');
    expect(result.finalReason).toContain('Goal evaluator agent did not return a valid JSON payload');
    expect(result.iterations[0].outcome).toBe('failed');
  });

  it('does not allow AI evaluator success when the mechanical goal evaluation command fails', async () => {
    const { repo, workspace } = await setupProject({ maxIterations: 1, evaluationCommand: 'npm run goal-check' });
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['goal-check passes'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'succeeded', failMechanicalEvaluation: true });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('blocked');
    expect(result.finalReason).toBe('maxIterations(1) reached');
    expect(result.iterations[0].outcome).toBe('processed');
    expect(result.iterations[0].mechanicalEvaluation).toMatchObject({
      command: 'npm run goal-check',
      ok: false
    });
    expect(result.iterations[0].evaluation).toMatchObject({
      status: 'continue',
      reason: 'Goal evaluation command failed: npm run goal-check'
    });
    const gitCommands = runner.mock.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
    expect(gitCommands).toContain('checkout --ignore-other-worktrees kaizen/issue-42-add-onboarding-smoke-test');
    expect(gitCommands).toContain('checkout --ignore-other-worktrees main');
    const mechanicalCall = runner.mock.calls.find(([command, args]) => command === 'sh' && args.join(' ') === '-lc npm run goal-check');
    expect(mechanicalCall?.[2]?.cwd).toBe(workspace);
  });

  it('includes previous mechanical evaluation failure output in the next iteration issue body', async () => {
    const { repo, workspace } = await setupProject({ maxIterations: 2, evaluationCommand: 'npm run goal-check' });
    const goal = await createGoal({
      cwd: repo,
      project: 'o-r',
      title: 'Improve onboarding',
      description: 'Make first-run setup reliable.',
      successCriteria: ['goal-check passes'],
      constraints: []
    });
    const runner = goalRunner({ repo, workspace, evaluationStatus: 'succeeded', failMechanicalEvaluation: true });

    const result = await runGoalCommand({
      cwd: repo,
      project: 'o-r',
      goalId: goal.id,
      assumeYes: true,
      json: true,
      runCommand: runner
    });

    expect(result.status).toBe('blocked');
    expect(result.finalReason).toBe('maxIterations(2) reached');
    expect(result.iterations).toHaveLength(2);

    const issueCreates = runner.mock.calls.filter(([command, args]) => command === 'gh' && args[0] === 'issue' && args[1] === 'create');
    expect(issueCreates).toHaveLength(2);
    const firstBody = issueBodyArg(issueCreates[0][1]);
    const secondBody = issueBodyArg(issueCreates[1][1]);
    expect(firstBody).not.toContain('## Previous Mechanical Evaluation Failure');
    expect(secondBody).toContain('## Previous Mechanical Evaluation Failure');
    expect(secondBody).toContain('### Command');
    expect(secondBody).toContain('    npm run goal-check');
    expect(secondBody).toContain('### Output');
    expect(secondBody).toContain('    goal check failed');
  });
});

async function setupProject(options: { maxIterations?: number; evaluationCommand?: string } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), configYaml(options));
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

function configYaml(options: { maxIterations?: number; evaluationCommand?: string }) {
  const config = parse(defaultConfigYaml({ agent: 'claude', setup: null, verify: [] }));
  config.verifier.enabled = false;
  config.guardian.enabled = false;
  config.goal.maxIterations = options.maxIterations ?? 3;
  config.goal.evaluation.command = options.evaluationCommand ?? null;
  config.goal.agent.command = 'goal-agent';
  config.goal.agent.args = [];
  return stringify(config);
}

function goalRunner(options: {
  repo: string;
  workspace: string;
  evaluationStatus: 'succeeded' | 'continue';
  failRunPipeline?: boolean;
  noDiff?: boolean;
  invalidPlanner?: boolean;
  invalidEvaluator?: boolean;
  failMechanicalEvaluation?: boolean;
}) {
  return vi.fn<CommandRunner>(async (command, args, runOptions) => {
    if (command === 'goal-agent') {
      const expectedTmpDir = resolveKaizenTempDir(runOptions?.cwd, runOptions?.env);
      expect(runOptions?.env?.TMPDIR).toBe(expectedTmpDir);
      expect(runOptions?.env?.TMP).toBe(expectedTmpDir);
      expect(runOptions?.env?.TEMP).toBe(expectedTmpDir);
      const mode = runOptions?.env?.KAIZEN_GOAL_MODE;
      if (mode === 'planner') {
        if (!options.invalidPlanner) {
          await writeJsonResult(runOptions?.env?.KAIZEN_GOAL_RESULT_PATH, {
            status: 'issue',
            reason: 'First scoped step',
            nextIssue: {
              title: 'Add onboarding smoke test',
              body: 'Add a small smoke test for first-run setup.',
              priority: 'P2'
            }
          });
        }
      } else if (!options.invalidEvaluator) {
        await writeJsonResult(runOptions?.env?.KAIZEN_GOAL_RESULT_PATH, {
          status: options.evaluationStatus,
          confidence: options.evaluationStatus === 'succeeded' ? 0.9 : 0.4,
          reason: options.evaluationStatus === 'succeeded' ? 'All criteria are satisfied.' : 'More work is needed.',
          satisfiedCriteria: options.evaluationStatus === 'succeeded' ? ['npm test passes'] : [],
          missingCriteria: options.evaluationStatus === 'succeeded' ? [] : ['coverage >= 80']
        });
      }
      return result(command, args, runOptions?.cwd, '');
    }

    if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      return result(command, args, options.repo, 'https://github.com/o/r/issues/42\n');
    }
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return result(command, args, options.repo, JSON.stringify(issue(Number(args[2]))));
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return result(command, args, options.repo, 'https://github.com/o/r/pull/9\n');
    }
    if (command === 'gh') return githubReadinessResult(command, args, options.repo);

    if (command === 'builder-agent' && args[0] === '--version') return result(command, args, options.workspace, 'ok');
    if (command === 'builder-agent') {
      await writeJsonResult(runOptions?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: 'fixed', notes: '' });
      return result(command, args, runOptions?.cwd, 'built');
    }

    if (command === 'git' && args.join(' ') === 'remote get-url origin') {
      if (options.failRunPipeline) throw new Error('remote unavailable');
      return result(command, args, options.repo, 'https://github.com/o/r.git\n');
    }
    if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, runOptions?.cwd, '');
    if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, runOptions?.cwd, options.noDiff ? '' : 'src/file.ts\n');
    if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, runOptions?.cwd, options.noDiff ? '' : '1\t0\tsrc/file.ts\n');
    if (command === 'sh' && args.join(' ') === '-lc npm run goal-check') {
      return {
        ...result(command, args, runOptions?.cwd, options.failMechanicalEvaluation ? 'goal check failed' : 'goal check passed'),
        exitCode: options.failMechanicalEvaluation ? 1 : 0
      };
    }
    return result(command, args, runOptions?.cwd, '');
  });
}

function issue(number: number) {
  return {
    number,
    title: 'Add onboarding smoke test',
    body: '',
    labels: [{ name: 'kaizen' }, { name: 'kaizen:goal' }, { name: 'kaizen:P2' }],
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

function githubReadinessResult(command: string, args: string[], cwd: string | undefined) {
  if (args[0] === 'repo' && args[1] === 'view') {
    return result(command, args, cwd, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    return result(
      command,
      args,
      cwd,
      JSON.stringify({
        number: Number(args[2]),
        url: `https://github.com/o/r/pull/${args[2]}`,
        baseRefName: 'main',
        isDraft: false,
        closingIssuesReferences: [{ number: 42 }]
      })
    );
  }
  return result(command, args, cwd, '');
}

function issueBodyArg(args: string[]) {
  return String(args[args.indexOf('--body') + 1]);
}

async function writeJsonResult(filePath: unknown, payload: unknown) {
  if (typeof filePath !== 'string') throw new Error('missing result path');
  await fs.writeFile(filePath, JSON.stringify(payload));
}
