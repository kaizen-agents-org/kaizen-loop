import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { KaizenConfig } from '../config/schema.js';
import type { GitHubPullRequest } from '../github/types.js';
import { buildAllowlistedEnv, githubCliEnv, type CommandRunner } from '../utils/command.js';
import { envWithKaizenTemp } from '../utils/temp.js';
import { GitClient } from '../workspace/git.js';
import { loadImplementationState, saveImplementationState } from './implementationState.js';
import { isSyncPullRequest } from './wipLimit.js';

export const MANAGED_PR_GUARDIAN_MARKER = '<!-- kaizen-pr-guardian:managed -->';

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
  reactivationCount?: number;
  lastObservedFingerprint?: string;
}

export interface PrGuardianSkillResult {
  status: 'success' | 'failed' | 'skipped' | 'queued';
  summary: string;
  raw: string;
  durationMs: number;
  jobId?: string;
  activityFingerprint?: string;
}

interface PullRequestTerminalState {
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName?: string;
  closingIssuesReferences?: Array<{ number: number }>;
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

export async function enqueueManagedPrGuardianJobs(options: {
  stateDir: string;
  config: KaizenConfig;
  repo: string;
  pullRequests: GitHubPullRequest[];
}): Promise<PrGuardianJob[]> {
  const [owner] = options.repo.split('/');
  const managed = options.pullRequests.filter((pullRequest) =>
    !pullRequest.isDraft &&
    isSyncPullRequest(pullRequest) &&
    pullRequest.body?.includes(MANAGED_PR_GUARDIAN_MARKER) &&
    pullRequest.headRepositoryOwner?.login?.toLowerCase() === owner?.toLowerCase() &&
    pullRequest.baseRefName === options.config.git.defaultBranch &&
    Boolean(pullRequest.headRefName && pullRequest.headRefOid)
  );
  return Promise.all(managed.map((pullRequest) => enqueuePrGuardianJob({
    stateDir: options.stateDir,
    config: options.config,
    repo: options.repo,
    prUrl: pullRequest.url,
    prNumber: pullRequest.number,
    branch: pullRequest.headRefName!,
    baseBranch: pullRequest.baseRefName!,
    headSha: pullRequest.headRefOid!
  })));
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
  isolateWorktree?: boolean;
}): Promise<PrGuardianJob> {
  const running = {
    ...options.job,
    status: 'running' as const,
    attemptCount: options.job.attemptCount + 1,
    updatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString()
  };
  await writeGuardianJob(options.stateDir, running);

  const execute = async (workspaceDir: string) => runPrGuardianSkill(options.runCommand, {
    config: options.config,
    workspaceDir,
    repo: running.repo,
    prUrl: running.prUrl,
    prNumber: running.prNumber,
    branch: running.branch,
    baseBranch: running.baseBranch
  });
  let result: PrGuardianSkillResult;
  try {
    result = options.isolateWorktree
      ? await withGuardianWorktree(options, running, execute)
      : await execute(options.workspaceDir);
  } catch (error) {
    result = {
      status: 'failed',
      summary: `PR guardian worktree failed: ${String(error)}`,
      raw: String(error),
      durationMs: 0
    };
  }
  const finished: PrGuardianJob = {
    ...running,
    status: result.status === 'success' ? 'success' : result.status === 'skipped' ? 'skipped' : 'blocked',
    updatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    lastBlocker: result.status === 'success' ? undefined : result.summary,
    lastObservedFingerprint: result.activityFingerprint ?? running.lastObservedFingerprint
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
  isolateWorktree?: boolean;
}): Promise<PrGuardianJob[]> {
  let jobs = await listPrGuardianJobs(options.stateDir);
  const reconciledTerminalJobs: PrGuardianJob[] = [];
  for (const job of jobs.filter((candidate) =>
    (candidate.status === 'blocked' && candidate.attemptCount >= candidate.retryBudget) ||
    (isStaleRunningJob(candidate, options.config.guardian.timeoutMinutes) && candidate.attemptCount >= candidate.retryBudget)
  )) {
    let resolution: PullRequestTerminalState;
    try {
      resolution = await inspectPullRequestTerminalState(options.runCommand, requestForJob(options, job));
    } catch {
      continue;
    }
    if (
      resolution.state !== 'MERGED' ||
      resolution.baseRefName !== options.config.git.defaultBranch ||
      !job.issueNumber ||
      !resolution.closingIssuesReferences?.some((issue) => issue.number === job.issueNumber)
    ) continue;
    const now = new Date().toISOString();
    const terminal: PrGuardianJob = {
      ...job,
      status: 'success',
      updatedAt: now,
      lastCheckedAt: now,
      lastBlocker: undefined,
      lastObservedFingerprint: JSON.stringify(resolution)
    };
    await writeGuardianJob(options.stateDir, terminal);
    await syncImplementationState(options.stateDir, terminal);
    reconciledTerminalJobs.push(terminal);
  }
  if (reconciledTerminalJobs.length > 0) jobs = await listPrGuardianJobs(options.stateDir);
  const reconciledTerminalJobIds = new Set(reconciledTerminalJobs.map((job) => job.id));
  for (const job of jobs.filter((candidate) => candidate.status === 'success' && !reconciledTerminalJobIds.has(candidate.id))) {
    let gate: PrGateSummary;
    try {
      gate = await inspectPrGate(options.runCommand, requestForJob(options, job));
    } catch {
      continue;
    }
    if (gate.state !== 'OPEN') {
      if (job.lastObservedFingerprint !== gate.activityFingerprint) {
        await writeGuardianJob(options.stateDir, { ...job, lastObservedFingerprint: gate.activityFingerprint });
      }
      continue;
    }
    const observedJob = gate.headRefOid && gate.headRefOid !== job.headSha
      ? { ...job, headSha: gate.headRefOid }
      : job;
    const canReactivate = job.attemptCount < job.retryBudget;
    if (gate.isReady && observedJob === job && job.lastObservedFingerprint === undefined) {
      await writeGuardianJob(options.stateDir, {
        ...job,
        lastObservedFingerprint: gate.activityFingerprint
      });
      continue;
    }
    if (gate.isReady && job.lastObservedFingerprint === gate.activityFingerprint) {
      if (observedJob !== job) {
        await writeGuardianJob(options.stateDir, observedJob);
      }
      continue;
    }
    if (gate.isReady) {
      const reactivated: PrGuardianJob = {
        ...observedJob,
        status: canReactivate ? 'pending' : 'blocked',
        reactivationCount: (job.reactivationCount ?? 0) + 1,
        lastObservedFingerprint: gate.activityFingerprint,
        updatedAt: new Date().toISOString(),
        lastBlocker: canReactivate
          ? observedJob !== job
            ? 'PR head changed after guardian success.'
            : 'New PR activity appeared after guardian success.'
          : `PR guardian retry budget exhausted after ${job.attemptCount} attempts while new PR activity remained unaudited.`
      };
      await writeGuardianJob(options.stateDir, reactivated);
      if (!canReactivate) await syncImplementationState(options.stateDir, reactivated);
      continue;
    }
    const reactivated: PrGuardianJob = {
      ...observedJob,
      status: canReactivate ? 'pending' : 'blocked',
      reactivationCount: (job.reactivationCount ?? 0) + 1,
      lastObservedFingerprint: gate.activityFingerprint,
      updatedAt: new Date().toISOString(),
      lastBlocker: canReactivate
        ? `PR regressed after guardian success: ${gate.blockers.join('; ')}`
        : `PR guardian retry budget exhausted after ${job.attemptCount} attempts while the PR remained regressed: ${gate.blockers.join('; ')}`
    };
    await writeGuardianJob(options.stateDir, reactivated);
    if (!canReactivate) await syncImplementationState(options.stateDir, reactivated);
  }
  jobs = await listPrGuardianJobs(options.stateDir);
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
      (job.status === 'pending' && job.attemptCount < job.retryBudget) ||
      (isStaleRunningJob(job, options.config.guardian.timeoutMinutes) && job.attemptCount < job.retryBudget) ||
      (job.status === 'blocked' && job.attemptCount < job.retryBudget)
  );
  const results: PrGuardianJob[] = [];
  for (const job of runnable) {
    results.push(await runPrGuardianJob({ ...options, job }));
  }
  return [...reconciledTerminalJobs, ...results];
}

