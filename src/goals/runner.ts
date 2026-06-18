import { reportIssue } from '../commands/report.js';
import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import type { KaizenConfig } from '../config/schema.js';
import { GitHubClient } from '../github/client.js';
import { runKaizen, type DirectCommitConfirmation } from '../orchestrator/run.js';
import type { RunSummary } from '../orchestrator/summary.js';
import type { CommandRunner } from '../utils/command.js';
import { KaizenError } from '../utils/errors.js';
import { GitClient } from '../workspace/git.js';
import { goalDir, loadGoalState, saveGoalState, touchGoal } from './state.js';
import { GoalAgentAdapter } from './agent.js';
import { GoalLock } from './lock.js';
import { buildGoalEvaluatorPrompt, buildGoalPlannerPrompt } from './prompts.js';
import type { GoalEvaluation, GoalMechanicalEvaluation, GoalNextIssue, GoalPlan, GoalState } from './types.js';

export interface RunGoalOptions {
  cwd: string;
  project?: string;
  goalId: string;
  agent?: 'claude' | 'codex';
  assumeYes?: boolean;
  json: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
  runCommand: CommandRunner;
}

export async function runGoal(options: RunGoalOptions): Promise<GoalState> {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  let goal = await loadGoalState(resolved.slug, options.goalId);
  if (goal.status !== 'active') {
    throw new KaizenError(`Goal ${goal.id} is ${goal.status}; only active goals can run.`, 2);
  }

  const agent = new GoalAgentAdapter(options.runCommand, config.goal.agent);
  const stateDir = goalDir(resolved.slug, goal.id);
  const lock = await GoalLock.acquire(stateDir);

  try {
    goal = await loadGoalState(resolved.slug, options.goalId);
    if (goal.status !== 'active') {
      throw new KaizenError(`Goal ${goal.id} is ${goal.status}; only active goals can run.`, 2);
    }

    while (goal.status === 'active' && goal.iterations.length < goal.maxIterations) {
      const iterationNumber = goal.iterations.length + 1;
      const startedAt = new Date().toISOString();
      let plan: GoalPlan;
      try {
        plan = await planNextIteration({
          goal,
          agent,
          cwd: resolved.project.localPath,
          stateDir
        });
      } catch (error) {
        goal = await finishGoal(resolved.slug, goal, 'failed', `Goal planner failed: ${String(error)}`);
        break;
      }

      if (plan.status === 'succeeded') {
        goal = await finishGoal(resolved.slug, goal, 'succeeded', plan.reason);
        break;
      }
      if (plan.status === 'blocked') {
        goal = await finishGoal(resolved.slug, goal, 'blocked', plan.reason);
        break;
      }

      const issuePlan = plan.nextIssue;
      if (!issuePlan) {
        goal = await finishGoal(resolved.slug, goal, 'blocked', 'Goal planner did not provide nextIssue.');
        break;
      }

      let issue: { number: number; title: string };
      try {
        issue = await createGoalIssue({
          project: options.project,
          cwd: options.cwd,
          repoDir: resolved.project.localPath,
          goal,
          issue: issuePlan,
          iterationNumber,
          issueLabel: config.goal.issueLabel,
          runCommand: options.runCommand
        });
      } catch (error) {
        goal = await finishGoal(resolved.slug, goal, 'failed', `Goal issue creation failed: ${String(error)}`);
        break;
      }

      goal.iterations.push({
        number: iterationNumber,
        startedAt,
        issue: issue.number,
        outcome: 'planned',
        summary: `Created issue #${issue.number}: ${issue.title}`
      });
      goal = touchGoal(goal);
      await saveGoalState(resolved.slug, goal);

      let runSummary: RunSummary;
      let mechanicalEvaluation: GoalMechanicalEvaluation | undefined;
      let evaluation: GoalEvaluation;
      try {
        runSummary = await runSingleGoalIssue({
          cwd: options.cwd,
          project: options.project,
          issue: issue.number,
          agent: options.agent,
          json: options.json,
          assumeYes: Boolean(options.assumeYes),
          confirmDirectCommit: options.confirmDirectCommit,
          runCommand: options.runCommand
        });
        const unsuccessfulRun = evaluationForUnsuccessfulRun(runSummary, issue.number);
        if (unsuccessfulRun) {
          evaluation = unsuccessfulRun;
        } else {
          mechanicalEvaluation = await runMechanicalEvaluation({
            config,
            workspacePath: resolved.project.workspacePath,
            runSummary,
            issueNumber: issue.number,
            runCommand: options.runCommand
          });
          evaluation = enforceMechanicalEvaluation(
            await evaluateIteration({
              goal,
              runSummary,
              mechanicalEvaluation,
              agent,
              cwd: resolved.project.localPath,
              stateDir
            }),
            mechanicalEvaluation,
            goal
          );
        }
      } catch (error) {
        goal = await failCurrentIteration({
          projectSlug: resolved.slug,
          goal,
          reason: String(error)
        });
        break;
      }

      goal.iterations[goal.iterations.length - 1] = {
        ...goal.iterations[goal.iterations.length - 1],
        finishedAt: new Date().toISOString(),
        runSummary,
        mechanicalEvaluation,
        outcome: outcomeForEvaluation(evaluation),
        summary: evaluation.reason,
        evaluation
      };
      goal = touchGoal(goal);
      await saveGoalState(resolved.slug, goal);

      if (evaluation.status === 'succeeded') {
        goal = await finishGoal(resolved.slug, goal, 'succeeded', evaluation.reason);
        break;
      }
      if (evaluation.status === 'blocked' || evaluation.status === 'failed') {
        goal = await finishGoal(resolved.slug, goal, evaluation.status, evaluation.reason);
        break;
      }
    }

    if (goal.status === 'active' && goal.iterations.length >= goal.maxIterations) {
      goal = await finishGoal(resolved.slug, goal, 'blocked', `maxIterations(${goal.maxIterations}) reached`);
    }

    return goal;
  } finally {
    await lock.release();
  }
}

