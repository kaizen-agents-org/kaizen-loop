import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { KaizenConfig } from '../config/schema.js';
import { buildAllowlistedEnv, githubCliEnv, type CommandRunner } from '../utils/command.js';
import { envWithKaizenTemp } from '../utils/temp.js';
import { loadImplementationState, saveImplementationState } from './implementationState.js';

export interface PrGuardianSkillRequest {
  config: KaizenConfig;
  workspaceDir: string;
  repo: string;
  prUrl: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  runDeadlineAt?: number;
}

export type PrGuardianJobStatus = 'pending' | 'running' | 'success' | 'blocked' | 'skipped';

export interface PrGuardianJob {
  version: 1;
  id: string;
  repo: string;
  prUrl: string;
  prNumber: number;
  issueNumber?: number;
  branch: string;
  baseBranch: string;
  headSha: string;
  retryBudget: number;
  attemptCount: number;
  status: PrGuardianJobStatus;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastBlocker?: string;
}

export interface PrGuardianSkillResult {
  status: 'success' | 'failed' | 'skipped' | 'queued';
  summary: string;
  raw: string;
  durationMs: number;
  jobId?: string;
}

export function guardianJobsDir(stateDir: string): string {
  return path.join(stateDir, 'guardian', 'jobs');
}

export async function enqueuePrGuardianJob(options: {
  stateDir: string;
  config: KaizenConfig;
  repo: string;
  prUrl: string;
  prNumber: number;
  issueNumber?: number;
  branch: string;
  baseBranch: string;
  headSha: string;
}): Promise<PrGuardianJob> {
  const now = new Date().toISOString();
  const job: PrGuardianJob = {
    version: 1,
    id: guardianJobId(options.repo, options.prNumber, options.headSha),
    repo: options.repo,
    prUrl: options.prUrl,
    prNumber: options.prNumber,
    issueNumber: options.issueNumber,
    branch: options.branch,
    baseBranch: options.baseBranch,
    headSha: options.headSha,
    retryBudget: options.config.guardian.maxAttempts,
    attemptCount: 0,
    status: options.config.guardian.enabled ? 'pending' : 'skipped',
    createdAt: now,
    updatedAt: now,
    lastBlocker: options.config.guardian.enabled ? undefined : 'PR guardian is disabled.'
  };
  const existing = await readGuardianJob(options.stateDir, job.id);
  if (existing) {
    if (options.issueNumber && !existing.issueNumber) {
      const linked = { ...existing, issueNumber: options.issueNumber, updatedAt: now };
      await writeGuardianJob(options.stateDir, linked);
      return linked;
    }
    return existing;
  }
  await writeGuardianJob(options.stateDir, job);
  return job;
}

