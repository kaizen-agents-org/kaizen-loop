import fs from 'node:fs/promises';
import path from 'node:path';
import { BuilderAgentAdapter } from '../agents/builder.js';
import { VerifierAgentAdapter, type VerifierResult } from '../agents/verifier.js';
import type { AgentAdapter, AgentResult, DiscoveredIssue } from '../agents/types.js';
import { buildFixPrompt, buildVerifierPrompt } from '../agents/prompt.js';
import { loadConfig } from '../config/config.js';
import { loadRegistry, resolveProject, saveRegistry } from '../config/registry.js';
import type { KaizenConfig, Registry } from '../config/schema.js';
import { CreatedPullRequestValidationError, GitHubClient } from '../github/client.js';
import type { GitHubIssue, GitHubPullRequest } from '../github/types.js';
import { agentSummary, buildPrProgressComment, buildResultComment, countAttempts } from '../report/comments.js';
import { throwIfShutdownRequested, withRunDeadline, type CommandRunner } from '../utils/command.js';
import { assertMinFreeDisk } from '../utils/disk.js';
import { ConfigError } from '../utils/errors.js';
import { projectStateDir } from '../utils/paths.js';
import { toRunId } from '../utils/runId.js';
import { tailLines } from '../utils/text.js';
import { WorkspaceManager, type DiffStats } from '../workspace/manager.js';
import { GitClient } from '../workspace/git.js';
import { labelNames, priorityLabel, selectIssues } from './issues.js';
import { RunLock } from './lock.js';
import { enqueuePrGuardianJob, runPrGuardianSkill, type PrGuardianSkillResult } from './prGuardian.js';
import {
  buildIssueIntakeComment,
  evaluateIssueIntake,
  hasIssueIntakeDecisionComment,
  type IssueIntakeDecision
} from './issueIntake.js';
import { decideReflection, type ReflectionDecision } from './reflection.js';
import type { RunDiscoveredFollowupSummary, RunIssueSummary, RunSummary } from './summary.js';
import {
  GENERATED_PULL_REQUEST_FETCH_LIMIT,
  generatedPullRequestWipLimitReason,
  isSyncPullRequest,
  summarizeGeneratedPullRequestBacklog
} from './wipLimit.js';
import { schedulerJob } from '../scheduler/scheduler.js';

export interface RunOptions {
  cwd: string;
  project?: string;
  scheduled: boolean;
  trigger?: 'manual' | 'scheduled' | 'afternoon' | 'instant' | 'watch';
  job?: string;
  issue?: number;
  issueNumbers?: number[];
  dryRun: boolean;
  maxIssues?: number;
  agent?: 'claude' | 'codex';
  json: boolean;
  assumeYes?: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<DirectCommitChoice>;
  runCommand: CommandRunner;
}

export type DirectCommitChoice = 'direct' | 'pr' | 'reject';

export interface DirectCommitConfirmation {
  issue: GitHubIssue;
  decision: ReflectionDecision;
  diff: DiffStats;
  verifyResults: Array<{ command: string; ok: boolean; output: string }>;
}

interface PullRequestReflection {
  url: string;
  number?: number;
  reason: string;
  branch: string;
  baseBranch: string;
  headSha: string;
}

interface RunIssueSelection {
  selected: GitHubIssue[];
  skipped: Array<{ number: number; reason: string }>;
  openPullRequests: GitHubPullRequest[];
}

const OPEN_PULL_REQUEST_LIMIT_CHECK_FETCH_LIMIT = 1000;

