import { z } from 'zod';
import type { CommandRunner } from '../utils/command.js';
import { extractLastJsonObject } from '../utils/json.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';

const agentPayloadSchema = z
  .object({
    status: z.enum(['fixed', 'partial', 'blocked']),
    summary: z.string().default(''),
    notes: z.string().default(''),
    blockedReason: z.string().optional()
  })
  .passthrough();

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude' as const;

  constructor(private readonly runCommand: CommandRunner) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.runCommand('claude', ['-p', 'ok', '--max-turns', '1'], { rejectOnNonZero: true, timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const args = [
      '-p',
      req.prompt,
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(git add:*) Bash(git commit:*) Bash(npm:*) Read Write Edit Glob Grep'
    ];
    if (req.model) args.push('--model', req.model);

    try {
      const result = await this.runCommand('claude', args, {
        cwd: req.workspaceDir,
        timeoutMs: req.timeoutMs,
        rejectOnNonZero: false
      });
      const raw = `${result.stdout}${result.stderr}`;
      if (result.exitCode !== 0) {
        return {
          status: 'error',
          summary: `Claude exited with code ${result.exitCode}`,
          notes: '',
          raw,
          durationMs: result.durationMs
        };
      }
      return parseAgentResult(raw, result.durationMs);
    } catch (error) {
      return {
        status: 'error',
        summary: String(error),
        notes: '',
        raw: String(error),
        durationMs: req.timeoutMs
      };
    }
  }
}

export function parseAgentResult(raw: string, durationMs = 0): AgentResult {
  const parsedTopLevel = parseMaybeJson(raw);
  const finalText =
    typeof parsedTopLevel === 'object' && parsedTopLevel && 'result' in parsedTopLevel
      ? String((parsedTopLevel as { result: unknown }).result)
      : raw;
  const payload = agentPayloadSchema.parse(extractLastJsonObject(finalText));
  return {
    status: payload.status,
    summary: payload.summary,
    notes: payload.notes,
    blockedReason: payload.blockedReason,
    raw,
    durationMs
  };
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
