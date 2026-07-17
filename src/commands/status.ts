import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRegistry, resolveProject } from '../config/registry.js';
import { loadConfig } from '../config/config.js';
import { GitHubClient } from '../github/client.js';
import type { CommandRunner } from '../utils/command.js';
import { projectStateDir } from '../utils/paths.js';
import { GitClient } from '../workspace/git.js';
import { listPrGuardianJobs } from '../orchestrator/prGuardian.js';
import { listImplementationStates, type ImplementationState } from '../orchestrator/implementationState.js';
import type { RunIssueSummary, RunSummary } from '../orchestrator/summary.js';
import {
  GENERATED_PULL_REQUEST_FETCH_LIMIT,
  type GeneratedPullRequestBacklog,
  summarizeGeneratedPullRequestBacklog
} from '../orchestrator/wipLimit.js';

interface UnreviewedRemoteBranch {
  branch: string;
  remoteRef: string;
  headSha: string;
  ahead: number;
  behind: number;
}

interface OpenPullRequestHead {
  branch: string;
  repositoryOwner?: string;
}

export async function statusProject(options: { cwd: string; project?: string; metrics?: boolean; runCommand: CommandRunner }) {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  const github = new GitHubClient(options.runCommand, resolved.project.localPath);
  const issues = await github.listIssues(config.issues.label);
  const openPullRequests = await github.listOpenPullRequests();
  const generatedPullRequestBacklog = options.metrics
    ? summarizeGeneratedPullRequestBacklog({
        pullRequests: await github.searchOpenPullRequestsForOwner(
          resolved.project.repo.split('/')[0],
          GENERATED_PULL_REQUEST_FETCH_LIMIT
        ),
        repo: resolved.project.repo,
        wipLimit: config.safety.wipLimit
      })
    : undefined;
  const stateDir = projectStateDir(resolved.slug);
  const lastRun = await readLastRun(stateDir);
  const lastSummary = await readLatestSummary(stateDir);
  const guardianJobs = await listPrGuardianJobs(stateDir);
  const implementationStates = await listImplementationStates(stateDir);
  const openPullRequestNumbers = new Set(openPullRequests.map((pr) => pr.number));
  return {
    slug: resolved.slug,
    repo: resolved.project.repo,
    enabled: resolved.project.enabled,
    schedule: resolved.project.schedule,
    lastRun: lastRun ?? resolved.project.lastRun ?? lastSummary,
    issues: {
      open: issues.length,
      selectionMode: config.issues.selection.mode,
      queued: countLabel(issues, config.issues.selection.includeLabel),
      p0: countLabel(issues, 'kaizen:P0'),
      p1: countLabel(issues, 'kaizen:P1'),
      p2: countLabel(issues, 'kaizen:P2'),
      needsHuman: countLabel(issues, 'kaizen:needs-human'),
      retryable: countLabel(issues, 'kaizen:retryable'),
      blocked: countLabel(issues, 'kaizen:blocked'),
      upstreamFirst: countLabel(issues, 'kaizen:upstream-first'),
      notActionable: countLabel(issues, 'kaizen:not-actionable'),
      attemptsExhausted: countLabel(issues, 'kaizen:attempts-exhausted')
    },
    pullRequests: {
      open: openPullRequests.length
    },
    guardian: {
      jobs: guardianJobs.length,
      pending: countJobs(guardianJobs, 'pending'),
      running: countJobs(guardianJobs, 'running'),
      success: countJobs(guardianJobs, 'success'),
      blocked: countJobs(guardianJobs, 'blocked'),
      skipped: countJobs(guardianJobs, 'skipped'),
      stale: guardianJobs.filter((job) => isStaleGuardianJob(job, openPullRequestNumbers)).length,
      latest: guardianJobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).at(0)
    },
    implementations: {
      jobs: implementationStates.length,
      active: implementationStates.filter((state) => ['implementing', 'verifying', 'publishing', 'guardian'].includes(state.phase)).length,
      needsAttention: implementationStates.filter(isImplementationNeedsAttention).length,
      stale: implementationStates.filter(isStaleImplementationState).length,
      latest: [...implementationStates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).at(0),
      items: implementationStates.sort((a, b) => a.issue - b.issue)
    },
    branchHygiene: await collectBranchHygiene({
      runCommand: options.runCommand,
      workspacePath: resolved.project.workspacePath,
      defaultBranch: config.git.defaultBranch,
      repoOwner: resolved.project.repo.split('/')[0].toLowerCase(),
      openPullRequestHeads: openPullRequests
        .filter((pr) => Boolean(pr.headRefName))
        .map((pr) => ({
          branch: pr.headRefName as string,
          repositoryOwner: pr.headRepositoryOwner?.login?.toLowerCase()
        }))
    }),
    metrics: options.metrics ? await collectMetrics(stateDir, generatedPullRequestBacklog) : undefined
  };
}