export async function runKaizen(options: RunOptions): Promise<RunSummary | { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> }> {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  if (options.job) {
    const configuredJob = config.scheduler.jobs[options.job];
    if (!configuredJob) throw new ConfigError(`Unknown scheduler job: ${options.job}`);
    if (!configuredJob.enabled) throw new ConfigError(`Scheduler job is disabled: ${options.job}`);
  }
  const scheduledJob = options.job ? schedulerJob(config, options.job) : undefined;
  const trigger = options.trigger ?? scheduledJob?.name ?? (options.scheduled ? 'scheduled' : 'manual');
  const startedAt = new Date();
  const runDeadlineAt = startedAt.getTime() + config.run.runTimeoutMinutes * 60_000;
  const runCommand = withRunDeadline(options.runCommand, runDeadlineAt);
  const nowDate = new Date();
  const cutoff = new Date(nowDate);
  cutoff.setHours(config.run.latestStartHour, 0, 0, 0);
  const lateStartGuard = scheduledJob?.config.run.mode === 'maintenance'
    ? scheduledJob.config.run.lateStartGuard
    : trigger === 'scheduled';
  const skipLatestStart = options.scheduled && lateStartGuard && nowDate > cutoff;
  const github = new GitHubClient(runCommand, resolved.project.localPath);
  const selectRunIssues = async () => {
    const requestedIssueNumbers = options.issueNumbers ?? (options.issue ? [options.issue] : undefined);
    const jobMaxIssues = scheduledJob?.config.run.maxIssues;
    const maxIssues = options.maxIssues ?? jobMaxIssues ?? (requestedIssueNumbers ? requestedIssueNumbers.length : config.run.maxIssuesPerNight);
    const requestedIssues = requestedIssueNumbers
      ? await Promise.all(uniqueIssueNumbers(requestedIssueNumbers).map((issueNumber) => github.getIssue(issueNumber)))
      : undefined;
    const issues = requestedIssues ?? await github.listIssues(config.issues.label);
    const automatic = options.scheduled && requestedIssues === undefined;
    const openPullRequests = automatic || issues.some(hasPullRequestResultMarker)
      ? await github.listOpenPullRequests(openPullRequestFetchLimit(config.run.maxOpenPullRequests))
      : [];
    const selection = selectIssues({
      issues,
      config,
      maxIssues,
      explicit: requestedIssues !== undefined,
      openPullRequests
    });
    const limited = await applyOpenPullRequestLimit({
      config,
      selection,
      automatic,
      openPullRequests
    });
    const wipLimited = await applyGeneratedPullRequestWipLimit({
      config,
      selection: limited,
      automatic,
      repo: resolved.project.repo,
      github
    });
    return { ...wipLimited, openPullRequests };
  };

  if (options.dryRun) {
    const { openPullRequests: _openPullRequests, ...selection } = await selectRunIssues();
    return selection;
  }

  const stateDir = projectStateDir(resolved.slug);
  await fs.mkdir(stateDir, { recursive: true });
  await ensureNotPaused(stateDir);
  let lock: RunLock;
  try {
    lock = await RunLock.acquire(stateDir);
  } catch (error) {
    const skipIfRunning = scheduledJob?.config.run.mode === 'watch'
      ? scheduledJob.config.run.skipIfRunning
      : trigger === 'watch';
    if (options.scheduled && skipIfRunning && RunLock.isActiveError(error)) {
      const now = new Date().toISOString();
      return {
        version: 1,
        project: resolved.slug,
        startedAt: now,
        finishedAt: now,
        trigger,
        result: 'success',
        issues: [],
        skipped: [{ number: 0, reason: 'run already in progress' }]
      };
    }
    throw error;
  }

  if (skipLatestStart) {
    const now = nowDate.toISOString();
    try {
      return await persistRunSummary(resolved.slug, {
        version: 1,
        project: resolved.slug,
        startedAt: now,
        finishedAt: now,
        trigger,
        result: 'success',
        issues: [],
        skipped: [{ number: 0, reason: `latestStartHour(${config.run.latestStartHour}) passed` }]
      });
    } finally {
      await lock.release();
    }
  }

  const runId = toRunId(startedAt);
  const runDir = path.join(stateDir, 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const summary: RunSummary = {
    version: 1,
    project: resolved.slug,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    trigger,
    result: 'success',
    issues: [],
    skipped: [],
  };

  let runFailed = false;
  try {
    let selection = await selectRunIssues();
    summary.skipped = selection.skipped;
    if (selection.selected.length > 0) {
      selection = await applyIssueIntakeGate({
        selection,
        repo: resolved.project.repo,
        runId,
        github,
        openPullRequests: selection.openPullRequests
      });
      summary.skipped = selection.skipped;
    }
    if (selection.selected.length > 0) {
      const remoteUrl = await new GitClient(runCommand, resolved.project.localPath).remoteUrl('origin');
      const baseWorkspace = new WorkspaceManager(runCommand, resolved.project.workspacePath, remoteUrl);
      const baseline = await prepareBaseWorkspace({
        workspace: baseWorkspace,
        config,
        runId,
        runDir,
        firstIssue: selection.selected[0],
        github,
        runDeadlineAt
      });

      if (!baseline.ok) {
        runFailed = true;
        summary.skipped.push(
          ...selection.selected.map((skippedIssue) => ({
            number: skippedIssue.number,
            reason: `run aborted: ${baseline.reason}`
          }))
        );
      } else {
        const forcePullRequest = selection.selected.length > 1;
        const worktrees: Array<{ issue: GitHubIssue; branch: string; path: string }> = [];
        try {
          for (const issue of selection.selected) {
            assertRunWithinDeadline(runDeadlineAt);
            const worktree = await baseWorkspace.createIssueWorktree(config, issue, runId);
            worktrees.push({ issue, branch: worktree.branch, path: worktree.path });
          }
          const issueResults = await Promise.allSettled(
            worktrees.map((worktree) =>
              processIssueInWorktree({
                issue: worktree.issue,
                config,
                runId,
                runDir,
                project: resolved.project,
                stateDir,
                worktree,
                github,
                requestedAgent: options.agent,
                trigger,
                assumeYes: Boolean(options.assumeYes),
                confirmDirectCommit: options.confirmDirectCommit,
                runCommand,
                runDeadlineAt,
                forcePullRequest
              })
            )
          );
          for (let index = 0; index < issueResults.length; index += 1) {
            const result = issueResults[index];
            if (result.status === 'fulfilled') {
              summary.issues.push(result.value);
              continue;
            }
            const issue = worktrees[index].issue;
            summary.issues.push({
              number: issue.number,
              title: issue.title,
              priority: priorityLabel(issue, config),
              outcome: 'failed',
              reason: String(result.reason)
            });
          }
        } finally {
          for (const worktree of worktrees) {
            await baseWorkspace.removeIssueWorktree(worktree.path);
          }
        }
      }
    }
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.result = runFailed ? 'failed' : resultFor(summary.issues);
    await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await updateLastRun(resolved.slug, summary);
    await lock.release();
  }

  return summary;
}

async function applyIssueIntakeGate(options: {
  selection: RunIssueSelection;
  repo: string;
  runId: string;
  github: GitHubClient;
  openPullRequests: GitHubPullRequest[];
}): Promise<RunIssueSelection> {
  const selected: GitHubIssue[] = [];
  const skipped = [...options.selection.skipped];

  for (const issue of options.selection.selected) {
    const decision = evaluateIssueIntake({
      issue,
      repo: options.repo,
      openPullRequests: options.openPullRequests
    });
    if (decision.status === 'proceed') {
      selected.push(issue);
      continue;
    }

    await recordIntakeSkip({
      issue,
      decision,
      runId: options.runId,
      github: options.github
    });
    skipped.push({ number: issue.number, reason: `intake ${decision.status}: ${decision.reason}` });
  }

  return { selected, skipped, openPullRequests: options.openPullRequests };
}

async function recordIntakeSkip(options: {
  issue: GitHubIssue;
  decision: IssueIntakeDecision;
  runId: string;
  github: GitHubClient;
}): Promise<void> {
  if (
    options.decision.status === 'already_resolved' &&
    hasIssueIntakeDecisionComment(options.issue, options.decision.status)
  ) {
    return;
  }
  await options.github.comment(options.issue.number, buildIssueIntakeComment(options.runId, options.decision));
  if (options.decision.status !== 'already_resolved') {
    await options.github.addLabels(options.issue.number, ['kaizen:needs-human']);
  }
}

function hasPullRequestResultMarker(issue: GitHubIssue): boolean {
  return (issue.comments ?? []).some((comment) =>
    comment.body.includes('kaizen-loop:result') && comment.body.includes('pr-created')
  );
}

function uniqueIssueNumbers(issueNumbers: number[]): number[] {
  return [...new Set(issueNumbers)];
}

function openPullRequestFetchLimit(configuredLimit: number): number {
  return Math.max(configuredLimit + 1, OPEN_PULL_REQUEST_LIMIT_CHECK_FETCH_LIMIT);
}

function assertRunWithinDeadline(deadlineAt: number): void {
  throwIfShutdownRequested();
  if (Date.now() > deadlineAt) throw new Error('Kaizen run timeout exceeded.');
}

function boundedTimeoutMs(configuredTimeoutMs: number, deadlineAt: number): number {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Kaizen run timeout exceeded.');
  return Math.min(configuredTimeoutMs, remainingMs);
}

async function applyOpenPullRequestLimit(options: {
  config: KaizenConfig;
  selection: { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> };
  automatic: boolean;
  openPullRequests: GitHubPullRequest[];
}): Promise<{ selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> }> {
  if (!options.automatic || options.selection.selected.length === 0) return options.selection;
  const limit = options.config.run.maxOpenPullRequests;
  if (limit === 0) {
    return skipSelectedForOpenPrLimit(options.selection, 'open pull request limit reached (0/0)');
  }

  const countedOpenPullRequests = options.openPullRequests.filter((pullRequest) => !isSyncPullRequest(pullRequest));
  const openCount = countedOpenPullRequests.length;
  const remaining = limit - openCount;
  if (remaining <= 0) {
    return skipSelectedForOpenPrLimit(options.selection, `open pull request limit reached (${openCount}/${limit})`);
  }
  if (options.selection.selected.length <= remaining) return options.selection;
  return {
    selected: options.selection.selected.slice(0, remaining),
    skipped: [
      ...options.selection.skipped,
      ...options.selection.selected.slice(remaining).map((issue) => ({
        number: issue.number,
        reason: `open pull request limit would be exceeded (${openCount}/${limit})`
      }))
    ]
  };
}

async function applyGeneratedPullRequestWipLimit(options: {
  config: KaizenConfig;
  selection: { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> };
  automatic: boolean;
  repo: string;
  github: GitHubClient;
}): Promise<{ selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> }> {
  if (!options.automatic || options.selection.selected.length === 0) return options.selection;
  const owner = options.repo.split('/')[0];
  const pullRequests = await options.github.searchOpenPullRequestsForOwner(owner, GENERATED_PULL_REQUEST_FETCH_LIMIT);
  const backlog = summarizeGeneratedPullRequestBacklog({
    pullRequests,
    repo: options.repo,
    wipLimit: options.config.safety.wipLimit
  });
  if (!backlog.exceeded) return options.selection;
  return skipSelectedForOpenPrLimit(options.selection, generatedPullRequestWipLimitReason(backlog));
}

function skipSelectedForOpenPrLimit(
  selection: { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> },
  reason: string
): { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> } {
  return {
    selected: [],
    skipped: [
      ...selection.skipped,
      ...selection.selected.map((issue) => ({ number: issue.number, reason }))
    ]
  };
}

async function prepareBaseWorkspace(options: {
  workspace: WorkspaceManager;
  config: KaizenConfig;
  runId: string;
  runDir: string;
  firstIssue: GitHubIssue;
  github: GitHubClient;
  runDeadlineAt: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  assertRunWithinDeadline(options.runDeadlineAt);
  await assertMinFreeDisk(options.workspace.path, options.config.safety.minFreeDiskMb);
  await options.workspace.ensure();
  assertRunWithinDeadline(options.runDeadlineAt);
  await options.workspace.sync(options.config.git.defaultBranch);
  const setupResult = await options.workspace.runSetup(options.config, options.runDeadlineAt);
  if (setupResult && !setupResult.ok) {
    const issueDir = path.join(options.runDir, `issue-${options.firstIssue.number}`);
    await fs.mkdir(issueDir, { recursive: true });
    const reason = `Baseline setup failed: ${setupResult.command}`;
    await fs.writeFile(path.join(issueDir, 'setup.log'), `# ${setupResult.command}\n${setupResult.output}`);
    await options.github.comment(options.firstIssue.number, buildRunAbortComment(options.runId, reason, [setupResult]));
    return { ok: false, reason };
  }
  const baselineVerify = await options.workspace.runVerify(options.config, options.runDeadlineAt);
  const failedBaseline = baselineVerify.find((item) => !item.ok);
  if (!failedBaseline) {
    assertRunWithinDeadline(options.runDeadlineAt);
    await options.workspace.sync(options.config.git.defaultBranch);
    return { ok: true };
  }

  const issueDir = path.join(options.runDir, `issue-${options.firstIssue.number}`);
  await fs.mkdir(issueDir, { recursive: true });
  const reason = `Baseline verification failed: ${failedBaseline.command}`;
  await fs.writeFile(path.join(issueDir, 'verify.log'), baselineVerify.map((item) => `# ${item.command}\n${item.output}`).join('\n\n'));
  await options.github.comment(options.firstIssue.number, buildRunAbortComment(options.runId, reason, baselineVerify));
  return { ok: false, reason };
}

async function processIssueInWorktree(options: {
  issue: GitHubIssue;
  config: KaizenConfig;
  runId: string;
  runDir: string;
  project: { repo: string; localPath: string; workspacePath: string };
  stateDir: string;
  worktree: { branch: string; path: string };
  github: GitHubClient;
  requestedAgent?: 'claude' | 'codex';
  trigger: RunSummary['trigger'];
  assumeYes: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<DirectCommitChoice>;
  runCommand: CommandRunner;
  runDeadlineAt: number;
  forcePullRequest: boolean;
}): Promise<RunIssueSummary> {
  return await processIssue({
    issue: options.issue,
    config: options.config,
    runId: options.runId,
    runDir: options.runDir,
    project: {
      ...options.project,
      workspacePath: options.worktree.path
    },
    stateDir: options.stateDir,
    github: options.github,
    requestedAgent: options.requestedAgent,
    trigger: options.trigger,
    assumeYes: options.assumeYes,
    confirmDirectCommit: options.confirmDirectCommit,
    runCommand: options.runCommand,
    runDeadlineAt: options.runDeadlineAt,
    branch: options.worktree.branch,
    forcePullRequest: options.forcePullRequest
  });
}

async function processIssue(options: {
  issue: GitHubIssue;
  config: KaizenConfig;
  runId: string;
  runDir: string;
  project: { repo: string; localPath: string; workspacePath: string };
  stateDir: string;
  github: GitHubClient;
  requestedAgent?: 'claude' | 'codex';
  trigger: RunSummary['trigger'];
  assumeYes: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<DirectCommitChoice>;
  runCommand: CommandRunner;
  runDeadlineAt: number;
  branch: string;
  forcePullRequest: boolean;
}): Promise<RunIssueSummary> {
  const started = Date.now();
  const issueDir = path.join(options.runDir, `issue-${options.issue.number}`);
  await fs.mkdir(issueDir, { recursive: true });
  const attempts = countAttempts(options.issue.comments ?? []) + 1;
  const discoveredFollowups: RunDiscoveredFollowupSummary[] = [];
  const preferredBackend = selectPreferredBackend(options.config, options.issue, options.requestedAgent);
  let agent = setupPendingAgent();
  const verifier = options.config.verifier.enabled
    ? new VerifierAgentAdapter(options.runCommand, {
        ...options.config.verifier,
        envAllowlist: options.config.safety.envAllowlist
      })
    : undefined;
  const workspace = new WorkspaceManager(options.runCommand, options.project.workspacePath);

  try {
    assertRunWithinDeadline(options.runDeadlineAt);
    await assertMinFreeDisk(options.project.workspacePath, options.config.safety.minFreeDiskMb);
    await options.github.addLabels(options.issue.number, ['kaizen:in-progress']);
    const setupResult = await workspace.runSetup(options.config, options.runDeadlineAt);
    if (setupResult && !setupResult.ok) {
      const reason = `Setup failed: ${setupResult.command}`;
      await fs.writeFile(path.join(issueDir, 'setup.log'), `# ${setupResult.command}\n${setupResult.output}`);
      return withDiscoveredFollowups(await finishFailed(options, agent, attempts, reason, started, [setupResult]), discoveredFollowups);
    }
    agent = await selectAgent(options.config, options.runCommand);
    const branch = options.branch;

    let agentResult: AgentResult | undefined;
    let verifierResult: VerifierResult | undefined;
    let verifyResults: Array<{ command: string; ok: boolean; output: string }> = [];
    let previousFailure: string | undefined;
    const filedDiscoveredIssues = new Set<string>();

    for (let retry = 0; retry <= options.config.run.maxVerifyRetries; retry += 1) {
      const prompt = buildFixPrompt({
        repo: options.project.repo,
        issue: options.issue,
        config: options.config,
        attempt: attempts,
        previousFailure
      });
      agentResult = await agent.run({
        workspaceDir: options.project.workspacePath,
        prompt,
        timeoutMs: boundedTimeoutMs(options.config.run.issueTimeoutMinutes * 60_000, options.runDeadlineAt),
        model: modelFor(options.config, preferredBackend),
        preferredBackend
      });
      await fs.appendFile(path.join(issueDir, 'agent.log'), `\n# Agent attempt ${retry + 1}\n${agentResult.raw}\n`);
      discoveredFollowups.push(
        ...await fileDiscoveredIssues({
          sourceIssue: options.issue,
          projectRepo: options.project.repo,
          github: options.github,
          runId: options.runId,
          issueDir,
          discoveredIssues: agentResult.discoveredIssues,
          filedKeys: filedDiscoveredIssues
        })
      );

      if (agentResult.status === 'blocked') {
        return withDiscoveredFollowups(await finishBlocked(options, agent, attempts, agentResult, started), discoveredFollowups);
      }
      if (agentResult.status === 'error' || agentResult.status === 'timeout') {
        return withDiscoveredFollowups(await finishFailed(options, agent, attempts, agentResult.summary, started), discoveredFollowups);
      }

      await commitLeftovers(workspace, options.issue, agentResult);
      const diff = await workspace.collectDiffStats(options.config);
      if (diff.changedFiles === 0) {
        return withDiscoveredFollowups(await finishFailed(options, agent, attempts, 'Agent produced no changes.', started), discoveredFollowups);
      }
      if (diff.forbiddenFiles.length > 0) {
        return withDiscoveredFollowups(
          await finishFailed(options, agent, attempts, `Forbidden paths changed: ${diff.forbiddenFiles.join(', ')}`, started),
          discoveredFollowups
        );
      }

      verifyResults = await workspace.runVerify(options.config, options.runDeadlineAt);
      await fs.writeFile(path.join(issueDir, 'verify.log'), verifyResults.map((item) => `# ${item.command}\n${item.output}`).join('\n\n'));
      const failedVerify = verifyResults.find((item) => !item.ok);
      if (failedVerify) {
        if (retry >= options.config.run.maxVerifyRetries) {
          return withDiscoveredFollowups(
            await finishFailed(options, agent, attempts, `Verification failed: ${failedVerify.command}`, started, verifyResults),
            discoveredFollowups
          );
        }
        previousFailure = `Verification failed: ${failedVerify.command}\n\n${tailLines(failedVerify.output, 200)}`;
        continue;
      }

      if (!verifier) break;

      const verifierDiff = await workspace.collectDiffStats(options.config);
      const verifierDiffText = await workspace.collectDiffText(options.config);
      verifierResult = await verifier.run({
        workspaceDir: options.project.workspacePath,
        timeoutMs: boundedTimeoutMs(options.config.verifier.timeoutMinutes * 60_000, options.runDeadlineAt),
        prompt: buildVerifierPrompt({
          repo: options.project.repo,
          issue: options.issue,
          agentResult,
          verifyResults,
          diff: verifierDiff,
          diffText: verifierDiffText
        })
      });
      await fs.appendFile(path.join(issueDir, 'verifier.log'), `\n# Verifier attempt ${retry + 1}\n${verifierResult.raw}\n`);

      if (verifierResult.status === 'open_pr' || verifierResult.status === 'open_pr_with_warning') break;
      if (verifierResult.status === 'error' || verifierResult.status === 'timeout') {
        return withDiscoveredFollowups(
          await finishFailed(options, agent, attempts, `Verifier failed: ${verifierResult.summary}`, started, verifyResults),
          discoveredFollowups
        );
      }
      if (retry >= options.config.run.maxVerifyRetries) {
        return withDiscoveredFollowups(
          await finishFailed(options, agent, attempts, verifierBlockedReason(verifierResult), started, verifyResults),
          discoveredFollowups
        );
      }
      previousFailure = `${verifierBlockedReason(verifierResult)}\n\n${verifierResult.notes || verifierResult.raw}`;
    }

    if (!agentResult) {
      return withDiscoveredFollowups(await finishFailed(options, agent, attempts, 'Agent did not produce a result.', started), discoveredFollowups);
    }

    await commitLeftovers(workspace, options.issue, agentResult);
    const diff = await workspace.collectDiffStats(options.config);
    if (diff.changedFiles === 0) {
      return withDiscoveredFollowups(await finishFailed(options, agent, attempts, 'Agent produced no changes.', started), discoveredFollowups);
    }
    if (diff.forbiddenFiles.length > 0) {
      return withDiscoveredFollowups(
        await finishFailed(options, agent, attempts, `Forbidden paths changed: ${diff.forbiddenFiles.join(', ')}`, started),
        discoveredFollowups
      );
    }
    await commitLeftovers(workspace, options.issue, agentResult);
    const finalDiff = await workspace.collectDiffStats(options.config);
    if (finalDiff.forbiddenFiles.length > 0) {
      return withDiscoveredFollowups(
        await finishFailed(options, agent, attempts, `Forbidden paths changed: ${finalDiff.forbiddenFiles.join(', ')}`, started, verifyResults),
        discoveredFollowups
      );
    }

    if (verifierResult?.status === 'open_pr' || verifierResult?.status === 'open_pr_with_warning') {
      const pr = await reflectPullRequest({
        workspace,
        branch,
        issue: options.issue,
        config: options.config,
        agentResult,
        verifyResults,
        diff: finalDiff,
        github: options.github,
        runId: options.runId,
        trigger: options.trigger,
        attempt: attempts,
        reason: verifierPrReason(verifierResult),
        verifierResult
      });
      return withDiscoveredFollowups(await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started), discoveredFollowups);
    }

    const decision = decideReflection({
      config: options.config,
      labels: labelNames(options.issue),
      diff: finalDiff,
      verifyConfigured: options.config.commands.verify.length > 0
    });
    if (decision.action === 'direct' && options.forcePullRequest) {
      const pr = await reflectPullRequest({
        workspace,
        branch,
        issue: options.issue,
        config: options.config,
        agentResult,
        verifyResults,
        diff: finalDiff,
        github: options.github,
        runId: options.runId,
        trigger: options.trigger,
        attempt: attempts,
        reason: `Parallel issue run requires PR isolation: ${decision.reason}`
      });
      return withDiscoveredFollowups(await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started), discoveredFollowups);
    }

    if (decision.action === 'direct') {
      const directChoice = await resolveDirectCommitChoice({
        issue: options.issue,
        config: options.config,
        trigger: options.trigger,
        assumeYes: options.assumeYes,
        confirmDirectCommit: options.confirmDirectCommit,
        decision,
        diff: finalDiff,
        verifyResults
      });
      if (directChoice === 'reject') {
        return withDiscoveredFollowups(
          await finishFailed(options, agent, attempts, `Direct commit rejected: ${decision.reason}`, started, verifyResults),
          discoveredFollowups
        );
      }
      if (directChoice === 'pr') {
        const pr = await reflectPullRequest({
          workspace,
          branch,
          issue: options.issue,
          config: options.config,
          agentResult,
          verifyResults,
          diff: finalDiff,
          github: options.github,
          runId: options.runId,
          trigger: options.trigger,
          attempt: attempts,
          reason: `Instant direct commit switched to PR: ${decision.reason}`
        });
        return withDiscoveredFollowups(await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started), discoveredFollowups);
      }
      const direct = await reflectDirect({
        workspace,
        branch,
        issue: options.issue,
        config: options.config,
        agentResult,
        verifyResults,
        diff: finalDiff,
        decision
      }).catch(async (error) => {
        await preparePrFallback(workspace, branch);
        return reflectPullRequest({
          workspace,
          branch,
          issue: options.issue,
          config: options.config,
          agentResult,
          verifyResults,
          diff: finalDiff,
          github: options.github,
          runId: options.runId,
          trigger: options.trigger,
          attempt: attempts,
          reason: `Direct commit fallback to PR: ${String(error)}`
        });
      });
      if ('commit' in direct) {
        await options.github.comment(
          options.issue.number,
          buildResultComment({
            runId: options.runId,
            issue: options.issue.number,
            attempt: attempts,
            outcome: 'direct-commit',
            agent: agent.name,
            summary: agentSummary(agentResult),
            notes: agentResult.notes,
            verifyResults,
            commit: direct.commit,
            reason: decision.reason,
            trigger: options.trigger,
            maxAttempts: options.config.run.maxAttemptsPerIssue
          })
        );
        await options.github.closeIssue(options.issue.number);
        await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
        return withDiscoveredFollowups({
          number: options.issue.number,
          title: options.issue.title,
          priority: priorityLabel(options.issue, options.config),
          agent: agent.name,
          attempt: attempts,
          outcome: 'direct-commit',
          branch,
          commit: direct.commit,
          reason: decision.reason,
          changedFiles: finalDiff.changedFiles,
          changedLines: finalDiff.changedLines,
          verifyRetries: Math.max(0, verifyResults.filter((result) => !result.ok).length),
          durationMs: Date.now() - started
        }, discoveredFollowups);
      }
      return withDiscoveredFollowups(await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, direct, started), discoveredFollowups);
    }

    const pr = await reflectPullRequest({
      workspace,
      branch,
      issue: options.issue,
      config: options.config,
      agentResult,
      verifyResults,
      diff: finalDiff,
      github: options.github,
      runId: options.runId,
      trigger: options.trigger,
      attempt: attempts,
      reason: decision.reason
    });
    return withDiscoveredFollowups(await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started), discoveredFollowups);
  } catch (error) {
    return withDiscoveredFollowups(await finishFailed(options, agent, attempts, String(error), started), discoveredFollowups);
  }
}