async function planNextIteration(options: {
  goal: GoalState;
  agent: GoalAgentAdapter;
  cwd: string;
  stateDir: string;
}): Promise<GoalPlan> {
  const latest = options.goal.iterations.at(-1)?.evaluation;
  if (latest?.status === 'continue' && latest.nextIssue) {
    return { status: 'issue', reason: latest.reason, nextIssue: latest.nextIssue };
  }
  return options.agent.plan({
    cwd: options.cwd,
    stateDir: options.stateDir,
    prompt: buildGoalPlannerPrompt(options.goal)
  });
}

async function evaluateIteration(options: {
  goal: GoalState;
  runSummary: RunSummary;
  mechanicalEvaluation?: GoalMechanicalEvaluation;
  agent: GoalAgentAdapter;
  cwd: string;
  stateDir: string;
}): Promise<GoalEvaluation> {
  return options.agent.evaluate({
    cwd: options.cwd,
    stateDir: options.stateDir,
    prompt: buildGoalEvaluatorPrompt({
      goal: options.goal,
      runSummary: options.runSummary,
      mechanicalEvaluation: options.mechanicalEvaluation
    })
  });
}

async function runMechanicalEvaluation(options: {
  config: KaizenConfig;
  workspacePath: string;
  runSummary: RunSummary;
  issueNumber: number;
  runCommand: CommandRunner;
}): Promise<GoalMechanicalEvaluation | undefined> {
  const command = options.config.goal.evaluation.command;
  if (!command) return undefined;
  const issue = options.runSummary.issues.find((item) => item.number === options.issueNumber);
  if (!issue?.branch) {
    return {
      command,
      ok: false,
      output: `Goal evaluation command could not run because issue #${options.issueNumber} has no produced branch.`
    };
  }
  const git = new GitClient(options.runCommand, options.workspacePath);
  await git.fetch();
  await git.checkout(issue.branch, { ignoreOtherWorktrees: true });
  try {
    const result = await options.runCommand(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', command] : ['-lc', command], {
      cwd: options.workspacePath,
      timeoutMs: options.config.goal.evaluation.timeoutMinutes * 60_000,
      rejectOnNonZero: false
    });
    return {
      command,
      ok: result.exitCode === 0,
      output: `${result.stdout}${result.stderr}`
    };
  } finally {
    await git.checkout(options.config.git.defaultBranch, { ignoreOtherWorktrees: true });
    await git.resetHard(`origin/${options.config.git.defaultBranch}`);
  }
}

