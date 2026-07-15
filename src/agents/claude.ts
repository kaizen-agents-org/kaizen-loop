import { z } from 'zod';
import type { CommandRunner } from '../utils/command.js';
import { extractLastJsonObject } from '../utils/json.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';

const agentPayloadSchema = z
  .object({
    status: z.enum(['fixed', 'partial', 'blocked']),
    summary: z.string().default(''),
    notes: z.string().default(''),
    blockedReason: z.string().optional(),
    humanRequest: z.object({
      reasonCode: z.enum([
        'missing_information',
        'credentials',
        'billing',
        'destructive_action',
        'production_change',
        'policy_exception',
        'external_repository_action',
        'other_approval'
      ]),
      requestKey: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
      question: z.string().min(1)
    }).optional(),
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
  .passthrough()
  .superRefine((payload, context) => {
    if (payload.humanRequest && payload.status !== 'blocked') {
      context.addIssue({
        code: 'custom',
        path: ['humanRequest'],
        message: 'humanRequest is only valid when status is blocked'
      });
    }
  });

const CLAUDE_ALLOWED_TOOLS = [
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(npm:*)',
  'Bash(pnpm:*)',
  'Bash(node:*)',
  'Bash(node_modules/.bin/*:*)',
  'Bash(./node_modules/.bin/*:*)',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep'
].join(' ');

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
      CLAUDE_ALLOWED_TOOLS
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
          discoveredIssues: [],
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
        discoveredIssues: [],
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
    humanRequest: payload.humanRequest,
    discoveredIssues: payload.discoveredIssues,
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