async function finishPr(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    runId: string;
    github: GitHubClient;
    trigger: RunSummary['trigger'];
    project: { repo: string; workspacePath: string };
    stateDir: string;
    runCommand: CommandRunner;
    runDeadlineAt: number;
  },
  agent: AgentAdapter,
  attempts: number,
  agentResult: AgentResult,
  verifyResults: Array<{ command: string; ok: boolean; output: string }>,
  finalDiff: DiffStats,
  pr: PullRequestReflection,
  started: number
): Promise<RunIssueSummary> {
  await options.github.comment(
    options.issue.number,
    buildPrProgressComment({
      runId: options.runId,
      issue: options.issue.number,
      attempt: attempts,
      prUrl: pr.url,
      trigger: options.trigger
    })
  );
  const guardian = await runPrGuardianAfterPullRequest({
    issue: options.issue,
    config: options.config,
    project: options.project,
    stateDir: options.stateDir,
    github: options.github,
    runCommand: options.runCommand,
    runDeadlineAt: options.runDeadlineAt,
    pr
  });
  const guardianFailed = guardian.status === 'failed';
  const reason = guardianFailed ? `${pr.reason}\n\nPR guardian failed: ${guardian.summary}` : `${pr.reason}\n\nPR guardian: ${guardian.summary}`;
  await options.github.comment(
    options.issue.number,
    buildResultComment({
      runId: options.runId,
      issue: options.issue.number,
      attempt: attempts,
      outcome: 'pr-created',
      agent: agent.name,
      summary: agentSummary(agentResult),
      notes: withGuardianNotes(agentResult.notes, guardian),
      verifyResults,
      prUrl: pr.url,
      reason,
      trigger: options.trigger,
      maxAttempts: options.config.run.maxAttemptsPerIssue
    })
  );
  if (guardianFailed) {
    await options.github.addLabels(options.issue.number, ['kaizen:needs-human']);
  }
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);

  return {
    number: options.issue.number,
    title: options.issue.title,
    priority: priorityLabel(options.issue, options.config),
    agent: agent.name,
    attempt: attempts,
    outcome: 'pr-created',
    branch: pr.branch,
    pr: pr.number,
    prUrl: pr.url,
    guardian: {
      status: guardian.status,
      summary: guardian.summary,
      jobId: guardian.jobId
    },
    reason,
    changedFiles: finalDiff.changedFiles,
    changedLines: finalDiff.changedLines,
    verifyRetries: 0,
    durationMs: Date.now() - started
  };
}

