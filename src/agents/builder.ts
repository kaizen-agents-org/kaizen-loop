import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildUntrustedEnv, type CommandRunner } from '../utils/command.js';
import { envWithKaizenTemp } from '../utils/temp.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';

const PARTIAL_NOTE_LABELS = ['Completed scope', 'Incomplete scope', 'Verification', 'Residual risk'];
const FIXED_NOTE_LABELS = ['Verification', 'Residual risk'];
const NOTE_SECTION_PREFIX = '(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?';
const noteSectionPattern = (labelPattern: string) => `(?:${labelPattern}\\s*:|\\*\\*${labelPattern}\\s*:\\*\\*)`;
const MEANINGFUL_NOTE_CONTENT = /[^\s.;,:—–\-_*+|#>]/;
const SKIPPED_VERIFICATION = /^(?:skipped|\*\*skipped\*\*|__skipped__|\*skipped\*|_skipped_|`skipped`)(?=$|[\s.;,:—–-])/i;
const SKIPPED_VERIFICATION_WITH_REASON = /^(?:skipped|\*\*skipped\*\*|__skipped__|\*skipped\*|_skipped_|`skipped`)[ \t]*[—–-][ \t]*([\s\S]*)$/i;

const discoveredIssueInputSchema = z
  .object({
    title: z.string(),
    body: z.string().optional(),
    expected: z.string(),
    evidence: z.string(),
    repo: z.string().optional(),
    severity: z.string().optional(),
    labels: z.array(z.string()).optional()
  })
  .strict()
  .superRefine((issue, context) => {
    for (const field of ['title', 'expected', 'evidence'] as const) {
      if (!issue[field].trim()) {
        context.addIssue({ code: 'custom', path: [field], message: `${field} must be a non-empty string` });
      }
    }
    issue.labels?.forEach((label, index) => {
      if (!label.trim()) {
        context.addIssue({ code: 'custom', path: ['labels', index], message: 'label must be a non-empty string' });
      }
    });
  });

const discoveredIssueSchema = discoveredIssueInputSchema.transform((issue) => ({
  title: issue.title.trim(),
  expected: issue.expected.trim(),
  evidence: issue.evidence.trim(),
  ...optionalTrimmedField('body', issue.body),
  ...optionalTrimmedField('repo', issue.repo),
  ...optionalTrimmedField('severity', issue.severity),
  ...(issue.labels ? { labels: [...new Set(issue.labels.map((label) => label.trim()))] } : {})
}));

const builderPayloadInputSchema = z
  .object({
    status: z.enum(['fixed', 'partial', 'blocked']),
    summary: z.string(),
    notes: z.string(),
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
      question: z.string()
    }).strict().optional(),
    discoveredIssues: z.array(discoveredIssueSchema).default([])
  })
  .strict()
  .superRefine((payload, context) => {
    if (!payload.summary.trim()) {
      context.addIssue({ code: 'custom', path: ['summary'], message: 'summary must be a non-empty string' });
    }
    const labels = payload.status === 'fixed'
      ? FIXED_NOTE_LABELS
      : payload.status === 'partial'
        ? PARTIAL_NOTE_LABELS
        : undefined;
    if (labels && !hasStructuredNotes(payload.notes, labels)) {
      context.addIssue({
        code: 'custom',
        path: ['notes'],
        message: payload.status === 'fixed'
          ? 'notes must describe verification status and residual risk when status is fixed'
          : 'notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial'
      });
    }
    const blockedReason = payload.blockedReason?.trim();
    if (payload.status === 'blocked' && !blockedReason) {
      context.addIssue({ code: 'custom', path: ['blockedReason'], message: 'blockedReason must be a non-empty string when status is blocked' });
    } else if (payload.status !== 'blocked' && blockedReason) {
      context.addIssue({ code: 'custom', path: ['blockedReason'], message: 'blockedReason is only valid when status is blocked' });
    }
    if (payload.humanRequest && payload.status !== 'blocked') {
      context.addIssue({
        code: 'custom',
        path: ['humanRequest'],
        message: 'humanRequest is only valid when status is blocked'
      });
    }
    if (payload.humanRequest && !payload.humanRequest.question.trim()) {
      context.addIssue({ code: 'custom', path: ['humanRequest', 'question'], message: 'question must be a non-empty string' });
    }
  });

const builderPayloadSchema = builderPayloadInputSchema.transform((payload) => ({
  status: payload.status,
  summary: payload.summary.trim(),
  notes: payload.notes,
  discoveredIssues: payload.discoveredIssues,
  ...(payload.blockedReason?.trim() ? { blockedReason: payload.blockedReason.trim() } : {}),
  ...(payload.humanRequest ? {
    humanRequest: { ...payload.humanRequest, question: payload.humanRequest.question.trim() }
  } : {})
}));

