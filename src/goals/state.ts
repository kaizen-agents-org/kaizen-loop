import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { projectStateDir } from '../utils/paths.js';
import { slugify } from '../utils/slug.js';
import type { GoalState } from './types.js';

const nextIssueSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    priority: z.enum(['P0', 'P1', 'P2'])
  })
  .strict();

const goalEvaluationSchema = z
  .object({
    status: z.enum(['succeeded', 'continue', 'blocked', 'failed']),
    confidence: z.number(),
    reason: z.string(),
    satisfiedCriteria: z.array(z.string()),
    missingCriteria: z.array(z.string()),
    nextIssue: nextIssueSchema.optional()
  })
  .strict();

const goalMechanicalEvaluationSchema = z
  .object({
    command: z.string(),
    ok: z.boolean(),
    output: z.string()
  })
  .strict();

const goalIterationSchema = z
  .object({
    number: z.number().int().positive(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    issue: z.number().int().positive().optional(),
    runSummary: z.unknown().optional(),
    outcome: z.enum(['planned', 'processed', 'succeeded', 'blocked', 'failed']),
    summary: z.string(),
    mechanicalEvaluation: goalMechanicalEvaluationSchema.optional(),
    evaluation: goalEvaluationSchema.optional()
  })
  .strict();

const goalStateSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    project: z.string(),
    title: z.string(),
    description: z.string(),
    successCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    status: z.enum(['active', 'succeeded', 'blocked', 'failed', 'stopped']),
    maxIterations: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
    stoppedReason: z.string().optional(),
    finalReason: z.string().optional(),
    iterations: z.array(goalIterationSchema)
  })
  .strict();

export function goalsDir(projectSlug: string): string {
  return path.join(projectStateDir(projectSlug), 'goals');
}

export function goalDir(projectSlug: string, goalId: string): string {
  return path.join(goalsDir(projectSlug), goalId);
}

export function goalPath(projectSlug: string, goalId: string): string {
  return path.join(goalDir(projectSlug, goalId), 'goal.json');
}

export async function createGoalState(options: {
  projectSlug: string;
  title: string;
  description: string;
  successCriteria: string[];
  constraints: string[];
  maxIterations: number;
  now?: Date;
}): Promise<GoalState> {
  const now = options.now ?? new Date();
  const id = goalId(options.title, now);
  const goal: GoalState = {
    version: 1,
    id,
    project: options.projectSlug,
    title: options.title,
    description: options.description,
    successCriteria: options.successCriteria,
    constraints: options.constraints,
    status: 'active',
    maxIterations: options.maxIterations,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    iterations: []
  };
  await saveGoalState(options.projectSlug, goal);
  return goal;
}

export async function loadGoalState(projectSlug: string, goalId: string): Promise<GoalState> {
  const raw = await fs.readFile(goalPath(projectSlug, goalId), 'utf8');
  return goalStateSchema.parse(JSON.parse(raw)) as GoalState;
}

export async function saveGoalState(projectSlug: string, goal: GoalState): Promise<void> {
  const dir = goalDir(projectSlug, goal.id);
  await fs.mkdir(dir, { recursive: true });
  const destination = goalPath(projectSlug, goal.id);
  const temporary = path.join(dir, `.goal.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(goal, null, 2)}\n`);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function listGoalStates(projectSlug: string): Promise<GoalState[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(goalsDir(projectSlug));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const goals = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await loadGoalState(projectSlug, entry);
      } catch {
        return undefined;
      }
    })
  );
  return goals
    .filter((goal): goal is GoalState => Boolean(goal))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function touchGoal(goal: GoalState, now = new Date()): GoalState {
  return { ...goal, updatedAt: now.toISOString() };
}

function goalId(title: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  return `goal-${timestamp}-${slugify(title).slice(0, 32) || 'untitled'}`;
}
