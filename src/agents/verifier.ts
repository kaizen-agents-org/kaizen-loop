import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommandRunner } from '../utils/command.js';
import { extractLastJsonObject } from '../utils/json.js';

const verifierPayloadSchema = z
  .object({
    status: z.enum(['approved', 'pr_only', 'rejected']),
    summary: z.string().default(''),
    notes: z.string().default(''),
    reason: z.string().optional()
  })
  .passthrough();

export interface VerifierAgentOptions {
  command: string;
  resultPath: string;
  timeoutMinutes: number;
}

export interface VerifierRequest {
  workspaceDir: string;
  prompt: string;
}

export interface VerifierResult {
  status: 'approved' | 'pr_only' | 'rejected' | 'error' | 'timeout';
  summary: string;
  notes: string;
  reason?: string;
  raw: string;
  durationMs: number;
}

export class VerifierAgentAdapter {
  readonly name = 'verifier' as const;

  constructor(
    private readonly runCommand: CommandRunner,
    private readonly options: VerifierAgentOptions
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.runCommand(this.options.command, ['--version'], { rejectOnNonZero: true, timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async run(req: VerifierRequest): Promise<VerifierResult> {
    const resultPath = path.resolve(req.workspaceDir, this.options.resultPath);
    await fs.rm(resultPath, { force: true });
    await fs.mkdir(path.dirname(resultPath), { recursive: true });

    try {
      const result = await this.runCommand(this.options.command, [], {
        cwd: req.workspaceDir,
        input: req.prompt,
        timeoutMs: this.options.timeoutMinutes * 60_000,
        rejectOnNonZero: false,
        env: {
          ...process.env,
          KAIZEN_VERIFIER_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: req.workspaceDir
        }
      });
      const raw = `${result.stdout}${result.stderr}`;
      const payload = (await readVerifierPayload(resultPath)) ?? parseVerifierPayload(raw);
      await fs.rm(resultPath, { force: true });
      if (result.exitCode !== 0 && !payload) {
        return {
          status: 'error',
          summary: `Verifier agent exited with code ${result.exitCode}`,
          notes: '',
          raw,
          durationMs: result.durationMs
        };
      }
      if (!payload) {
        return {
          status: 'error',
          summary: `Verifier agent did not write ${this.options.resultPath}`,
          notes: '',
          raw,
          durationMs: result.durationMs
        };
      }
      return {
        status: payload.status,
        summary: payload.summary,
        notes: payload.notes,
        reason: payload.reason,
        raw: `${raw}\n${JSON.stringify(payload)}`,
        durationMs: result.durationMs
      };
    } catch (error) {
      return {
        status: 'error',
        summary: String(error),
        notes: '',
        raw: String(error),
        durationMs: this.options.timeoutMinutes * 60_000
      };
    }
  }
}

async function readVerifierPayload(resultPath: string): Promise<z.infer<typeof verifierPayloadSchema> | undefined> {
  try {
    const raw = await fs.readFile(resultPath, 'utf8');
    return verifierPayloadSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseVerifierPayload(raw: string): z.infer<typeof verifierPayloadSchema> | undefined {
  try {
    return verifierPayloadSchema.parse(extractLastJsonObject(raw));
  } catch {
    return undefined;
  }
}
