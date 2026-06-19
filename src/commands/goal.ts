import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import type { KaizenConfig } from '../config/schema.js';
import { reportIssue } from './report.js';
import { runKaizen } from '../orchestrator/run.js';
import type { RunSummary } from '../orchestrator/summary.js';
import type { CommandRunner } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { projectStateDir } from '../utils/paths.js';
import { slugify } from '../utils/slug.js';

export type GoalStatus = 'active' | 'running' | 'succeeded' | 'blocked' | 'stopped' | 'failed';
export type GoalEvaluationStatus = 'continue' | 'succeeded' | 'blocked';

export interface GoalIssueRequest {
  title: string;
  body?: string;
  priority?: 'P0' | 'P1' | 'P2';
  labels?: string[];
}

export interface GoalEvaluation {
  status: GoalEvaluationStatus;
  summary: string;
  reason?: string;
  nextIssue?: GoalIssueRequest;
}

export interface GoalIteration {
  issue: number;
  title: string;
  startedAt: string;
  finishedAt: string;
  run: RunSummary;
  evaluation?: GoalEvaluation;
}

export interface GoalState {
  version: 1;
  id: string;
  project: string;
  objective: string;
  status: GoalStatus;
  maxIterations: number;
  issueNumbers: number[];
  iterations: GoalIteration[];
  createdAt: string;
  updatedAt: string;
  lastEvaluation?: GoalEvaluation;
  stoppedReason?: string;
  failure?: string;
}

export interface GoalCreateOptions {
  cwd: string;
  project?: string;
  objective: string;
  maxIterations?: number;
}

export interface GoalRunOptions {
  cwd: string;
  project?: string;
  goalId: string;
  maxIterations?: number;
  agent?: 'claude' | 'codex';
  json: boolean;
  runCommand: CommandRunner;
}

export interface GoalStopOptions {
  cwd: string;
  project?: string;
  goalId: string;
  reason?: string;
}

export async function createGoal(options: GoalCreateOptions): Promise<GoalState> {
  const resolved = await resolveProject(options.project, options.cwd);
  const now = new Date().toISOString();
  const state: GoalState = {
    version: 1,
    id: goalId(options.objective),
    project: resolved.slug,
    objective: options.objective,
    status: 'active',
    maxIterations: options.maxIterations ?? 5,
    issueNumbers: [],
    iterations: [],
    createdAt: now,
    updatedAt: now
  };
  await writeGoal(state);
  return state;
}

export async function runGoal(options: GoalRunOptions): Promise<GoalState> {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  const statePath = goalStatePath(resolved.slug, options.goalId);
  let state = await readGoal(resolved.slug, options.goalId);
  if (!canRun(state.status)) throw new ConfigError(`Goal ${state.id} is ${state.status}`);

  const lock = await GoalLock.acquire(resolved.slug, state.id);
  try {
    state = await updateGoalState(resolved.slug, options.goalId, (current) => ({
      ...current,
      status: 'running',
      failure: undefined
    }));

    const maxIterations = options.maxIterations ?? Math.max(0, state.maxIterations - state.iterations.length);
    if (maxIterations === 0) {
      return await finishFromEvaluation(resolved.slug, state.id, {
        status: 'blocked',
        summary: 'Goal iteration budget exhausted.',
        reason: `maxIterations(${state.maxIterations}) reached`
      });
    }

    for (let index = 0; index < maxIterations; index += 1) {
      const before = await evaluateGoal({
        phase: 'before',
        config,
        projectDir: resolved.project.localPath,
        state,
        statePath,
        runCommand: options.runCommand
      });

      if (before.status !== 'continue') {
        state = await finishFromEvaluation(resolved.slug, state.id, before);
        break;
      }

      const request = before.nextIssue ?? defaultNextIssue(state);
      const issue = await reportIssue({
        cwd: options.cwd,
        project: resolved.slug,
        title: request.title,
        body: goalIssueBody(state, request),
        priority: request.priority ?? 'P2',
        prOnly: true,
        queue: true,
        agent: options.agent,
        extraLabels: ['kaizen:goal', ...(request.labels ?? [])],
        runCommand: options.runCommand
      });

      const startedAt = new Date().toISOString();
      const run = await runKaizen({
        cwd: options.cwd,
        project: resolved.slug,
        scheduled: false,
        trigger: 'instant',
        issue: issue.number,
        dryRun: false,
        maxIssues: 1,
        agent: options.agent,
        json: options.json,
        assumeYes: true,
        runCommand: options.runCommand
      }) as RunSummary;

      state = await updateGoalState(resolved.slug, state.id, (current) => ({
        ...current,
        issueNumbers: [...current.issueNumbers, issue.number],
        iterations: [
          ...current.iterations,
          {
            issue: issue.number,
            title: issue.title,
            startedAt,
            finishedAt: new Date().toISOString(),
            run
          }
        ]
      }));

      const after = await evaluateGoal({
        phase: 'after',
        config,
        projectDir: resolved.project.localPath,
        state,
        statePath,
        runCommand: options.runCommand
      });
      state = await updateLastEvaluation(resolved.slug, state.id, after);
      state.iterations[state.iterations.length - 1].evaluation = after;
      await writeGoal(state);

      if (after.status !== 'continue') {
        state = await finishFromEvaluation(resolved.slug, state.id, after);
        break;
      }
    }

    if (state.status === 'running') {
      state = await updateGoalState(resolved.slug, state.id, (current) => ({
        ...current,
        status: 'active'
      }));
    }
    return state;
  } catch (error) {
    state = await updateGoalState(resolved.slug, options.goalId, (current) => ({
      ...current,
      status: 'failed',
      failure: String(error)
    }));
    throw error;
  } finally {
    await lock.release();
  }
}

