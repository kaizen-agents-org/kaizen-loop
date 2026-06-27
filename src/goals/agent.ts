import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildAllowlistedEnv, type CommandRunner } from '../utils/command.js';
import { extractLastJsonObject } from '../utils/json.js';
import type { GoalEvaluation, GoalPlan } from './types.js';

const nextIssueSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().default(''),
    priority: z.enum(['P0', 'P1', 'P2']).default('P2')
  })
  .strict();

const planSchema = z
  .object({
    status: z.enum(['issue', 'succeeded', 'blocked']),
    reason: z.string().default(''),
    nextIssue: nextIssueSchema.optional()
  })
  .strict();

const evaluationSchema = z
  .object({
    status: z.enum(['succeeded', 'continue', 'blocked', 'failed']),
    confidence: z.number().min(0).max(1).default(0),
    reason: z.string().default(''),
    satisfiedCriteria: z.array(z.string()).default([]),
    missingCriteria: z.array(z.string()).default([]),
    nextIssue: nextIssueSchema.optional()
  })
  .strict();

export interface GoalAgentOptions {
  command: string;
  args: string[];
  resultPath: string;
  timeoutMinutes: number;
  envAllowlist: string[];
}

export interface GoalAgentRequest {
  cwd: string;
  stateDir: string;
  prompt: string;
}

export class GoalAgentAdapter {
  constructor(
    private readonly runCommand: CommandRunner,
    private readonly options: GoalAgentOptions
  ) {}

  async plan(req: GoalAgentRequest): Promise<GoalPlan> {
    const payload = await this.run(req, planSchema, 'planner');
    if (payload.status === 'issue' && !payload.nextIssue) {
      return { status: 'blocked', reason: 'Goal planner returned status "issue" without nextIssue.' };
    }
    return payload;
  }

  async evaluate(req: GoalAgentRequest): Promise<GoalEvaluation> {
    return this.run(req, evaluationSchema, 'evaluator');
  }

  private async run<T>(req: GoalAgentRequest, schema: z.ZodType<T>, mode: 'planner' | 'evaluator'): Promise<T> {
    const resultPath = path.isAbsolute(this.options.resultPath)
      ? this.options.resultPath
      : path.join(req.stateDir, this.options.resultPath);
    await fs.rm(resultPath, { force: true });
    await fs.mkdir(path.dirname(resultPath), { recursive: true });

    const result = await this.runCommand(this.options.command, this.options.args, {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: this.options.timeoutMinutes * 60_000,
      rejectOnNonZero: false,
      env: buildAllowlistedEnv(process.env, this.options.envAllowlist, {
        KAIZEN_GOAL_RESULT_PATH: resultPath,
        KAIZEN_GOAL_MODE: mode
      })
    });
    const raw = `${result.stdout}${result.stderr}`;
    const payload = (await readPayload(resultPath, schema)) ?? parsePayload(raw, schema);
    await fs.rm(resultPath, { force: true });
    if (result.exitCode !== 0 && !payload) {
      throw new Error(`Goal ${mode} agent exited with code ${result.exitCode}: ${raw}`);
    }
    if (!payload) {
      throw new Error(`Goal ${mode} agent did not return a valid JSON payload.`);
    }
    return payload;
  }
}

async function readPayload<T>(resultPath: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(resultPath, 'utf8');
    return schema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parsePayload<T>(raw: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.parse(extractLastJsonObject(raw));
  } catch {
    return undefined;
  }
}