async function selectAgent(config: KaizenConfig, runCommand: CommandRunner): Promise<AgentAdapter> {
  const agent = new BuilderAgentAdapter(runCommand, {
    ...config.builder,
    envAllowlist: config.safety.envAllowlist
  });
  await agent.isAvailable();
  return agent;
}

function setupPendingAgent(): AgentAdapter {
  return {
    name: 'builder',
    async isAvailable() {
      return true;
    },
    async run() {
      throw new Error('Agent unavailable before setup completed.');
    }
  };
}

function selectPreferredBackend(config: KaizenConfig, issue: GitHubIssue, requested: 'claude' | 'codex' | undefined): 'claude' | 'codex' {
  const labels = labelNames(issue);
  return labels.includes('kaizen:agent:codex')
    ? 'codex'
    : labels.includes('kaizen:agent:claude')
      ? 'claude'
      : requested ?? config.agent.default;
}

async function commitLeftovers(workspace: WorkspaceManager, issue: GitHubIssue, agentResult: AgentResult): Promise<void> {
  const git = workspace.git();
  const status = await git.statusPorcelain();
  if (!status.trim()) return;
  await git.addAll();
  await git.commit(`kaizen: ${shortSummary(agentResult.summary || issue.title)} (#${issue.number})`);
}

async function finishBlocked(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    runId: string;
    github: GitHubClient;
    trigger: RunSummary['trigger'];
  },
  agent: AgentAdapter,
  attempt: number,
  agentResult: AgentResult,
  started: number
): Promise<RunIssueSummary> {
  const requiresHuman = requiresHumanForBlockedAgent(agentResult);
  await options.github.comment(
    options.issue.number,
    buildResultComment({
      runId: options.runId,
      issue: options.issue.number,
      attempt,
      outcome: 'blocked',
      agent: agent.name,
      summary: agentSummary(agentResult),
      notes: agentResult.notes,
      reason: agentResult.blockedReason ?? agentResult.summary,
      trigger: options.trigger,
      maxAttempts: options.config.run.maxAttemptsPerIssue,
      requiresHuman
    })
  );
  if (requiresHuman) {
    await options.github.addLabels(options.issue.number, ['kaizen:needs-human']);
  }
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
  return {
    number: options.issue.number,
    title: options.issue.title,
    agent: agent.name,
    attempt,
    outcome: 'blocked',
    reason: agentResult.blockedReason ?? agentResult.summary,
    durationMs: Date.now() - started
  };
}