export async function listPrGuardianJobs(stateDir: string): Promise<PrGuardianJob[]> {
  try {
    const dir = guardianJobsDir(stateDir);
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json')).sort();
    return (await Promise.all(files.map((file) => readGuardianJobFile(path.join(dir, file))))).filter((job): job is PrGuardianJob => Boolean(job));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function findPrGuardianJob(stateDir: string, pr: number): Promise<PrGuardianJob | undefined> {
  return (await listPrGuardianJobs(stateDir))
    .filter((job) => job.prNumber === pr)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .at(0);
}

export async function runPrGuardianJob(options: {
  stateDir: string;
  config: KaizenConfig;
  workspaceDir: string;
  runCommand: CommandRunner;
  job: PrGuardianJob;
}): Promise<PrGuardianJob> {
  const running = {
    ...options.job,
    status: 'running' as const,
    attemptCount: options.job.attemptCount + 1,
    updatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString()
  };
  await writeGuardianJob(options.stateDir, running);

  const result = await runPrGuardianSkill(options.runCommand, {
    config: options.config,
    workspaceDir: options.workspaceDir,
    repo: running.repo,
    prUrl: running.prUrl,
    prNumber: running.prNumber,
    branch: running.branch,
    baseBranch: running.baseBranch
  });
  const finished: PrGuardianJob = {
    ...running,
    status: result.status === 'success' ? 'success' : result.status === 'skipped' ? 'skipped' : 'blocked',
    updatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    lastBlocker: result.status === 'success' ? undefined : result.summary
  };
  await writeGuardianJob(options.stateDir, finished);
  await syncImplementationState(options.stateDir, finished);
  return finished;
}

async function syncImplementationState(stateDir: string, job: PrGuardianJob): Promise<void> {
  if (!job.issueNumber) return;
  const current = await loadImplementationState(stateDir, job.issueNumber);
  await saveImplementationState(stateDir, {
    issue: job.issueNumber,
    branch: job.branch,
    phase: job.status === 'success' ? 'complete' : 'guardian',
    attempt: current?.attempt ?? job.attemptCount,
    pr: job.prNumber,
    prUrl: job.prUrl,
    lastFailure: job.status === 'blocked' ? job.lastBlocker : undefined
  });
}

export async function runPendingPrGuardianJobs(options: {
  stateDir: string;
  config: KaizenConfig;
  workspaceDir: string;
  runCommand: CommandRunner;
}): Promise<PrGuardianJob[]> {
  const jobs = await listPrGuardianJobs(options.stateDir);
  for (const job of jobs) {
    if (isStaleRunningJob(job, options.config.guardian.timeoutMinutes) && job.attemptCount >= job.retryBudget) {
      const now = new Date().toISOString();
      const blocked: PrGuardianJob = {
        ...job,
        status: 'blocked',
        updatedAt: now,
        lastCheckedAt: now,
        lastBlocker: `PR guardian retry budget exhausted after ${job.attemptCount} attempts.`
      };
      await writeGuardianJob(options.stateDir, blocked);
      await syncImplementationState(options.stateDir, blocked);
    }
  }
  const runnable = jobs.filter(
    (job) =>
      job.status === 'pending' ||
      (isStaleRunningJob(job, options.config.guardian.timeoutMinutes) && job.attemptCount < job.retryBudget) ||
      (job.status === 'blocked' && job.attemptCount < job.retryBudget)
  );
  const results: PrGuardianJob[] = [];
  for (const job of runnable) {
    results.push(await runPrGuardianJob({ ...options, job }));
  }
  return results;
}

export async function runPrGuardianSkill(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<PrGuardianSkillResult> {
  if (!req.config.guardian.enabled) {
    return { status: 'skipped', summary: 'PR guardian skill is disabled.', raw: '', durationMs: 0 };
  }

  const startMs = Date.now();
  const maxAttempts = req.config.guardian.maxAttempts;
  const rawOutputs: string[] = [];
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        const preflight = await inspectPrGate(runCommand, req);
        if (preflight.isReady) {
          return {
            status: 'success',
            summary: successSummary(preflight),
            raw: rawOutputs.join('\n'),
            durationMs: Date.now() - startMs
          };
        }
        rawOutputs.push(`PR still not merge-ready before guardian pass ${attempt}:\n${summarizeGate(preflight)}`);
      }

      const result = await runCommand(
        req.config.guardian.command,
        [
          'exec',
          '--cd',
          req.workspaceDir,
          '--dangerously-bypass-approvals-and-sandbox',
          buildPrompt(req, attempt)
        ],
        {
          cwd: req.workspaceDir,
          env: await envWithKaizenTemp(buildAllowlistedEnv(process.env, req.config.safety.envAllowlist), req.workspaceDir),
          timeoutMs: boundedTimeoutMs(req.config.guardian.timeoutMinutes * 60_000, req.runDeadlineAt),
          rejectOnNonZero: false
        }
      );
      rawOutputs.push(`${result.stdout}${result.stderr}`);
      if (result.exitCode !== 0) {
        return {
          status: 'failed',
          summary: `PR guardian skill exited with code ${result.exitCode}.`,
          raw: rawOutputs.join('\n'),
          durationMs: Date.now() - startMs
        };
      }

      const gate = await inspectPrGate(runCommand, req);
      if (gate.isReady) {
        const lateGate = await waitForLatePrGate(runCommand, req);
        if (!lateGate.isReady) {
          rawOutputs.push(`PR became not merge-ready after bot review settle wait on pass ${attempt}:\n${summarizeGate(lateGate)}`);
          continue;
        }
        return {
          status: 'success',
          summary: successSummary(lateGate),
          raw: rawOutputs.join('\n'),
          durationMs: Date.now() - startMs
        };
      }
      rawOutputs.push(`PR still not merge-ready after guardian pass ${attempt}:\n${summarizeGate(gate)}`);
    }

    const finalGate = await inspectPrGate(runCommand, req);
    return {
      status: 'failed',
      summary: `PR guardian stopped before PR became merge-ready after ${maxAttempts} attempt(s): ${finalGate.blockers.join('; ') || 'unknown blocker'}.`,
      raw: rawOutputs.join('\n'),
      durationMs: Date.now() - startMs
    };
  } catch (error) {
    return {
      status: 'failed',
      summary: String(error),
      raw: String(error),
      durationMs: Date.now() - startMs
    };
  }
}