function evaluationForUnsuccessfulRun(runSummary: RunSummary, issueNumber: number): GoalEvaluation | undefined {
  const issue = runSummary.issues.find((item) => item.number === issueNumber);
  if (!issue) {
    return {
      status: 'failed',
      confidence: 1,
      reason: `Goal issue #${issueNumber} did not appear in the run summary.`,
      satisfiedCriteria: [],
      missingCriteria: ['Issue was not processed']
    };
  }
  if (issue.outcome === 'blocked') {
    return {
      status: 'blocked',
      confidence: 1,
      reason: issue.reason ?? `Goal issue #${issueNumber} was blocked.`,
      satisfiedCriteria: [],
      missingCriteria: ['Issue blocked before Goal completion']
    };
  }
  if (issue.outcome === 'failed' || runSummary.result === 'failed') {
    return {
      status: 'failed',
      confidence: 1,
      reason: issue.reason ?? `Goal issue #${issueNumber} failed.`,
      satisfiedCriteria: [],
      missingCriteria: ['Issue pipeline failed']
    };
  }
  return undefined;
}

function enforceMechanicalEvaluation(
  evaluation: GoalEvaluation,
  mechanicalEvaluation: GoalMechanicalEvaluation | undefined,
  goal: GoalState
): GoalEvaluation {
  if (!mechanicalEvaluation || mechanicalEvaluation.ok || evaluation.status !== 'succeeded') return evaluation;
  return {
    status: 'continue',
    confidence: 0,
    reason: `Goal evaluation command failed: ${mechanicalEvaluation.command}`,
    satisfiedCriteria: evaluation.satisfiedCriteria,
    missingCriteria: evaluation.missingCriteria.length ? evaluation.missingCriteria : goal.successCriteria,
    nextIssue: evaluation.nextIssue
  };
}

async function createGoalIssue(options: {
  project?: string;
  cwd: string;
  repoDir: string;
  goal: GoalState;
  issue: GoalNextIssue;
  iterationNumber: number;
  issueLabel: string;
  runCommand: CommandRunner;
}) {
  const github = new GitHubClient(options.runCommand, options.repoDir);
  await github.createLabels([options.issueLabel]);
  return reportIssue({
    cwd: options.cwd,
    project: options.project,
    title: options.issue.title,
    body: goalIssueBody(options.goal, options.issue, options.iterationNumber),
    priority: options.issue.priority,
    queue: true,
    extraLabels: [options.issueLabel],
    runCommand: options.runCommand
  });
}

function goalIssueBody(goal: GoalState, issue: GoalNextIssue, iterationNumber: number): string {
  return [
    `<!-- kaizen-loop:goal ${JSON.stringify({ goalId: goal.id, iteration: iterationNumber })} -->`,
    '',
    '## Goal',
    goal.title,
    '',
    goal.description || '(no description)',
    '',
    '## Success Criteria',
    ...goal.successCriteria.map((criterion) => `- ${criterion}`),
    '',
    '## This Iteration',
    issue.body || '(no body)',
    '',
    '## Constraints',
    ...(goal.constraints.length ? goal.constraints : ['Follow the repository Kaizen safety policy.']).map((constraint) => `- ${constraint}`)
  ].join('\n');
}

async function runSingleGoalIssue(options: {
  cwd: string;
  project?: string;
  issue: number;
  agent?: 'claude' | 'codex';
  json: boolean;
  assumeYes: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
  runCommand: CommandRunner;
}): Promise<RunSummary> {
  const result = await runKaizen({
    cwd: options.cwd,
    project: options.project,
    scheduled: false,
    trigger: 'instant',
    issue: options.issue,
    dryRun: false,
    maxIssues: 1,
    agent: options.agent,
    json: options.json,
    assumeYes: options.assumeYes,
    confirmDirectCommit: options.confirmDirectCommit,
    runCommand: options.runCommand
  });
  if (!('issues' in result)) throw new Error('Goal run expected a run summary, but got issue selection.');
  return result;
}

async function finishGoal(projectSlug: string, goal: GoalState, status: Exclude<GoalState['status'], 'active' | 'stopped'>, reason: string): Promise<GoalState> {
  const next = touchGoal({
    ...goal,
    status,
    finalReason: reason
  });
  await saveGoalState(projectSlug, next);
  return next;
}

async function failCurrentIteration(options: {
  projectSlug: string;
  goal: GoalState;
  reason: string;
}): Promise<GoalState> {
  const iterations = [...options.goal.iterations];
  const index = iterations.length - 1;
  if (index >= 0) {
    iterations[index] = {
      ...iterations[index],
      finishedAt: new Date().toISOString(),
      outcome: 'failed',
      summary: options.reason
    };
  }
  const failed = touchGoal({
    ...options.goal,
    status: 'failed',
    finalReason: options.reason,
    iterations
  });
  await saveGoalState(options.projectSlug, failed);
  return failed;
}

function outcomeForEvaluation(evaluation: GoalEvaluation) {
  if (evaluation.status === 'continue') return 'processed';
  return evaluation.status;
}
