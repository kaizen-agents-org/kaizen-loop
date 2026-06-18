import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import type { DirectCommitConfirmation } from '../orchestrator/run.js';
import type { CommandRunner } from '../utils/command.js';
import { KaizenError } from '../utils/errors.js';
import { createGoalState, listGoalStates, loadGoalState, saveGoalState, touchGoal } from '../goals/state.js';
import { runGoal } from '../goals/runner.js';

export interface CreateGoalOptions {
  cwd: string;
  project?: string;
  title: string;
  description: string;
  successCriteria: string[];
  constraints: string[];
  maxIterations?: number;
}

export interface GoalRunOptions {
  cwd: string;
  project?: string;
  goalId: string;
  agent?: 'claude' | 'codex';
  assumeYes?: boolean;
  json: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
  runCommand: CommandRunner;
}

export async function createGoal(options: CreateGoalOptions) {
  if (options.successCriteria.length === 0) {
    throw new KaizenError('At least one --success criterion is required.', 2);
  }
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  return createGoalState({
    projectSlug: resolved.slug,
    title: options.title,
    description: options.description,
    successCriteria: options.successCriteria,
    constraints: options.constraints,
    maxIterations: options.maxIterations ?? config.goal.maxIterations
  });
}

export async function runGoalCommand(options: GoalRunOptions) {
  return runGoal(options);
}

export async function goalStatus(options: { cwd: string; project?: string; goalId: string }) {
  const resolved = await resolveProject(options.project, options.cwd);
  return loadGoalState(resolved.slug, options.goalId);
}

export async function listGoals(options: { cwd: string; project?: string }) {
  const resolved = await resolveProject(options.project, options.cwd);
  return listGoalStates(resolved.slug);
}

export async function stopGoal(options: { cwd: string; project?: string; goalId: string; reason: string }) {
  const resolved = await resolveProject(options.project, options.cwd);
  const goal = await loadGoalState(resolved.slug, options.goalId);
  if (goal.status !== 'active') {
    throw new KaizenError(`Goal ${goal.id} is ${goal.status}; only active goals can be stopped.`, 2);
  }
  const stopped = touchGoal({
    ...goal,
    status: 'stopped',
    stoppedReason: options.reason
  });
  await saveGoalState(resolved.slug, stopped);
  return stopped;
}