async function readGuardianJob(stateDir: string, id: string): Promise<PrGuardianJob | undefined> {
  return readGuardianJobFile(path.join(guardianJobsDir(stateDir), `${id}.json`));
}

async function readGuardianJobFile(file: string): Promise<PrGuardianJob | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PrGuardianJob;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    console.warn(`Skipping unreadable PR Guardian job file ${file}: ${String(error)}`);
    return undefined;
  }
}

async function writeGuardianJob(stateDir: string, job: PrGuardianJob): Promise<void> {
  const dir = guardianJobsDir(stateDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`);
}

function guardianJobId(repo: string, prNumber: number, headSha: string): string {
  const safeRepo = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return `${safeRepo}-pr-${prNumber}-${headSha.slice(0, 12)}`;
}

function isStaleRunningJob(job: PrGuardianJob, timeoutMinutes: number): boolean {
  if (job.status !== 'running') return false;
  const lastCheckedAtMs = Date.parse(job.lastCheckedAt ?? job.updatedAt);
  if (Number.isNaN(lastCheckedAtMs)) return true;
  return Date.now() - lastCheckedAtMs > timeoutMinutes * 60_000;
}

export async function isPrGuardianSkillRunnerAvailable(config: KaizenConfig, runCommand: CommandRunner): Promise<boolean> {
  try {
    await runCommand(config.guardian.command, ['--version'], {
      rejectOnNonZero: true,
      timeoutMs: 30_000,
      env: buildAllowlistedEnv(process.env, config.safety.envAllowlist)
    });
    return true;
  } catch {
    return false;
  }
}

interface ReviewThreadSummary {
  path: string;
  line?: number | null;
  author?: string;
  body?: string;
}

interface PrCheckSummary {
  name: string;
  status: string;
  conclusion?: string;
}

interface PrGateSummary {
  isReady: boolean;
  blockers: string[];
  state?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  checks: PrCheckSummary[];
}

interface ReviewThreadsResponse {
  errors?: Array<{ message?: string }>;
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
          };
          nodes?: Array<{
            isResolved?: boolean;
            isOutdated?: boolean;
            path?: string;
            line?: number | null;
            comments?: {
              nodes?: Array<{
                body?: string;
                author?: {
                  login?: string;
                } | null;
              }>;
            };
          }>;
        };
      };
    };
  };
}

interface PullRequestViewResponse {
  state?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  statusCheckRollup?: Array<Record<string, unknown>>;
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes {
              body
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}`;

async function listUnresolvedReviewThreads(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<ReviewThreadSummary[]> {
  const [owner, name] = req.repo.split('/');
  if (!owner || !name) throw new Error(`Cannot inspect PR review threads for invalid repo: ${req.repo}`);

  const unresolved: ReviewThreadSummary[] = [];
  let cursor: string | undefined;
  let hasNextPage = true;
  while (hasNextPage) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${req.prNumber}`
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const result = await runCommand('gh', args, {
      cwd: req.workspaceDir,
      env: githubCliEnv(),
      timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
      rejectOnNonZero: false
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not inspect PR review threads: ${result.stderr || result.stdout}`);
    }
    const response = JSON.parse(result.stdout || '{}') as ReviewThreadsResponse;
    if (response.errors?.length) {
      throw new Error(`Could not inspect PR review threads: ${response.errors.map((error) => error.message).join('; ')}`);
    }
    const reviewThreads = response.data?.repository?.pullRequest?.reviewThreads;
    if (!reviewThreads) throw new Error('Could not inspect PR review threads: response did not include reviewThreads.');
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.isResolved) continue;
      const firstComment = thread.comments?.nodes?.[0];
      unresolved.push({
        path: thread.path ?? '(unknown path)',
        line: thread.line,
        author: firstComment?.author?.login,
        body: firstComment?.body
      });
    }
    hasNextPage = Boolean(reviewThreads?.pageInfo?.hasNextPage);
    cursor = reviewThreads?.pageInfo?.endCursor ?? undefined;
  }
  return unresolved;
}