function optionalTrimmedField<Key extends 'body' | 'repo' | 'severity'>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  const trimmed = value?.trim();
  return trimmed ? { [key]: trimmed } as Record<Key, string> : {};
}

function hasStructuredNotes(notes: string, labels: string[]): boolean {
  const sectionPattern = noteSectionPattern(`(?:${labels.join('|')})`);
  const contentPattern = `(?=(?:(?!${NOTE_SECTION_PREFIX}${sectionPattern})[\\s\\S])*?[^\\s.;,:—–\\-_*+|#>])`;
  if (!labels.every((label) => (
    notes.match(new RegExp(`${NOTE_SECTION_PREFIX}${noteSectionPattern(label)}`, 'g'))?.length === 1 &&
    new RegExp(`${NOTE_SECTION_PREFIX}${noteSectionPattern(label)}${contentPattern}`).test(notes)
  ))) {
    return false;
  }

  const verification = new RegExp(
    `${NOTE_SECTION_PREFIX}${noteSectionPattern('Verification')}\\s*([\\s\\S]*?)(?=${NOTE_SECTION_PREFIX}${sectionPattern}|$)`
  ).exec(notes)?.[1].trim();
  if (!verification || !SKIPPED_VERIFICATION.test(verification)) return true;

  const reason = SKIPPED_VERIFICATION_WITH_REASON.exec(verification)?.[1];
  return Boolean(reason && MEANINGFUL_NOTE_CONTENT.test(reason));
}

export interface BuilderAgentOptions {
  command: string;
  resultPath: string;
  envAllowlist: string[];
}

export class BuilderAgentAdapter implements AgentAdapter {
  readonly name = 'builder' as const;

  constructor(
    private readonly runCommand: CommandRunner,
    private readonly options: BuilderAgentOptions
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.runCommand(this.options.command, ['--version'], {
        rejectOnNonZero: true,
        timeoutMs: 30_000,
        env: buildUntrustedEnv(process.env, this.options.envAllowlist)
      });
      return true;
    } catch {
      return false;
    }
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const resultPath = path.resolve(req.workspaceDir, this.options.resultPath);
    const discoveredIssuesPath = path.resolve(req.workspaceDir, '.kaizen/builder/discovered-issues.json');
    await Promise.all([
      fs.rm(resultPath, { force: true }),
      fs.rm(discoveredIssuesPath, { force: true })
    ]);
    await fs.mkdir(path.dirname(resultPath), { recursive: true });

    try {
      const env = await envWithKaizenTemp(
        buildUntrustedEnv(process.env, this.options.envAllowlist, {
          KAIZEN_BUILD_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: req.workspaceDir,
          ...(req.preferredBackends?.length ? { KAIZEN_PREFERRED_AGENT: req.preferredBackends.join(',') } : {}),
          ...(req.model ? { KAIZEN_AGENT_MODEL: req.model } : {})
        }),
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
      let payload: z.infer<typeof builderPayloadSchema> | undefined;
      try {
        payload = await readBuilderPayload(resultPath);
      } catch (error) {
        return {
          status: 'error',
          summary: String(error),
          notes: '',
          discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
          raw: String(error),
          durationMs: req.timeoutMs
        };
      }
      if (result.exitCode !== 0 && !payload) {
        return {
          status: 'error',
          summary: `Builder agent exited with code ${result.exitCode}`,
          notes: '',
          discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
          raw,
          durationMs: result.durationMs
        };
      }
      if (!payload) {
        return {
          status: 'error',
          summary: `Builder agent did not write ${this.options.resultPath}`,
          notes: '',
          discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
          raw,
          durationMs: result.durationMs
        };
      }
      return {
        status: payload.status,
        summary: payload.summary,
        notes: payload.notes,
        blockedReason: payload.blockedReason,
        humanRequest: payload.humanRequest,
        discoveredIssues: payload.discoveredIssues,
        raw: `${raw}\n${JSON.stringify(payload)}`,
        durationMs: result.durationMs
      };
    } catch (error) {
      return {
        status: 'error',
        summary: String(error),
        notes: '',
        discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
        raw: String(error),
        durationMs: req.timeoutMs
      };
    } finally {
      await Promise.allSettled([
        fs.rm(resultPath, { force: true }),
        fs.rm(discoveredIssuesPath, { force: true })
      ]);
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

async function readDiscoveredIssues(discoveredIssuesPath: string): Promise<Array<z.infer<typeof discoveredIssueSchema>>> {
  try {
    const parsed = JSON.parse(await fs.readFile(discoveredIssuesPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      const result = discoveredIssueSchema.safeParse(candidate);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}