export async function getGoalStatus(options: { cwd: string; project?: string; goalId: string }): Promise<GoalState> {
  const resolved = await resolveProject(options.project, options.cwd);
  return readGoal(resolved.slug, options.goalId);
}

export async function listGoals(options: { cwd: string; project?: string }): Promise<GoalState[]> {
  const resolved = await resolveProject(options.project, options.cwd);
  const dir = goalsDir(resolved.slug);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const states = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readGoal(resolved.slug, entry.slice(0, -'.json'.length)))
  );
  return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function stopGoal(options: GoalStopOptions): Promise<GoalState> {
  const resolved = await resolveProject(options.project, options.cwd);
  const reason = options.reason ?? 'Stopped by user';
  return updateGoalState(resolved.slug, options.goalId, (current) => ({
    ...current,
    status: 'stopped',
    stoppedReason: reason
  }));
}

async function evaluateGoal(options: {
  phase: 'before' | 'after';
  config: KaizenConfig;
  projectDir: string;
  state: GoalState;
  statePath: string;
  runCommand: CommandRunner;
}): Promise<GoalEvaluation> {
  if (!options.config.commands.goalEvaluate) {
    return defaultEvaluation(options.phase, options.state);
  }

  const evaluationDir = path.join(goalsDir(options.state.project), '.evaluations');
  await fs.mkdir(evaluationDir, { recursive: true });
  const resultPath = path.join(evaluationDir, `${options.state.id}-${options.phase}-evaluation.json`);
  await fs.rm(resultPath, { force: true });
  const result = await options.runCommand(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', options.config.commands.goalEvaluate] : ['-lc', options.config.commands.goalEvaluate], {
    cwd: options.projectDir,
    input: `${JSON.stringify({ phase: options.phase, goal: options.state }, null, 2)}\n`,
    timeoutMs: options.config.commands.verifyTimeoutMinutes * 60_000,
    env: {
      ...process.env,
      KAIZEN_GOAL_PHASE: options.phase,
      KAIZEN_GOAL_STATE_PATH: options.statePath,
      KAIZEN_GOAL_RESULT_PATH: resultPath
    }
  });
  const raw = await readOptionalFile(resultPath) ?? result.stdout;
  if (!raw.trim()) throw new ConfigError('Goal evaluator did not return JSON');
  return parseEvaluation(raw);
}

function defaultEvaluation(phase: 'before' | 'after', state: GoalState): GoalEvaluation {
  if (phase === 'before') {
    return {
      status: 'continue',
      summary: 'Create the next scoped issue for this goal.',
      nextIssue: defaultNextIssue(state)
    };
  }
  const run = state.iterations[state.iterations.length - 1]?.run;
  const failed = run?.issues.find((issue) => issue.outcome === 'failed' || issue.outcome === 'blocked');
  if (failed) {
    return {
      status: 'blocked',
      summary: `Goal blocked by issue #${failed.number}`,
      reason: failed.reason ?? failed.outcome
    };
  }
  return {
    status: 'succeeded',
    summary: 'The goal completed after the latest Issue-to-PR iteration.'
  };
}