async function inspectPrGate(runCommand: CommandRunner, req: PrGuardianSkillRequest): Promise<PrGateSummary> {
  const [pullRequest, unresolvedThreads] = await Promise.all([
    inspectPullRequest(runCommand, req),
    listUnresolvedReviewThreads(runCommand, req)
  ]);
  const blockers = [
    ...mergeabilityBlockers(pullRequest),
    ...unresolvedThreads.map((thread) => {
      const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
      const author = thread.author ? ` by ${thread.author}` : '';
      return `unresolved review thread at ${location}${author}`;
    })
  ];

  return {
    ...pullRequest,
    blockers,
    isReady: blockers.length === 0
  };
}

async function inspectPullRequest(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<Omit<PrGateSummary, 'isReady' | 'blockers'>> {
  const result = await runCommand('gh', [
    'pr',
    'view',
    String(req.prNumber),
    '--repo',
    req.repo,
    '--json',
    'state,isDraft,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup'
  ], {
    cwd: req.workspaceDir,
    env: githubCliEnv(),
    timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
    rejectOnNonZero: false
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect PR mergeability: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout || '{}') as PullRequestViewResponse;
  return {
    state: parsed.state,
    isDraft: parsed.isDraft,
    mergeStateStatus: parsed.mergeStateStatus,
    mergeable: parsed.mergeable,
    reviewDecision: parsed.reviewDecision,
    checks: normalizeStatusChecks(parsed.statusCheckRollup)
  };
}

function normalizeStatusChecks(statusCheckRollup: Array<Record<string, unknown>> | undefined): PrCheckSummary[] {
  return (statusCheckRollup ?? []).map((check) => ({
    name: String(check.name ?? check.context ?? '(unknown check)'),
    status: String(check.status ?? check.state ?? ''),
    ...(typeof check.conclusion === 'string' ? { conclusion: check.conclusion } : {})
  }));
}

function mergeabilityBlockers(state: Omit<PrGateSummary, 'isReady' | 'blockers'>): string[] {
  const blockers: string[] = [];
  if (state.state && state.state !== 'OPEN') blockers.push(`PR state is ${state.state}`);
  if (state.isDraft) blockers.push('PR is draft');
  if (state.mergeable && state.mergeable !== 'MERGEABLE') blockers.push(`mergeable is ${state.mergeable}`);
  if (!isCleanMergeState(state.mergeStateStatus)) blockers.push(`mergeStateStatus is ${state.mergeStateStatus ?? 'unknown'}`);
  if (state.reviewDecision === 'CHANGES_REQUESTED') blockers.push('reviewDecision is CHANGES_REQUESTED');
  for (const check of state.checks.filter((item) => !isPassingCheck(item))) {
    blockers.push(`check ${check.name} is ${check.status}${check.conclusion ? `/${check.conclusion}` : ''}`);
  }
  return blockers;
}

function isCleanMergeState(value: string | undefined): boolean {
  return value === 'CLEAN' || value === 'HAS_HOOKS';
}

const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

function isPassingCheck(check: PrCheckSummary): boolean {
  if (check.conclusion !== undefined) return check.status === 'COMPLETED' && PASSING_CHECK_CONCLUSIONS.has(check.conclusion);
  return check.status === 'SUCCESS';
}

async function waitForLatePrGate(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<PrGateSummary> {
  const settleMs = req.config.guardian.reviewSettleSeconds * 1_000;
  if (settleMs <= 0) return inspectPrGate(runCommand, req);
  await sleep(boundedTimeoutMs(settleMs, req.runDeadlineAt));
  return inspectPrGate(runCommand, req);
}

function boundedTimeoutMs(configuredTimeoutMs: number, runDeadlineAt: number | undefined): number {
  if (!runDeadlineAt) return configuredTimeoutMs;
  const remainingMs = runDeadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Kaizen run timeout exceeded.');
  return Math.min(configuredTimeoutMs, remainingMs);
}

function summarizeReviewThreads(threads: ReviewThreadSummary[]): string {
  return threads
    .map((thread) => {
      const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
      const author = thread.author ? ` by ${thread.author}` : '';
      const body = thread.body?.trim().split('\n')[0];
      return `- ${location}${author}${body ? ` - ${body}` : ''}`;
    })
    .join('\n');
}

function summarizeGate(gate: PrGateSummary): string {
  const blockers = gate.blockers.length ? gate.blockers.map((blocker) => `- ${blocker}`).join('\n') : '- none';
  const checks = gate.checks.length
    ? gate.checks.map((check) => `- ${check.name}: ${check.status}${check.conclusion ? `/${check.conclusion}` : ''}`).join('\n')
    : '- none reported';
  return [
    `mergeable=${gate.mergeable ?? 'unknown'}`,
    `mergeStateStatus=${gate.mergeStateStatus ?? 'unknown'}`,
    `reviewDecision=${gate.reviewDecision ?? 'unknown'}`,
    'Blockers:',
    blockers,
    'Checks:',
    checks
  ].join('\n');
}

function successSummary(gate: PrGateSummary): string {
  return `PR guardian completed; PR is merge-ready (${gate.mergeStateStatus ?? 'unknown'}) with passing checks and no unresolved review threads.`;
}

function buildPrompt(req: PrGuardianSkillRequest, attempt: number): string {
  return `Use the vendored PR Guardian skill at skills/pr-guardian/SKILL.md.

Monitor this pull request until it is mergeable or a real blocker remains:
- Repository: ${req.repo}
- PR: ${req.prUrl}
- PR number: ${req.prNumber}
- Branch: ${req.branch}
- Base branch: ${req.baseBranch}
- Retry budget: ${req.config.guardian.maxAttempts}
- Guardian pass: ${attempt}/${req.config.guardian.maxAttempts}

Requirements:
- Read and follow skills/pr-guardian/SKILL.md.
- Check the PR with gh pr view and gh pr checks.
- Watch relevant workflow runs with gh run watch --exit-status when a run exists.
- Always inspect PR review feedback before declaring the PR ready to merge. Do not require reviewDecision=APPROVED or human approval unless GitHub branch protection explicitly requires it.
- Fetch inline review threads and PR comments with resolution state using paginated GraphQL/API reads, iterating until hasNextPage=false, for example via PullRequest.reviewThreads, so unresolved actionable feedback cannot be missed.
- Address every unresolved actionable review thread, PR comment, and check annotation with focused commits or an explicit disposition, then push any fixes. If you can resolve an addressed review thread, resolve it after replying with the disposition.
- Reply in the same review thread or comment for each addressed review item with the action taken and validation run before resolving it. If GitHub does not support a threaded reply for that item, add a PR comment that links to the original comment or review and lists the action taken.
- Stop only when GitHub reports the PR as fully mergeable: mergeable=MERGEABLE, mergeStateStatus=CLEAN or HAS_HOOKS, required checks are passing, and no unresolved review threads or actionable PR comments remain. If branch protection requires conversation resolution, outdated unresolved threads still block merging until they are replied to and resolved. A missing approval or reviewDecision other than APPROVED is not a blocker by itself; inspect comments again after every pushed fix.
- Do not merge the PR.
- Before finishing, comment on the PR with final mergeability, watched runs, fixes pushed, feedback addressed, unresolved/skipped feedback with reasons, and remaining blockers.`;
}