export function requiresHumanForBlockedAgent(agentResult: AgentResult): boolean {
  const text = `${agentResult.blockedReason ?? ''}\n${agentResult.notes}\n${agentResult.raw}`;
  if (isProviderCapacityBlock(text)) return false;
  return true;
}

function isProviderCapacityBlock(text: string): boolean {
  return [
    /\bfailureclass\s*[:=]\s*(timeout|rate_limited|rate limited)\b/i,
    /\bfallbackreason\s*[:=]\s*(timeout|rate_limited|rate limited)\b/i,
    /\bapi_error_status["']?\s*[:=]\s*429\b/i,
    /\b(?:http|status)\s*[:=]\s*429\b/i,
    /\bagent command timed out after \d+ms\b/i,
    /["']result["']\s*:\s*["'][^"']*session limit/i
  ].some((pattern) => pattern.test(text));
}

async function finishFailed(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    runId: string;
    github: GitHubClient;
    trigger: RunSummary['trigger'];
  },
  agent: AgentAdapter,
  attempt: number,
  reason: string,
  started: number,
  verifyResults?: Array<{ command: string; ok: boolean; output: string }>
): Promise<RunIssueSummary> {
  await options.github.comment(
    options.issue.number,
    buildResultComment({
      runId: options.runId,
      issue: options.issue.number,
      attempt,
      outcome: 'failed',
      agent: agent.name,
      summary: reason,
      verifyResults,
      reason,
      trigger: options.trigger,
      maxAttempts: options.config.run.maxAttemptsPerIssue
    })
  );
  if (attempt >= options.config.run.maxAttemptsPerIssue) {
    await options.github.addLabels(options.issue.number, ['kaizen:needs-human']);
  }
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
  return {
    number: options.issue.number,
    title: options.issue.title,
    agent: agent.name,
    attempt,
    outcome: 'failed',
    reason,
    durationMs: Date.now() - started
  };
}

async function resolveDirectCommitChoice(options: {
  issue: GitHubIssue;
  config: KaizenConfig;
  trigger: RunSummary['trigger'];
  assumeYes: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<DirectCommitChoice>;
  decision: ReflectionDecision;
  diff: DiffStats;
  verifyResults: Array<{ command: string; ok: boolean; output: string }>;
}): Promise<DirectCommitChoice> {
  if (options.trigger !== 'instant' && options.trigger !== 'watch') return 'direct';
  if (options.assumeYes) return 'direct';
  if (options.confirmDirectCommit) {
    return options.confirmDirectCommit({
      issue: options.issue,
      decision: options.decision,
      diff: options.diff,
      verifyResults: options.verifyResults
    });
  }
  return options.config.instant.unattendedMode === 'direct' ? 'direct' : options.config.instant.unattendedMode;
}

function buildPullRequestBody(
  issue: GitHubIssue,
  agentResult: AgentResult,
  verifyResults: Array<{ command: string; ok: boolean }>,
  diff: DiffStats,
  riskReason: string,
  verifierResult?: VerifierResult
): string {
  const verify = verifyResults.length
    ? verifyResults.map((result) => `- ${result.ok ? '[x]' : '[ ]'} \`${result.command}\``).join('\n')
    : '- Verification commands are not configured';
  const notes = agentResult.notes.trim() ? `\n## Builder notes\n${agentResult.notes.trim()}\n` : '';
  const verifier = verifierResult ? `\n## Verifier\n${verifierPrBodyLines(verifierResult).join('\n')}\n` : '';
  const evidence = [
    '- reported: builder summary and builder notes come from the builder-agent self-report.',
    verifyResults.length > 0
      ? '- executed: Kaizen Loop ran the verification commands listed above.'
      : '- unverified: no repository verification commands are configured.',
    verifierEvidenceStrength(verifierResult),
    '- static: changed file and line counts come from git diff metadata.'
  ].join('\n');
  return `Closes #${issue.number}

## Summary
${agentResult.summary}
${notes}

## Verification
${verify}
${verifier}

## Evidence strength
${evidence}

## Kaizen risk policy
${riskReason}

Changed files: ${diff.changedFiles}
Changed lines: ${diff.changedLines}
`;
}

function verifierPrBodyLines(verifierResult: VerifierResult): string[] {
  const lines = [
    `verifier: ${verifierResult.status}`,
    `summary: ${verifierResult.summary || '(none)'}`,
    `evidence: ${formatVerifierEvidenceGrade(verifierResult)}`
  ];
  if (verifierResult.reason) lines.push(`reason: ${verifierResult.reason}`);
  if (verifierResult.notes.trim()) lines.push(`notes: ${verifierResult.notes.trim()}`);
  if (verifierResult.evidenceGrade === 'reported') {
    lines.push('warning: この判定は実行証拠ではなくテキスト報告に基づくため、未実行の可能性があります。');
  }
  return lines;
}

function formatVerifierEvidenceGrade(verifierResult: VerifierResult): string {
  if (verifierResult.evidenceGrade === 'reported') return 'reported (未実行の可能性あり)';
  if (verifierResult.evidenceGrade === 'executed') return 'executed';
  return 'unknown';
}

function verifierEvidenceStrength(verifierResult?: VerifierResult): string {
  if (!verifierResult) return '- unverified: verifier was not run for this PR body.';
  if (verifierResult.evidenceGrade === 'executed') {
    return '- executed: Kaizen Loop ran verifier and verifier reported executed evidence.';
  }
  if (verifierResult.evidenceGrade === 'reported') {
    return '- reported: Kaizen Loop ran verifier, but verifier evidence is based on text reporting rather than execution proof.';
  }
  return '- unverified: Kaizen Loop ran verifier, but verifier did not report an evidence grade.';
}

function buildRunAbortComment(
  runId: string,
  reason: string,
  verifyResults: Array<{ command: string; ok: boolean; output: string }>
): string {
  const verify = verifyResults.length
    ? verifyResults.map((result) => `- ${result.ok ? '[x]' : '[ ]'} \`${result.command}\``).join('\n')
    : '- Baseline commands are not configured';

  return `## Kaizen Loop run aborted

The run stopped before agent execution because a baseline setup or verification command failed on the clean default branch.
This is treated as an environment or existing-repository failure, not as an Issue attempt.

| | |
|---|---|
| Run | ${runId} |
| Reason | ${reason} |

## Baseline checks
${verify}`;
}

async function preparePrFallback(workspace: WorkspaceManager, branch: string): Promise<void> {
  const git = workspace.git();
  await git.abortRebase();
  await git.checkout(branch);
}

async function reflectDirect(options: {
  workspace: WorkspaceManager;
  branch: string;
  issue: GitHubIssue;
  config: KaizenConfig;
  agentResult: AgentResult;
  verifyResults: Array<{ command: string; ok: boolean; output: string }>;
  diff: DiffStats;
  decision: ReflectionDecision;
}): Promise<{ commit: string }> {
  const git = options.workspace.git();
  await git.fetch();
  await git.checkout(options.branch);
  await git.rebase(`origin/${options.config.git.defaultBranch}`);
  const verifyResults = await options.workspace.runVerify(options.config);
  const failedVerify = verifyResults.find((result) => !result.ok);
  if (failedVerify) throw new Error(`post-rebase verification failed: ${failedVerify.command}`);
  await commitLeftovers(options.workspace, options.issue, options.agentResult);
  await git.checkout(options.config.git.defaultBranch, { ignoreOtherWorktrees: true });
  await git.resetHard(`origin/${options.config.git.defaultBranch}`);
  await git.mergeFfOnly(options.branch);
  const commit = await git.revParse('HEAD');
  await git.push(options.config.git.defaultBranch);
  return { commit };
}

async function reflectPullRequest(options: {
  workspace: WorkspaceManager;
  branch: string;
  issue: GitHubIssue;
  config: KaizenConfig;
  agentResult: AgentResult;
  verifyResults: Array<{ command: string; ok: boolean; output: string }>;
  diff: DiffStats;
  github: GitHubClient;
  runId: string;
  trigger: RunSummary['trigger'];
  attempt: number;
  reason: string;
  verifierResult?: VerifierResult;
}): Promise<PullRequestReflection> {
  await options.workspace.git().push(options.branch, { forceWithLease: true });
  const headSha = await options.workspace.git().revParse('HEAD');
  try {
    const pr = await options.github.createPullRequest({
      base: options.config.git.defaultBranch,
      head: options.branch,
      title: `kaizen: ${shortSummary(options.agentResult.summary)} (#${options.issue.number})`,
      body: buildPullRequestBody(options.issue, options.agentResult, options.verifyResults, options.diff, options.reason, options.verifierResult),
      expectedClosingIssueNumber: options.issue.number
    });
    return { ...pr, reason: options.reason, branch: options.branch, baseBranch: options.config.git.defaultBranch, headSha };
  } catch (error) {
    if (error instanceof CreatedPullRequestValidationError) {
      await options.github.comment(
        options.issue.number,
        buildPrProgressComment({
          runId: options.runId,
          issue: options.issue.number,
          attempt: options.attempt,
          prUrl: error.pr.url,
          trigger: options.trigger
        })
      );
    }
    throw error;
  }
}

async function runPrGuardianAfterPullRequest(options: {
  issue: GitHubIssue;
  config: KaizenConfig;
  project: { repo: string; workspacePath: string };
  stateDir: string;
  github: GitHubClient;
  runCommand: CommandRunner;
  pr: { url: string; number?: number; branch: string; baseBranch: string; headSha: string };
  runDeadlineAt: number;
}): Promise<PrGuardianSkillResult> {
  if (!options.pr.number) {
    return {
      status: 'skipped',
      summary: 'PR number could not be parsed; skipped mergeability monitoring.',
      raw: '',
      durationMs: 0
    };
  }

  if (options.config.guardian.mode === 'async') {
    const job = await enqueuePrGuardianJob({
      stateDir: options.stateDir,
      config: options.config,
      repo: options.project.repo,
      prUrl: options.pr.url,
      prNumber: options.pr.number,
      branch: options.pr.branch,
      baseBranch: options.pr.baseBranch,
      headSha: options.pr.headSha
    });
    return {
      status: 'queued',
      summary: `PR guardian job ${job.id} is ${job.status}.`,
      raw: '',
      durationMs: 0,
      jobId: job.id
    };
  }

  const result = await runPrGuardianSkill(options.runCommand, {
    config: options.config,
    workspaceDir: options.project.workspacePath,
    repo: options.project.repo,
    prUrl: options.pr.url,
    prNumber: options.pr.number,
    branch: options.pr.branch,
    baseBranch: options.pr.baseBranch,
    runDeadlineAt: options.runDeadlineAt
  });
  return result;
}

function withGuardianNotes(notes: string | undefined, guardian: PrGuardianSkillResult): string {
  const base = notes?.trim() ?? '';
  const guardianNotes = `PR guardian: ${guardian.status} - ${guardian.summary}`;
  return base ? `${base}\n\n${guardianNotes}` : guardianNotes;
}

function verifierPrReason(result: VerifierResult): string {
  const detail = result.reason || result.summary;
  return result.status === 'open_pr_with_warning'
    ? `Verifier cleared PR with warning: ${detail}`
    : `Verifier cleared PR: ${detail}`;
}

function verifierBlockedReason(result: VerifierResult): string {
  const detail = result.reason || result.summary;
  return result.status === 'needs_context'
    ? `Verifier needs context: ${detail}`
    : `Verifier blocked PR: ${detail}`;
}

function withDiscoveredFollowups(
  summary: RunIssueSummary,
  discoveredFollowups: RunDiscoveredFollowupSummary[]
): RunIssueSummary {
  if (discoveredFollowups.length === 0) return summary;
  return {
    ...summary,
    discoveredFollowups: [...discoveredFollowups]
  };
}

async function fileDiscoveredIssues(options: {
  sourceIssue: GitHubIssue;
  projectRepo: string;
  github: GitHubClient;
  runId: string;
  issueDir: string;
  discoveredIssues: DiscoveredIssue[];
  filedKeys: Set<string>;
}): Promise<RunDiscoveredFollowupSummary[]> {
  const filed: RunDiscoveredFollowupSummary[] = [];
  const registry = await loadRegistry();

  for (const issue of options.discoveredIssues) {
    const routing = resolveDiscoveredIssueRepo({
      issue,
      fallbackRepo: options.projectRepo,
      registry
    });
    const repo = routing.repo;
    const key = `${repo}\n${issue.title.trim().toLowerCase()}`;
    if (options.filedKeys.has(key)) continue;

    try {
      const existing = await options.github.findOpenIssueByTitle({
        repo,
        title: issue.title,
        body: [issue.body, issue.expected, issue.evidence].filter(Boolean).join('\n\n')
      });
      if (existing) {
        filed.push({ title: issue.title, repo, status: 'duplicate', url: existing.url });
        options.filedKeys.add(key);
        continue;
      }
      const created = await options.github.createIssue({
        repo,
        title: issue.title,
        body: buildDiscoveredIssueBody({
          issue,
          repo,
          routingReason: routing.reason,
          sourceIssue: options.sourceIssue,
          sourceRepo: options.projectRepo,
          runId: options.runId
        }),
        labels: labelsForDiscoveredIssue(issue)
      });
      filed.push({ title: issue.title, repo, status: 'created', url: created.url });
      options.filedKeys.add(key);
    } catch (error) {
      await fs.appendFile(
        path.join(options.issueDir, 'discovered-issues.log'),
        `Failed to file discovered issue "${issue.title}" in ${repo}: ${String(error)}\n`
      );
    }
  }

  if (filed.length === 0) return filed;

  try {
    await options.github.comment(
      options.sourceIssue.number,
      `## Kaizen discovered follow-up issue${filed.length === 1 ? '' : 's'}

${filed.map((item) => `- ${item.status === 'duplicate' ? 'Existing' : 'Created'} in \`${item.repo}\`: ${item.url ?? item.title}`).join('\n')}

These were reported by the builder agent as separate bugs and filed by kaizen-loop.`
    );
  } catch (error) {
    await fs.appendFile(
      path.join(options.issueDir, 'discovered-issues.log'),
      `Failed to comment about discovered issue filing on source issue #${options.sourceIssue.number}: ${String(error)}\n`
    );
  }

  return filed;
}