function parseEvaluation(raw: string): GoalEvaluation {
  const parsed = JSON.parse(raw) as Partial<GoalEvaluation>;
  if (parsed.status !== 'continue' && parsed.status !== 'succeeded' && parsed.status !== 'blocked') {
    throw new ConfigError(`Invalid goal evaluation status: ${String(parsed.status)}`);
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new ConfigError('Goal evaluation summary is required');
  }
  if (parsed.nextIssue) {
    if (typeof parsed.nextIssue.title !== 'string' || parsed.nextIssue.title.trim().length === 0) {
      throw new ConfigError('Goal evaluation nextIssue.title is required');
    }
    if (parsed.nextIssue.priority && !['P0', 'P1', 'P2'].includes(parsed.nextIssue.priority)) {
      throw new ConfigError(`Invalid goal evaluation nextIssue.priority: ${parsed.nextIssue.priority}`);
    }
  }
  return {
    status: parsed.status,
    summary: parsed.summary,
    reason: parsed.reason,
    nextIssue: parsed.nextIssue
  };
}

function defaultNextIssue(state: GoalState): GoalIssueRequest {
  const next = state.iterations.length + 1;
  return {
    title: `Goal ${state.id}: iteration ${next}`,
    body: `Implement the next scoped step toward this Goal:\n\n${state.objective}`,
    priority: 'P2'
  };
}

function goalIssueBody(state: GoalState, request: GoalIssueRequest): string {
  const marker = JSON.stringify({ id: state.id, project: state.project });
  return [
    request.body ?? `Implement the next scoped step toward this Goal:\n\n${state.objective}`,
    '',
    '## Goal contract',
    `- Goal ID: ${state.id}`,
    `- Objective: ${state.objective}`,
    '- Keep the change scoped to this generated issue.',
    '- Return a normal Kaizen result so Goal evaluation can decide the next iteration.',
    '',
    `<!-- kaizen-goal ${marker} -->`
  ].join('\n');
}

async function finishFromEvaluation(project: string, goalIdValue: string, evaluation: GoalEvaluation): Promise<GoalState> {
  return updateGoalState(project, goalIdValue, (current) => ({
    ...current,
    status: evaluation.status === 'succeeded' ? 'succeeded' : 'blocked',
    lastEvaluation: evaluation
  }));
}

async function updateLastEvaluation(project: string, goalIdValue: string, evaluation: GoalEvaluation): Promise<GoalState> {
  return updateGoalState(project, goalIdValue, (current) => ({
    ...current,
    lastEvaluation: evaluation
  }));
}

async function updateGoalState(project: string, goalIdValue: string, update: (state: GoalState) => GoalState): Promise<GoalState> {
  const current = await readGoal(project, goalIdValue);
  const next = update(current);
  next.updatedAt = new Date().toISOString();
  await writeGoal(next);
  return next;
}

async function readGoal(project: string, goalIdValue: string): Promise<GoalState> {
  try {
    return JSON.parse(await fs.readFile(goalStatePath(project, goalIdValue), 'utf8')) as GoalState;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`Unknown goal: ${goalIdValue}`);
    }
    throw error;
  }
}

async function writeGoal(state: GoalState): Promise<void> {
  await fs.mkdir(goalsDir(state.project), { recursive: true });
  await fs.writeFile(goalStatePath(state.project, state.id), `${JSON.stringify(state, null, 2)}\n`);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function canRun(status: GoalStatus): boolean {
  return status === 'active' || status === 'failed';
}

function goalId(objective: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${slugify(objective, 32)}`;
}

function goalsDir(project: string): string {
  return path.join(projectStateDir(project), 'goals');
}

function goalStatePath(project: string, goalIdValue: string): string {
  return path.join(goalsDir(project), `${goalIdValue}.json`);
}

class GoalLock {
  private constructor(private readonly lockPath: string) {}

  static async acquire(project: string, goalIdValue: string): Promise<GoalLock> {
    const lockPath = path.join(goalsDir(project), `${goalIdValue}.lock`);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return new GoalLock(lockPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await staleLock(lockPath)) {
        await fs.rm(lockPath, { force: true });
        return GoalLock.acquire(project, goalIdValue);
      }
      throw new ConfigError(`Goal is already running: ${goalIdValue}`);
    }
  }

  async release(): Promise<void> {
    await fs.rm(this.lockPath, { force: true });
  }
}

async function staleLock(lockPath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number };
    if (!parsed.pid) return true;
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}
