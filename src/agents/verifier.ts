import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildAllowlistedEnv, type CommandRunner } from '../utils/command.js';
import { extractLastJsonObject } from '../utils/json.js';
import { envWithKaizenTemp } from '../utils/temp.js';

/**
 * Conservative PR-creation gate statuses. The verifier decides whether opening a
 * PR is acceptable, it does not imply merge approval.
 * - `open_pr`: change is acceptable, open a ready-for-review PR.
 * - `open_pr_with_warning`: open a PR but surface a caveat for the human reviewer.
 * - `block_pr`: do not open a PR yet; return the reason to the builder to revise.
 * - `needs_context`: verifier lacks information to decide; return to the builder.
 */
export type VerifierGateStatus = 'open_pr' | 'open_pr_with_warning' | 'block_pr' | 'needs_context';

/** Legacy statuses kept for temporary backward compatibility with older verifier payloads. */
const legacyStatusMap: Record<string, VerifierGateStatus> = {
  approved: 'open_pr',
  pr_only: 'open_pr_with_warning',
  rejected: 'block_pr'
};

const verifierPayloadSchema = z
  .object({
    status: z
      .enum(['open_pr', 'open_pr_with_warning', 'block_pr', 'needs_context', 'approved', 'pr_only', 'rejected'])
      .transform((status) => legacyStatusMap[status] ?? (status as VerifierGateStatus)),
    summary: z.string().default(''),
    notes: z.string().default(''),
    reason: z.string().optional()
  })
  .passthrough();

export interface VerifierAgentOptions {
  command: string;
  resultPath: string;
  timeoutMinutes: number;
  envAllowlist: string[];
}

export interface VerifierRequest {
  workspaceDir: string;
  prompt: string;
  timeoutMs?: number;
}

export interface VerifierResult {
  status: VerifierGateStatus | 'error' | 'timeout';
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
      await this.runCommand(this.options.command, ['--version'], {
        rejectOnNonZero: true,
        timeoutMs: 30_000,
        env: buildAllowlistedEnv(process.env, this.options.envAllowlist)
      });
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
      const env = await envWithKaizenTemp(
        buildAllowlistedEnv(process.env, this.options.envAllowlist, {
          KAIZEN_VERIFIER_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: req.workspaceDir
        }),
        req.workspaceDir
      );
      const result = await this.runCommand(this.options.command, [], {
        cwd: req.workspaceDir,
        input: req.prompt,
        timeoutMs: req.timeoutMs ?? this.options.timeoutMinutes * 60_000,
        rejectOnNonZero: false,
        env
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
        durationMs: req.timeoutMs ?? this.options.timeoutMinutes * 60_000
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