function isStaleImplementationState(state: ImplementationState): boolean {
  if (state.phase === 'complete') return false;
  const updatedAt = Date.parse(state.updatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > 24 * 60 * 60 * 1000;
}

function isImplementationNeedsAttention(state: ImplementationState): boolean {
  return state.phase === 'failed' || state.phase === 'blocked' || Boolean(state.lastFailure);
}

export async function listProjects() {
  const registry = await loadRegistry();
  const projects = await Promise.all(Object.entries(registry.projects).map(async ([slug, project]) => [
    slug,
    { ...project, lastRun: await readLastRun(projectStateDir(slug)) ?? project.lastRun }
  ] as const));
  return { ...registry, projects: Object.fromEntries(projects) };
}

async function readLatestSummary(stateDir: string) {
  try {
    const runsDir = path.join(stateDir, 'runs');
    const runs = (await fs.readdir(runsDir)).sort();
    const latest = runs.at(-1);
    if (!latest) return undefined;
    return JSON.parse(await fs.readFile(path.join(runsDir, latest, 'summary.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function readLastRun(stateDir: string) {
  try {
    return JSON.parse(await fs.readFile(path.join(stateDir, 'last-run.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function collectMetrics(stateDir: string, wipLimit?: GeneratedPullRequestBacklog) {
  try {
    const runsDir = path.join(stateDir, 'runs');
    const runs = await fs.readdir(runsDir);
    const loaded = await Promise.all(runs.map((run) => readRunSummary(runsDir, run)));
    const summaries = loaded.flatMap((item) => (item.summary ? [item.summary] : []));
    const unreadableRuns = loaded.filter((item) => !item.summary).length;
    const cumulative = summarizeRunIssues(summaries);
    const now = new Date();
    const reviewWindowSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const reviewWindowSummaries = summaries.filter((summary) => {
      const startedAt = Date.parse(summary.startedAt);
      return Number.isFinite(startedAt) && startedAt >= reviewWindowSince.getTime() && startedAt <= now.getTime();
    });
    const reviewWindow = summarizeRunIssues(reviewWindowSummaries);
    return {
      runs: cumulative.runs,
      processed: cumulative.processed,
      prCreated: cumulative.prCreated,
      directCommit: cumulative.directCommit,
      failed: cumulative.failed,
      blocked: cumulative.blocked,
      skipped: cumulative.skipped,
      verificationFailed: cumulative.verificationFailed,
      verifierBlocked: cumulative.verifierBlocked,
      verifierNeedsContext: cumulative.verifierNeedsContext,
      verifierFailed: cumulative.verifierFailed,
      guardian: cumulative.guardian,
      readableRuns: summaries.length,
      unreadableRuns,
      reviewWindow: {
        since: reviewWindowSince.toISOString(),
        until: now.toISOString(),
        ...reviewWindow
      },
      wipLimit
    };
  } catch {
    return {
      runs: 0,
      processed: 0,
      prCreated: 0,
      directCommit: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      verificationFailed: 0,
      verifierBlocked: 0,
      verifierNeedsContext: 0,
      verifierFailed: 0,
      guardian: emptyGuardianMetrics(),
      readableRuns: 0,
      unreadableRuns: 0,
      reviewWindow: {
        since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        until: new Date().toISOString(),
        ...emptyRunMetrics()
      },
      wipLimit
    };
  }
}

async function readRunSummary(runsDir: string, run: string): Promise<{ run: string; summary?: RunSummary }> {
  try {
    const summary = JSON.parse(await fs.readFile(path.join(runsDir, run, 'summary.json'), 'utf8')) as RunSummary;
    return { run, summary };
  } catch {
    return { run };
  }
}

function summarizeRunIssues(summaries: RunSummary[]) {
  const issues = summaries.flatMap((summary) => summary.issues ?? []);
  const topLevelSkipped = summaries.reduce((sum, summary) => sum + (summary.skipped?.length ?? 0), 0);
  const metrics = emptyRunMetrics();
  metrics.runs = summaries.length;
  metrics.processed = issues.length;
  metrics.prCreated = countOutcome(issues, 'pr-created');
  metrics.directCommit = countOutcome(issues, 'direct-commit');
  metrics.failed = countOutcome(issues, 'failed');
  metrics.blocked = countOutcome(issues, 'blocked');
  metrics.skipped = countOutcome(issues, 'skipped') + topLevelSkipped;
  metrics.verificationFailed = countReasonPrefix(issues, 'Verification failed:');
  metrics.verifierBlocked = countReasonPrefix(issues, 'Verifier blocked PR:');
  metrics.verifierNeedsContext = countReasonPrefix(issues, 'Verifier needs context:');
  metrics.verifierFailed = countReasonPrefix(issues, 'Verifier failed:');
  metrics.guardian = {
    eligible: issues.filter((issue) => Boolean(issue.guardian)).length,
    success: countGuardian(issues, 'success'),
    failed: countGuardian(issues, 'failed'),
    queued: countGuardian(issues, 'queued'),
    skipped: countGuardian(issues, 'skipped')
  };
  return metrics;
}

function emptyRunMetrics() {
  return {
    runs: 0,
    processed: 0,
    prCreated: 0,
    directCommit: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    verificationFailed: 0,
    verifierBlocked: 0,
    verifierNeedsContext: 0,
    verifierFailed: 0,
    guardian: emptyGuardianMetrics()
  };
}

function emptyGuardianMetrics() {
  return {
    eligible: 0,
    success: 0,
    failed: 0,
    queued: 0,
    skipped: 0
  };
}

function countOutcome(issues: RunIssueSummary[], outcome: RunIssueSummary['outcome']): number {
  return issues.filter((issue) => issue.outcome === outcome).length;
}

function countReasonPrefix(issues: RunIssueSummary[], prefix: string): number {
  return issues.filter((issue) => issue.reason?.startsWith(prefix)).length;
}

function countGuardian(issues: RunIssueSummary[], status: NonNullable<RunIssueSummary['guardian']>['status']): number {
  return issues.filter((issue) => issue.guardian?.status === status).length;
}

function countLabel(issues: Array<{ labels: Array<{ name: string }> }>, label: string): number {
  return issues.filter((issue) => issue.labels.some((item) => item.name === label)).length;
}

function countJobs<T extends { status: string }>(jobs: T[], status: string): number {
  return jobs.filter((job) => job.status === status).length;
}

function isStaleGuardianJob(job: { prNumber: number; status: string }, openPullRequestNumbers: Set<number>): boolean {
  return !openPullRequestNumbers.has(job.prNumber) && job.status !== 'success' && job.status !== 'skipped';
}

async function collectBranchHygiene(options: {
  runCommand: CommandRunner;
  workspacePath: string;
  defaultBranch: string;
  repoOwner: string;
  openPullRequestHeads: OpenPullRequestHead[];
}): Promise<{ checked: boolean; unreviewedRemoteBranches: UnreviewedRemoteBranch[]; error?: string }> {
  try {
    const git = new GitClient(options.runCommand, options.workspacePath);
    await git.fetchPrune();
    const openPullRequestBranches = new Set(
      options.openPullRequestHeads
        .filter((head) => head.repositoryOwner === options.repoOwner)
        .map((head) => head.branch)
    );
    const defaultRemoteRef = `origin/${options.defaultBranch}`;
    const unreviewedRemoteBranches: UnreviewedRemoteBranch[] = [];

    for (const branch of await git.remoteBranches('origin')) {
      if (branch.ref === 'origin/HEAD' || branch.ref === defaultRemoteRef || branch.name === options.defaultBranch) continue;
      if (openPullRequestBranches.has(branch.name)) continue;

      const divergence = await git.divergence(defaultRemoteRef, branch.ref);
      if (divergence.ahead === 0) continue;

      unreviewedRemoteBranches.push({
        branch: branch.name,
        remoteRef: branch.ref,
        headSha: branch.sha,
        ahead: divergence.ahead,
        behind: divergence.behind
      });
    }

    return { checked: true, unreviewedRemoteBranches };
  } catch (error) {
    return {
      checked: false,
      unreviewedRemoteBranches: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