function buildDiscoveredIssueBody(options: {
  issue: DiscoveredIssue;
  repo: string;
  routingReason: string;
  sourceIssue: GitHubIssue;
  sourceRepo: string;
  runId: string;
}): string {
  const body = options.issue.body?.trim() || 'A separate bug was discovered while processing a Kaizen issue.';
  const evidence = options.issue.evidence?.trim() || 'No additional evidence was provided by the builder agent.';
  const expected = options.issue.expected?.trim() || 'The behavior should be investigated and corrected.';

  return `## Bug
${body}

## Evidence
${evidence}

## Expected
${expected}

## Routing
Filed in \`${options.repo}\` ${options.routingReason} while processing \`${options.sourceRepo}#${options.sourceIssue.number}\`.

## Notes
- Source issue: ${options.sourceIssue.url ?? `${options.sourceRepo}#${options.sourceIssue.number}`}
- Source title: ${options.sourceIssue.title}
- Kaizen run: ${options.runId}
${options.issue.severity ? `- Reported severity: ${options.issue.severity}` : ''}`;
}

function resolveDiscoveredIssueRepo(options: {
  issue: DiscoveredIssue;
  fallbackRepo: string;
  registry: Registry;
}): { repo: string; reason: string } {
  const reported = resolveReportedDiscoveredIssueRepo(options.issue.repo, options.fallbackRepo);
  const inferred = inferRegisteredRepoFromIssueText(options.issue, options.registry, {
    reportedRepo: reported,
    fallbackRepo: options.fallbackRepo,
    hasReportedRepo: Boolean(options.issue.repo?.trim())
  });
  if (inferred) {
    return {
      repo: inferred.repo,
      reason: 'because the evidence matched a registered project path for this repository'
    };
  }

  if (options.issue.repo?.trim()) {
    return {
      repo: reported,
      reason: `because the builder agent reported this target`
    };
  }
  return {
    repo: reported,
    reason: `because the builder agent did not report a target repository`
  };
}

function resolveReportedDiscoveredIssueRepo(repo: string | undefined, fallbackRepo: string): string {
  if (!repo?.trim()) return fallbackRepo;
  const normalized = repo.trim();
  if (normalized.includes('/')) return normalized;
  const key = normalized.toLowerCase();
  const aliases: Record<string, string> = {
    'kaizen-loop': 'kaizen-agents-org/kaizen-loop',
    'builder-agent': 'kaizen-agents-org/builder-agent',
    verifier: 'kaizen-agents-org/verifier',
    '.github': 'kaizen-agents-org/.github',
    github: 'kaizen-agents-org/.github',
    coderabbit: 'kaizen-agents-org/coderabbit',
    'renovate-config': 'kaizen-agents-org/renovate-config',
    renovate: 'kaizen-agents-org/renovate-config'
  };
  return aliases[key] ?? fallbackRepo;
}

function inferRegisteredRepoFromIssueText(
  issue: DiscoveredIssue,
  registry: Registry,
  options: {
    reportedRepo: string;
    fallbackRepo: string;
    hasReportedRepo: boolean;
  }
): { repo: string; path: string } | undefined {
  const text = [
    issue.title,
    issue.body,
    issue.expected,
    issue.evidence
  ].filter(Boolean).join('\n');
  if (!text) return undefined;

  const projects = Object.values(registry.projects);
  if (options.hasReportedRepo && options.reportedRepo !== options.fallbackRepo) {
    return findRegisteredPathMatch(text, projects.filter((project) => project.repo === options.reportedRepo));
  }

  return findRegisteredPathMatch(text, projects.filter((project) => project.repo !== options.fallbackRepo))
    ?? findRegisteredPathMatch(text, projects.filter((project) => project.repo === options.fallbackRepo));
}

function findRegisteredPathMatch(
  text: string,
  projects: Array<{ repo: string; localPath: string; workspacePath: string }>
): { repo: string; path: string } | undefined {
  return projects
    .flatMap((project) => projectPaths(project.localPath, project.workspacePath).map((item) => ({ repo: project.repo, path: item })))
    .filter((item) => item.path.length > 1)
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => containsPathCandidate(text, item.path));
}

function containsPathCandidate(text: string, candidatePath: string): boolean {
  let start = 0;
  while (start < text.length) {
    const index = text.indexOf(candidatePath, start);
    if (index === -1) return false;
    const before = index === 0 ? undefined : text[index - 1];
    const after = text[index + candidatePath.length];
    if (isPathTextBoundary(before) && isPathTextBoundary(after)) return true;
    start = index + candidatePath.length;
  }
  return false;
}

function isPathTextBoundary(char: string | undefined): boolean {
  return char === undefined || char === '/' || char === '\\' || !/[A-Za-z0-9._-]/.test(char);
}

function projectPaths(localPath: string, workspacePath: string): string[] {
  const resolvedWorkspace = path.resolve(workspacePath);
  return [
    path.resolve(localPath),
    resolvedWorkspace,
    path.join(path.dirname(resolvedWorkspace), `${path.basename(resolvedWorkspace)}-worktrees`)
  ];
}

function labelsForDiscoveredIssue(issue: DiscoveredIssue): string[] {
  const labels = new Set(['kaizen']);
  const severity = issue.severity?.trim().toUpperCase();
  if (severity && /^P[0-2]$/.test(severity)) labels.add(`kaizen:${severity}`);
  for (const label of issue.labels ?? []) {
    const trimmed = label.trim();
    if (trimmed === 'kaizen' || /^kaizen:P[0-2]$/i.test(trimmed)) labels.add(trimmed.replace(/:p/i, ':P'));
  }
  return [...labels];
}

function modelFor(config: KaizenConfig, agent: 'claude' | 'codex'): string | null | undefined {
  return config.agent.model[agent];
}

function shortSummary(summary: string): string {
  return (summary || 'fix issue').split('\n')[0].slice(0, 80);
}

function resultFor(issues: RunIssueSummary[]): RunSummary['result'] {
  if (issues.length === 0) return 'success';
  if (issues.every((issue) => issue.outcome === 'pr-created' || issue.outcome === 'direct-commit')) return 'success';
  if (issues.some((issue) => issue.outcome === 'pr-created' || issue.outcome === 'direct-commit')) return 'partial';
  return 'failed';
}

async function persistRunSummary(slug: string, summary: RunSummary): Promise<RunSummary> {
  const runDir = path.join(projectStateDir(slug), 'runs', toRunId(new Date(summary.startedAt)));
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await updateLastRun(slug, summary);
  return summary;
}

async function updateLastRun(slug: string, summary: RunSummary): Promise<void> {
  const registry = await loadRegistry();
  const project = registry.projects[slug];
  if (!project) return;
  project.lastRun = {
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    result: summary.result,
    processed: summary.issues.length,
    fixed: summary.issues.filter((issue) => issue.outcome === 'direct-commit' || issue.outcome === 'pr-created').length,
    prCreated: summary.issues.filter((issue) => issue.outcome === 'pr-created').length,
    failed: summary.issues.filter((issue) => issue.outcome === 'failed').length
  };
  await saveRegistry(registry);
}

async function ensureNotPaused(stateDir: string): Promise<void> {
  try {
    await fs.access(path.join(stateDir, 'PAUSE'));
    throw new ConfigError(`Project is paused: ${path.join(stateDir, 'PAUSE')}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
