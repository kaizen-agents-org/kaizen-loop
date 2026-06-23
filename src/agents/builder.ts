import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommandRunner } from '../utils/command.js';
import { envWithKaizenTemp } from '../utils/temp.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';

const builderPayloadSchema = z
  .object({
    status: z.enum(['fixed', 'partial', 'blocked']),
    summary: z.string().default(''),
    notes: z.string().default(''),
    blockedReason: z.string().optional(),
    discoveredIssues: z
      .array(
        z
          .object({
            title: z.string().min(1),
            body: z.string().optional(),
            expected: z.string().optional(),
            evidence: z.string().optional(),
            repo: z.string().optional(),
            severity: z.string().optional(),
            labels: z.array(z.string()).optional()
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

export interface BuilderAgentOptions {
  command: string;
  resultPath: string;
}

export class BuilderAgentAdapter implements AgentAdapter {
  readonly name = 'builder' as const;

  constructor(
    private readonly runCommand: CommandRunner,
    private readonly options: BuilderAgentOptions
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.runCommand(this.options.command, ['--version'], { rejectOnNonZero: true, timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const resultPath = path.resolve(req.workspaceDir, this.options.resultPath);
    await fs.rm(resultPath, { force: true });
    await fs.mkdir(path.dirname(resultPath), { recursive: true });

    try {
      const env = await envWithKaizenTemp(
        {
          ...process.env,
          KAIZEN_BUILD_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: req.workspaceDir,
          ...(req.preferredBackend ? { KAIZEN_PREFERRED_AGENT: req.preferredBackend } : {}),
          ...(req.model ? { KAIZEN_AGENT_MODEL: req.model } : {})
        },
        req.workspaceDir
      );
      const result = await this.runCommand(this.options.command, [], {
        cwd: req.workspaceDir,
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        rejectOnNonZero: false,
        env
      });
      const raw = `${result.stdout}${result.stderr}`;
      const payload = await readBuilderPayload(resultPath);
      await fs.rm(resultPath, { force: true });
      if (result.exitCode !== 0 && !payload) {
        return {
          status: 'error',
          summary: `Builder agent exited with code ${result.exitCode}`,
          notes: '',
          discoveredIssues: [],
          raw,
          durationMs: result.durationMs
        };
      }
      if (!payload) {
        return {
          status: 'error',
          summary: `Builder agent did not write ${this.options.resultPath}`,
          notes: '',
          discoveredIssues: [],
          raw,
          durationMs: result.durationMs
        };
      }
      return {
        status: payload.status,
        summary: payload.summary,
        notes: payload.notes,
        blockedReason: payload.blockedReason,
        discoveredIssues: payload.discoveredIssues,
        raw: `${raw}\n${JSON.stringify(payload)}`,
        durationMs: result.durationMs
      };
    } catch (error) {
      return {
        status: 'error',
        summary: String(error),
        notes: '',
        discoveredIssues: [],
        raw: String(error),
        durationMs: req.timeoutMs
      };
    }
  }
}

async function readBuilderPayload(resultPath: string): Promise<z.infer<typeof builderPayloadSchema> | undefined> {
  try {
    const raw = await fs.readFile(resultPath, 'utf8');
    return builderPayloadSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