function requestForJob(
  options: { config: KaizenConfig; workspaceDir: string },
  job: PrGuardianJob
): PrGuardianSkillRequest {
  return {
    config: options.config,
    workspaceDir: options.workspaceDir,
    repo: job.repo,
    prUrl: job.prUrl,
    prNumber: job.prNumber,
    branch: job.branch,
    baseBranch: job.baseBranch
  };
}

async function withGuardianWorktree<T>(
  options: { stateDir: string; workspaceDir: string; runCommand: CommandRunner },
  job: PrGuardianJob,
  execute: (workspaceDir: string) => Promise<T>
): Promise<T> {
  const git = new GitClient(options.runCommand, options.workspaceDir);
  const worktreePath = path.join(options.stateDir, 'guardian', 'worktrees', job.id);
  const localBranch = `kaizen-guardian/pr-${job.prNumber}-${job.headSha.slice(0, 12)}`;
  await git.fetch();
  await git.worktreePrune();
  await git.worktreeRemove(worktreePath);
  await fs.rm(worktreePath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git.deleteLocalBranch(localBranch);
  await git.worktreeAdd(worktreePath, localBranch, job.headSha);
  try {
    return await execute(worktreePath);
  } finally {
    await git.worktreeRemove(worktreePath);
    await fs.rm(worktreePath, { recursive: true, force: true });
    await git.deleteLocalBranch(localBranch);
    await git.worktreePrune();
  }
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
    const initialState = await inspectPullRequest(runCommand, req);
    if (initialState.state === 'MERGED') {
      return {
        status: 'success',
        summary: successSummary({ ...initialState, isReady: true, blockers: [] }),
        raw: '',
        durationMs: Date.now() - startMs,
        activityFingerprint: initialState.activityFingerprint
      };
    }
    const initialGate = await inspectPrGate(runCommand, req);
    const settledInitialGate = isAuditedReady(initialGate)
      ? await waitForStablePrGate(runCommand, req, initialGate, 30)
      : initialGate.isReady
        ? initialGate
        : await waitForInitiallyReadyPrGate(runCommand, req, initialGate);
    if (isAuditedReady(settledInitialGate)) {
      return {
        status: 'success',
        summary: successSummary(settledInitialGate),
        raw: '',
        durationMs: Date.now() - startMs,
        activityFingerprint: settledInitialGate.activityFingerprint
      };
    }
    rawOutputs.push(`PR was not stably merge-ready before the first guardian pass:\n${summarizeGate(settledInitialGate)}`);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        const preflight = await inspectPrGate(runCommand, req);
        if (isAuditedReady(preflight)) {
          const stablePreflight = await waitForStablePrGate(runCommand, req, preflight, 30);
          if (isAuditedReady(stablePreflight)) {
            return {
              status: 'success',
              summary: successSummary(stablePreflight),
              raw: rawOutputs.join('\n'),
              durationMs: Date.now() - startMs,
              activityFingerprint: stablePreflight.activityFingerprint
            };
          }
          rawOutputs.push(`PR became not merge-ready after retry preflight settle wait before pass ${attempt}:\n${summarizeGate(stablePreflight)}`);
        } else {
          rawOutputs.push(`PR still not merge-ready before guardian pass ${attempt}:\n${summarizeGate(preflight)}`);
        }
      }

      const guardianAttemptStartedAt = Date.now();
      let result: Awaited<ReturnType<CommandRunner>>;
      try {
        result = await runCommand(
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
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        rawOutputs.push(failure);
        return finishAfterGuardianCommandFailure(
          runCommand,
          req,
          rawOutputs,
          startMs,
          guardianAttemptStartedAt,
          failure
        );
      }
      rawOutputs.push(`${result.stdout}${result.stderr}`);
      if (result.exitCode !== 0) {
        return finishAfterGuardianCommandFailure(
          runCommand,
          req,
          rawOutputs,
          startMs,
          guardianAttemptStartedAt,
          `PR guardian skill exited with code ${result.exitCode}.`
        );
      }

      const gate = await inspectPrGate(runCommand, req);
      if (gate.isReady) {
        const lateGate = await waitForStablePrGate(runCommand, req, gate);
        if (!lateGate.isReady) {
          rawOutputs.push(`PR became not merge-ready after bot review settle wait on pass ${attempt}:\n${summarizeGate(lateGate)}`);
          continue;
        }
        return {
          status: 'success',
          summary: successSummary(lateGate),
          raw: rawOutputs.join('\n'),
          durationMs: Date.now() - startMs,
          activityFingerprint: lateGate.activityFingerprint
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

interface PrCheckAnnotationSummary {
  checkName: string;
  level: string;
  path?: string;
  startLine?: number;
  message?: string;
  checkCompletedAt?: string;
}

interface PrGateSummary {
  isReady: boolean;
  hasCurrentHeadCodexNoFindings: boolean;
  hasUndatedAuditableActivity: boolean;
  hasInProgressAuditableActivity: boolean;
  codexNoFindingsAt?: string;
  latestAuditableActivityAt?: string;
  blockers: string[];
  state?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  reviewDecision?: string;
  headRefOid?: string;
  activityFingerprint?: string;
  reviewBlockers?: string[];
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
  reviewRequests?: Array<{ login?: string }>;
  headRefOid?: string;
  comments?: Array<{ id?: string; createdAt?: string; updatedAt?: string; author?: { login?: string } | null; body?: string }>;
  statusCheckRollup?: Array<{
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    state?: string;
    conclusion?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
}

interface PullRequestReviewResponse {
  id?: number;
  user?: { login?: string } | null;
  state?: string;
  submitted_at?: string;
  commit_id?: string;
}

interface PullRequestReviewCommentResponse {
  id?: number;
  created_at?: string;
  updated_at?: string;
  commit_id?: string;
  in_reply_to_id?: number;
  user?: { login?: string } | null;
}

interface PullRequestIssueCommentResponse {
  id?: number | string;
  created_at?: string;
  updated_at?: string;
  body?: string;
  user?: { login?: string } | null;
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
  const checkAnnotations = pullRequest.headRefOid
    ? await listCheckAnnotations(runCommand, req, pullRequest.headRefOid)
    : [];
  const auditableCheckAnnotations = checkAnnotations.filter(
    (annotation) => annotation.level === 'failure' || annotation.level === 'warning'
  );
  const terminal = pullRequest.state === 'MERGED';
  const hasUndatedAuditableActivity =
    pullRequest.hasUndatedAuditableActivity ||
    auditableCheckAnnotations.some((annotation) => !annotation.checkCompletedAt);
  const blockers = [
    ...mergeabilityBlockers(pullRequest),
    ...(pullRequest.reviewBlockers ?? []),
    ...(terminal || !pullRequest.hasInProgressAuditableActivity ? [] : ['auditable PR activity is still in progress']),
    ...(terminal ? [] : unresolvedThreads.map((thread) => {
      const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
      const author = thread.author ? ` by ${thread.author}` : '';
      return `unresolved review thread at ${location}${author}`;
    }))
  ];

  return {
    ...pullRequest,
    activityFingerprint: JSON.stringify({
      pullRequest: pullRequest.activityFingerprint,
      unresolvedThreads,
      checkAnnotations
    }),
    blockers,
    isReady: blockers.length === 0,
    hasCurrentHeadCodexNoFindings: pullRequest.hasCurrentHeadCodexNoFindings,
    hasUndatedAuditableActivity,
    hasInProgressAuditableActivity: pullRequest.hasInProgressAuditableActivity,
    codexNoFindingsAt: pullRequest.codexNoFindingsAt,
    latestAuditableActivityAt: latestTimestamp([
      pullRequest.latestAuditableActivityAt,
      ...auditableCheckAnnotations.map((annotation) => annotation.checkCompletedAt)
    ])
  };
}

async function listCheckAnnotations(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest,
  headRefOid: string
): Promise<PrCheckAnnotationSummary[]> {
  const runsResult = await runCommand('gh', [
    'api',
    `repos/${req.repo}/commits/${headRefOid}/check-runs?per_page=100`,
    '--paginate',
    '--slurp'
  ], {
    cwd: req.workspaceDir,
    env: githubCliEnv(),
    timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
    rejectOnNonZero: false
  });
  if (runsResult.exitCode !== 0) {
    throw new Error(`Could not inspect PR check runs: ${runsResult.stderr || runsResult.stdout}`);
  }
  const runPages = JSON.parse(runsResult.stdout || '[]') as Array<{ check_runs?: Array<{
    id?: number;
    name?: string;
    completed_at?: string;
    output?: { annotations_count?: number };
  }> }>;
  const checkRuns = runPages.flatMap((page) => page.check_runs ?? []);
  const annotatedRuns = checkRuns.filter((run) => (run.output?.annotations_count ?? 0) > 0);
  for (const checkRun of annotatedRuns) {
    if (!checkRun.id) throw new Error('Could not inspect check annotations: check run id is missing.');
  }
  const annotations: PrCheckAnnotationSummary[] = [];
  for (let index = 0; index < annotatedRuns.length; index += 4) {
    const batch = await Promise.all(annotatedRuns.slice(index, index + 4).map(async (checkRun) => {
      const result = await runCommand('gh', [
        'api',
        `repos/${req.repo}/check-runs/${checkRun.id}/annotations?per_page=100`,
        '--paginate',
        '--slurp'
      ], {
        cwd: req.workspaceDir,
        env: githubCliEnv(),
        timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
        rejectOnNonZero: false
      });
      if (result.exitCode !== 0) {
        throw new Error(`Could not inspect annotations for check ${checkRun.name ?? checkRun.id}: ${result.stderr || result.stdout}`);
      }
      const pages = JSON.parse(result.stdout || '[]') as Array<Array<{
        annotation_level?: string;
        path?: string;
        start_line?: number;
        message?: string;
      }>>;
      return pages.flat().map((annotation) => ({
        checkName: checkRun.name ?? String(checkRun.id),
        level: String(annotation.annotation_level ?? 'unknown').toLowerCase(),
        path: annotation.path,
        startLine: annotation.start_line,
        message: annotation.message,
        checkCompletedAt: checkRun.completed_at
      }));
    }));
    annotations.push(...batch.flat());
  }
  return annotations;
}

async function inspectPullRequestTerminalState(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<PullRequestTerminalState> {
  const result = await runCommand('gh', [
    'pr',
    'view',
    String(req.prNumber),
    '--repo',
    req.repo,
    '--json',
    'state,baseRefName,closingIssuesReferences'
  ], {
    cwd: req.workspaceDir,
    env: githubCliEnv(),
    timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
    rejectOnNonZero: false
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect PR state: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || '{}') as PullRequestTerminalState;
}

async function inspectPullRequest(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<Omit<PrGateSummary, 'isReady' | 'blockers'>> {
  const [result, reviews, reviewComments, issueComments, requiredChecks] = await Promise.all([
    runCommand('gh', [
      'pr',
      'view',
      String(req.prNumber),
      '--repo',
      req.repo,
      '--json',
      'state,isDraft,mergeStateStatus,mergeable,reviewDecision,reviewRequests,headRefOid,statusCheckRollup'
    ], {
      cwd: req.workspaceDir,
      env: githubCliEnv(),
      timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
      rejectOnNonZero: false
    }),
    listPullRequestReviews(runCommand, req),
    listPullRequestReviewComments(runCommand, req),
    listPullRequestIssueComments(runCommand, req),
    listRequiredChecks(runCommand, req)
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect PR mergeability: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout || '{}') as PullRequestViewResponse;
  const auditedParsed: PullRequestViewResponse = {
    ...parsed,
    comments: issueComments.map((comment) => ({
      id: String(comment.id ?? ''),
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      author: comment.user,
      body: comment.body
    }))
  };
  const codexEvidence = currentHeadCodexNoFindingsEvidence(auditedParsed);
  const auditableCheckActivity = (parsed.statusCheckRollup ?? []).filter(isAuditableCheckActivity);
  return {
    state: parsed.state,
    isDraft: parsed.isDraft,
    mergeStateStatus: parsed.mergeStateStatus,
    mergeable: parsed.mergeable,
    reviewDecision: parsed.reviewDecision,
    headRefOid: parsed.headRefOid,
    activityFingerprint: JSON.stringify({
      headRefOid: parsed.headRefOid,
      checks: requiredChecks,
      checkRollup: (parsed.statusCheckRollup ?? []).map((check) => [
        check.name ?? check.context,
        check.status ?? check.state,
        check.conclusion,
        check.startedAt,
        check.completedAt
      ]),
      reviews: reviews.map((review) => [review.id, review.submitted_at, review.state, review.commit_id]),
      reviewRequests: (parsed.reviewRequests ?? []).map((request) => request.login),
      reviewComments: reviewComments.map((comment) => [
        comment.id,
        comment.updated_at,
        comment.created_at,
        comment.commit_id,
        comment.in_reply_to_id,
        comment.user?.login
      ]),
      comments: (auditedParsed.comments ?? []).map((comment) => [comment.id, comment.updatedAt, comment.createdAt])
    }),
    reviewBlockers: [
      ...currentHeadReviewBlockers(auditedParsed, reviews)
    ],
    hasCurrentHeadCodexNoFindings: Boolean(codexEvidence),
    hasUndatedAuditableActivity:
      auditableCheckActivity.some((check) => !check.completedAt) ||
      reviews.some((review) => !review.submitted_at) ||
      (auditedParsed.comments ?? []).some((comment) => {
        if (comment === codexEvidence?.comment) return false;
        const observedAt = comment.updatedAt ?? comment.createdAt;
        return !observedAt || Number.isNaN(Date.parse(observedAt));
      }),
    hasInProgressAuditableActivity: auditableCheckActivity.some((check) => {
      const status = String(check.status ?? check.state ?? '').toUpperCase();
      return ['EXPECTED', 'IN_PROGRESS', 'PENDING', 'QUEUED', 'REQUESTED', 'WAITING'].includes(status);
    }) || reviews.some((review) => !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(review.state ?? '')),
    codexNoFindingsAt: codexEvidence?.observedAt,
    latestAuditableActivityAt: latestTimestamp([
      ...(auditedParsed.comments ?? [])
        .filter((comment) => comment !== codexEvidence?.comment)
        .flatMap((comment) => [comment.updatedAt, comment.createdAt]),
      ...reviews.map((review) => review.submitted_at),
      ...reviewComments.flatMap((comment) => [comment.updated_at, comment.created_at]),
      ...auditableCheckActivity.flatMap((check) => [check.completedAt, check.startedAt])
    ]),
    checks: requiredChecks
  };
}

async function listRequiredChecks(runCommand: CommandRunner, req: PrGuardianSkillRequest): Promise<PrCheckSummary[]> {
  const result = await runCommand('gh', [
    'pr',
    'checks',
    String(req.prNumber),
    '--repo',
    req.repo,
    '--required',
    '--json',
    'name,state,bucket,workflow'
  ], {
    cwd: req.workspaceDir,
    env: githubCliEnv(),
    timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
    rejectOnNonZero: false
  });
  if (!result.stdout.trim()) {
    if (result.exitCode === 0) return [];
    if (/^no (?:required )?checks reported on the '.+' branch$/i.test(result.stderr.trim())) return [];
    throw new Error(`Could not inspect required PR checks: ${result.stderr || `exit ${result.exitCode}`}`);
  }
  const checks = JSON.parse(result.stdout) as Array<{ name?: string; state?: string; bucket?: string }>;
  return checks.map((check) => ({
    name: check.name ?? '(unknown check)',
    status: check.bucket === 'pass' || check.bucket === 'skipping' ? 'SUCCESS' : String(check.state ?? check.bucket ?? '')
  }));
}

async function listPullRequestReviews(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<PullRequestReviewResponse[]> {
  const result = await runCommand('gh', [
    'api',
    `repos/${req.repo}/pulls/${req.prNumber}/reviews?per_page=100`,
    '--paginate',
    '--slurp'
  ], {
    cwd: req.workspaceDir,
    env: githubCliEnv(),
    timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
    rejectOnNonZero: false
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect PR reviews: ${result.stderr || result.stdout}`);
  }
  const pages = JSON.parse(result.stdout || '[]') as PullRequestReviewResponse[] | PullRequestReviewResponse[][];
  return Array.isArray(pages[0])
    ? (pages as PullRequestReviewResponse[][]).flat()
    : pages as PullRequestReviewResponse[];
}

async function listPullRequestReviewComments(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<PullRequestReviewCommentResponse[]> {
  const result = await runCommand('gh', [
    'api',
    `repos/${req.repo}/pulls/${req.prNumber}/comments?per_page=100`,
    '--paginate',
    '--slurp'
  ], {
    cwd: req.workspaceDir,
    env: githubCliEnv(),
    timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
    rejectOnNonZero: false
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect PR review comments: ${result.stderr || result.stdout}`);
  }
  const pages = JSON.parse(result.stdout || '[]') as unknown;
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error('Could not inspect PR review comments: response was not a paginated array.');
  }
  const comments = (pages as PullRequestReviewCommentResponse[][]).flat();
  for (const comment of comments) {
    const observedAt = comment.updated_at ?? comment.created_at;
    if (
      typeof comment.id !== 'number' ||
      !observedAt ||
      Number.isNaN(Date.parse(observedAt))
    ) {
      throw new Error('Could not inspect PR review comments: response contained activity without an id or valid timestamp.');
    }
  }
  return comments;
}

async function listPullRequestIssueComments(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<PullRequestIssueCommentResponse[]> {
  const result = await runCommand('gh', [
    'api',
    `repos/${req.repo}/issues/${req.prNumber}/comments?per_page=100`,
    '--paginate',
    '--slurp'
  ], {
    cwd: req.workspaceDir,
    env: githubCliEnv(),
    timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
    rejectOnNonZero: false
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect PR issue comments: ${result.stderr || result.stdout}`);
  }
  const pages = JSON.parse(result.stdout || '[]') as unknown;
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error('Could not inspect PR issue comments: response was not a paginated array.');
  }
  return (pages as PullRequestIssueCommentResponse[][]).flat();
}

function currentHeadReviewBlockers(parsed: PullRequestViewResponse, reviews: PullRequestReviewResponse[]): string[] {
  if (!parsed.headRefOid || parsed.state === 'MERGED') return [];
  const blockers: string[] = [];
  const latestByBot = new Map<string, PullRequestReviewResponse>();
  for (const review of reviews) {
    const login = normalizeReviewerLogin(review.user?.login);
    if (!isExpectedBotLogin(login)) continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(review.state ?? '')) {
      latestByBot.set(login, review);
      continue;
    }
    const current = latestByBot.get(login);
    if (current && !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(current.state ?? '')) continue;
    if (!current || String(review.submitted_at ?? '') > String(current.submitted_at ?? '')) latestByBot.set(login, review);
  }
  for (const request of parsed.reviewRequests ?? []) {
    const login = normalizeReviewerLogin(request.login);
    if (!isExpectedBotLogin(login)) continue;
    const review = latestByBot.get(login);
    if (hasCurrentHeadBotEvidence(login, parsed)) continue;
    if (
      review?.commit_id === parsed.headRefOid &&
      ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(review.state ?? '')
    ) continue;
    blockers.push(`${login} requested review is not terminal for current PR head ${parsed.headRefOid}`);
  }
  blockers.push(...[...latestByBot.entries()].flatMap(([login, review]) => {
    if (hasCurrentHeadBotEvidence(login, parsed)) return [];
    if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(review.state ?? '')) {
      return [`${login} review is not terminal for current PR head ${parsed.headRefOid}`];
    }
    return review.commit_id === parsed.headRefOid
      ? []
      : [`${login} review is not for current PR head ${parsed.headRefOid}`];
  }));
  return [...new Set(blockers)];
}

function hasCurrentHeadBotEvidence(login: string, parsed: PullRequestViewResponse): boolean {
  if (!parsed.headRefOid) return false;
  if (login === 'chatgpt-codex-connector') return Boolean(currentHeadCodexNoFindingsEvidence(parsed));
  if (login === 'coderabbitai') {
    return (parsed.statusCheckRollup ?? []).some((check) => {
      const name = `${check.name ?? ''} ${check.context ?? ''}`.toLowerCase();
      const result = String(check.conclusion ?? check.state ?? '').toUpperCase();
      return name.includes('coderabbit') && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result);
    });
  }
  return false;
}

function isExpectedBotLogin(login: string): boolean {
  return login === 'chatgpt-codex-connector' || login === 'coderabbitai';
}

function currentHeadCodexNoFindingsEvidence(parsed: PullRequestViewResponse): {
  comment: NonNullable<PullRequestViewResponse['comments']>[number];
  observedAt: string;
} | undefined {
  if (!parsed.headRefOid) return undefined;
  const candidates: Array<{
    comment: NonNullable<PullRequestViewResponse['comments']>[number];
    observedAt: string;
  }> = [];
  for (const comment of parsed.comments ?? []) {
    if (normalizeReviewerLogin(comment.author?.login) !== 'chatgpt-codex-connector') continue;
    const body = comment.body ?? '';
    const noFindings = body.match(/^Codex Review:\s*Didn['’]t find any (?:major )?issues\.([^\r\n]*)/i);
    const reviewedCommit = body.match(/\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i);
    const contradictoryTail = /\b(?:however|but|finding(?:s)?|found|issues? remain)\b/i.test(noFindings?.[1] ?? '');
    const observedAt = comment.updatedAt ?? comment.createdAt;
    if (
      noFindings &&
      !contradictoryTail &&
      reviewedCommit?.[1] &&
      parsed.headRefOid.startsWith(reviewedCommit[1]) &&
      observedAt &&
      !Number.isNaN(Date.parse(observedAt))
    ) {
      candidates.push({ comment, observedAt });
    }
  }
  return candidates.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
}

function normalizeReviewerLogin(login: string | undefined): string {
  return (login ?? 'automated reviewer').toLowerCase().replace(/\[bot\]$/, '');
}

function isAuditableCheckActivity(
  check: NonNullable<PullRequestViewResponse['statusCheckRollup']>[number]
): boolean {
  const result = String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase();
  return Boolean(result) && !PASSING_CHECK_CONCLUSIONS.has(result);
}

function isAuditedReady(gate: PrGateSummary, evidenceNotBefore?: number): boolean {
  if (!gate.isReady) return false;
  if (gate.state === 'MERGED') return true;
  const evidenceAt = Date.parse(gate.codexNoFindingsAt ?? '');
  if (Number.isNaN(evidenceAt)) return false;
  if (gate.hasUndatedAuditableActivity) return false;
  const latestActivityAt = Date.parse(gate.latestAuditableActivityAt ?? '');
  if (!Number.isNaN(latestActivityAt) && evidenceAt <= latestActivityAt) return false;
  return evidenceNotBefore === undefined || evidenceAt > Math.floor(evidenceNotBefore / 1_000) * 1_000;
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value!)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function mergeabilityBlockers(state: Omit<PrGateSummary, 'isReady' | 'blockers'>): string[] {
  const blockers: string[] = [];
  if (state.state === 'MERGED') return blockers;
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
  return value === 'CLEAN' || value === 'HAS_HOOKS' || value === 'UNSTABLE';
}

const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

function isPassingCheck(check: PrCheckSummary): boolean {
  if (check.conclusion !== undefined) return check.status === 'COMPLETED' && PASSING_CHECK_CONCLUSIONS.has(check.conclusion);
  return check.status === 'SUCCESS';
}

async function waitForStablePrGate(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest,
  initial: PrGateSummary,
  minimumSettleSeconds = 0
): Promise<PrGateSummary> {
  const settleMs = Math.max(req.config.guardian.reviewSettleSeconds, minimumSettleSeconds) * 1_000;
  if (settleMs > 0) await sleep(boundedTimeoutMs(settleMs, req.runDeadlineAt));
  const first = await inspectPrGate(runCommand, req);
  if (!first.isReady) return first;
  if (first.headRefOid !== initial.headRefOid) {
    return { ...first, isReady: false, blockers: ['PR head changed during stabilization'] };
  }
  if (settleMs > 0) await sleep(boundedTimeoutMs(settleMs, req.runDeadlineAt));
  const second = await inspectPrGate(runCommand, req);
  if (!second.isReady) return second;
  if (second.headRefOid !== first.headRefOid || second.activityFingerprint !== first.activityFingerprint) {
    return { ...second, isReady: false, blockers: ['PR activity changed during stabilization'] };
  }
  return second;
}

async function waitForInitiallyReadyPrGate(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest,
  initial: PrGateSummary
): Promise<PrGateSummary> {
  const settleMs = req.config.guardian.reviewSettleSeconds * 1_000;
  if (settleMs <= 0) return initial;
  await sleep(boundedTimeoutMs(settleMs, req.runDeadlineAt));
  const gate = await inspectPrGate(runCommand, req);
  if (!gate.isReady) return gate;
  return waitForStablePrGate(runCommand, req, gate, isAuditedReady(gate) ? 30 : 0);
}

async function finishAfterGuardianCommandFailure(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest,
  rawOutputs: string[],
  startMs: number,
  guardianAttemptStartedAt: number,
  failureSummary: string
): Promise<PrGuardianSkillResult> {
  const reconciled = await reconcileReadyPrGate(runCommand, req, rawOutputs, guardianAttemptStartedAt);
  return {
    status: reconciled ? 'success' : 'failed',
    summary: reconciled ? successSummary(reconciled) : failureSummary,
    raw: rawOutputs.join('\n'),
    durationMs: Date.now() - startMs,
    activityFingerprint: reconciled?.activityFingerprint
  };
}

async function reconcileReadyPrGate(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest,
  rawOutputs: string[],
  guardianAttemptStartedAt: number
): Promise<PrGateSummary | undefined> {
  try {
    const gate = await inspectPrGate(runCommand, req);
    if (!isAuditedReady(gate, guardianAttemptStartedAt)) {
      rawOutputs.push(`PR remained blocked after guardian command failure:\n${summarizeGate(gate)}`);
      return undefined;
    }
    const stable = await waitForStablePrGate(runCommand, req, gate, 30);
    if (!isAuditedReady(stable, guardianAttemptStartedAt)) {
      rawOutputs.push(`PR was not stably merge-ready after guardian command failure:\n${summarizeGate(stable)}`);
      return undefined;
    }
    return stable;
  } catch (error) {
    rawOutputs.push(`Could not reconcile PR state after guardian command failure: ${String(error)}`);
    return undefined;
  }
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
  if (gate.state === 'MERGED') return 'PR guardian completed; PR is merged.';
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
- This is an isolated worktree pinned to the recorded PR head. Before every push, compare GitHub headRefOid with the worktree's initial HEAD and stop without pushing if it changed; push only HEAD to the explicit remote branch ${req.branch}, without force.
- Check the PR with gh pr view and gh pr checks.
- Watch relevant workflow runs with gh run watch --exit-status when a run exists.
- Always inspect PR review feedback before declaring the PR ready to merge. Do not require reviewDecision=APPROVED or human approval unless GitHub branch protection explicitly requires it.
- Fetch inline review threads and PR comments with resolution state using paginated GraphQL/API reads, iterating until hasNextPage=false, for example via PullRequest.reviewThreads, so unresolved actionable feedback cannot be missed.
- Fetch review commit evidence from the paginated REST pulls/${req.prNumber}/reviews endpoint and compare commit_id with the pinned head; gh pr view review objects are not current-head evidence.
- Address every unresolved actionable review thread, PR comment, and check annotation with focused commits or an explicit disposition, then push any fixes. If you can resolve an addressed review thread, resolve it after replying with the disposition.
- Reply in the same review thread or comment for each addressed review item with the action taken and validation run before resolving it. If GitHub does not support a threaded reply for that item, add a PR comment that links to the original comment or review and lists the action taken.
- Stop only when GitHub reports the PR as fully mergeable: mergeable=MERGEABLE, mergeStateStatus=CLEAN, HAS_HOOKS, or UNSTABLE with only documented non-required failures, required checks are passing, and no unresolved review threads or actionable PR comments remain. If branch protection requires conversation resolution, outdated unresolved threads still block merging until they are replied to and resolved. A missing approval or reviewDecision other than APPROVED is not a blocker by itself; inspect comments again after every pushed fix.
- Re-check the PR state during every wait. If GitHub reports state=MERGED, stop all watches immediately and exit successfully so the parent guardian can reap this worker. A merged PR is a terminal success even if review threads remain unresolved; do not keep waiting or editing after merge.
- Do not merge the PR.
- Before finishing, comment on the PR with final mergeability, watched runs, fixes pushed, feedback addressed, unresolved/skipped feedback with reasons, and remaining blockers.`;
}
