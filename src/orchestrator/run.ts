import fs from 'node:fs/promises';
import path from 'node:path';
import { BuilderAgentAdapter } from '../agents/builder.js';
import { VerifierAgentAdapter, type VerifierResult } from '../agents/verifier.js';
import type { AgentAdapter, AgentResult, DiscoveredIssue } from '../agents/types.js';
import { buildFixPrompt, buildVerifierPrompt } from '../agents/prompt.js';
import { loadConfig } from '../config/config.js';
import { loadOperationalConfig } from '../config/operational.js';
import { loadRegistry, resolveProject } from '../config/registry.js';
import type { KaizenConfig, Registry } from '../config/schema.js';
import { buildDiscoveredIssueFingerprint, parseFailureClass } from '../discovered-issue-fingerprint.js';
import { CreatedPullRequestValidationError, GitHubClient } from '../github/client.js';
import type { GitHubIssue, GitHubPullRequest, GitHubPullRequestDetails, PullRequestResult } from '../github/types.js';
import {
  agentSummary,
  buildPrProgressComment,
  buildResultComment,
  countAttempts,
  countConsecutiveRetryableBlocks,
  markedPullRequestNumbers
} from '../report/comments.js';
import { throwIfShutdownRequested, withRunDeadline, type CommandRunner } from '../utils/command.js';
import { assertMinFreeDisk } from '../utils/disk.js';
import { ConfigError } from '../utils/errors.js';
import { projectStateDir } from '../utils/paths.js';
import { toRunId } from '../utils/runId.js';
import { tailLines } from '../utils/text.js';
import {
  CheckpointBranchDivergedError,
  CheckpointBranchMissingError,
  WorkspaceManager,
  type DiffStats
} from '../workspace/manager.js';
import { GitClient } from '../workspace/git.js';
import { labelNames, priorityLabel, selectIssues, type IssueSelection } from './issues.js';
import {
  applyIssueDisposition,
  dispositionForBlockedAgent,
  dispositionForIntake,
  humanRequestForIntake,
  type IssueDisposition
} from './disposition.js';
import { ensureHumanRequest } from './humanRequest.js';
import { RunLock } from './lock.js';
import {
  enqueueManagedPrGuardianJobs,
  enqueuePrGuardianJob,
  runPendingPrGuardianJobs,
  runPrGuardianSkill,
  type PrGuardianSkillResult
} from './prGuardian.js';
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
import {
  forbiddenCheckpointPublicationReason,
  isResumableImplementationState,
  listImplementationStates,
  loadImplementationState,
  openCheckpointStates,
  saveImplementationState,
  type ImplementationState
} from './implementationState.js';

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
  resumableIssueNumbers?: Set<number>;
  resumeBranches?: Set<string>;
  resumeBranchByIssue?: Map<number, string>;
}

const OPEN_PULL_REQUEST_LIMIT_CHECK_FETCH_LIMIT = 1000;

export async function runKaizen(options: RunOptions): Promise<RunSummary | { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> }> {
  const resolved = await resolveProject(options.project, options.cwd);
  const initialConfig = await loadOperationalConfig(resolved.project, {
    preferWorkspace: options.scheduled,
    requireWorkspace: options.scheduled
  });
  let config = initialConfig.config;
  assertJobEnabled(config, options.job);
  let scheduledJob = options.job ? schedulerJob(config, options.job) : undefined;
  let trigger = options.trigger ?? scheduledJob?.name ?? (options.scheduled ? 'scheduled' : 'manual');
  const startedAt = new Date();
  const runId = toRunId(startedAt);
  let runDeadlineAt = startedAt.getTime() + config.run.runTimeoutMinutes * 60_000;
  let runCommand = withRunDeadline(options.runCommand, runDeadlineAt);
  let github = new GitHubClient(runCommand, initialConfig.path);
  const stateDir = projectStateDir(resolved.slug);
  const configuredMaxIssues = (requestedIssueNumbers?: number[]) =>
    options.maxIssues ?? scheduledJob?.config.run.maxIssues ?? (requestedIssueNumbers ? requestedIssueNumbers.length : config.run.maxIssuesPerNight);
  const selectRunIssues = async (): Promise<RunIssueSelection> => {
    const requestedIssueNumbers = options.issueNumbers ?? (options.issue ? [options.issue] : undefined);
    const maxIssues = configuredMaxIssues(requestedIssueNumbers);
    const requestedIssues = requestedIssueNumbers
      ? await Promise.all(uniqueIssueNumbers(requestedIssueNumbers).map((issueNumber) => github.getIssue(issueNumber)))
      : undefined;
    const issues = requestedIssues ?? await github.listIssues(config.issues.label);
    const reconciled = await reconcileMergedPullRequestIssues({
      issues,
      github,
      dryRun: options.dryRun
    });
    const selectableIssues = reconciled.length > 0
      ? issues.filter((issue) => !reconciled.includes(issue.number))
      : issues;
    const automatic = options.scheduled && requestedIssues === undefined;
    const openPullRequests = automatic || selectableIssues.some(hasPullRequestResultMarker)
      ? await github.listOpenPullRequests(openPullRequestFetchLimit(config.run.maxOpenPullRequests))
      : [];
    const selection = selectIssues({
      issues: selectableIssues,
      config,
      maxIssues: config.safety.operationMode === 'external' || (automatic && !options.dryRun)
        ? Number.MAX_SAFE_INTEGER
        : maxIssues,
      explicit: requestedIssues !== undefined,
      openPullRequests
    });
    const authorizedSelection = config.safety.operationMode === 'external'
      ? await applyExecutionAuthorizationGate({ selection, config, repo: resolved.project.repo, github })
      : selection;
    const budgetedSelection = config.safety.operationMode === 'external' && (!automatic || options.dryRun)
      ? applyImplementationBudget({ ...authorizedSelection, openPullRequests }, maxIssues)
      : authorizedSelection;
    const implementationStates = await listImplementationStates(stateDir);
    const selectedIssueNumbers = new Set(budgetedSelection.selected.map((issue) => issue.number));
    const selectedResumableStates = implementationStates.filter(
      (state) => selectedIssueNumbers.has(state.issue) && isResumableImplementationState(state)
    );
    const openCheckpoints = openCheckpointStates(selectedResumableStates, openPullRequests);
    const resumableIssueNumbers = new Set(selectedResumableStates.map((state) => state.issue));
    const resumeBranches = new Set(openCheckpoints.map((state) => state.branch));
    const resumeBranchByIssue = new Map(openCheckpoints.map((state) => [state.issue, state.branch]));
    if (automatic && !options.dryRun) {
      return { ...budgetedSelection, openPullRequests, resumableIssueNumbers, resumeBranches, resumeBranchByIssue };
    }
    const limited = await applyOpenPullRequestLimit({
      config,
      selection: budgetedSelection,
      automatic,
      openPullRequests,
      resumableIssueNumbers,
      resumeBranches
    });
    const wipLimited = await applyGeneratedPullRequestWipLimit({
      config,
      selection: limited,
      automatic,
      repo: resolved.project.repo,
      github,
      resumableIssueNumbers
    });
    return { ...wipLimited, openPullRequests };
  };

  if (options.dryRun) {
    const { openPullRequests: _openPullRequests, ...selection } = await selectRunIssues();
    return selection;
  }

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

  try {
    const latestWorkspaceConfig = options.scheduled
      ? await loadLatestConfigFromExistingWorkspace({
        config,
        project: resolved.project,
        runCommand
      })
      : undefined;
    if (latestWorkspaceConfig) {
      config = latestWorkspaceConfig;
      assertJobEnabled(config, options.job);
      scheduledJob = options.job ? schedulerJob(config, options.job) : undefined;
      trigger = options.trigger ?? scheduledJob?.name ?? (options.scheduled ? 'scheduled' : 'manual');
      runDeadlineAt = startedAt.getTime() + config.run.runTimeoutMinutes * 60_000;
      runCommand = withRunDeadline(options.runCommand, runDeadlineAt);
      github = new GitHubClient(runCommand, resolved.project.workspacePath);
    }

    const nowDate = new Date();
    const cutoff = new Date(nowDate);
    cutoff.setHours(config.run.latestStartHour, 0, 0, 0);
    const lateStartGuard = scheduledJob?.config.run.mode === 'maintenance'
      ? scheduledJob.config.run.lateStartGuard
      : trigger === 'scheduled';
    const skipLatestStart = options.scheduled && lateStartGuard && nowDate > cutoff;

    if (skipLatestStart) {
      const now = nowDate.toISOString();
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
    }

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
      if (options.scheduled && config.guardian.enabled) {
        try {
          await enqueueManagedPrGuardianJobs({
            stateDir,
            config,
            repo: resolved.project.repo,
            pullRequests: selection.openPullRequests
          });
          await runPendingPrGuardianJobs({
            stateDir,
            config,
            workspaceDir: resolved.project.workspacePath,
            runCommand,
            isolateWorktree: true
          });
        } catch (error) {
          console.warn(`Scheduled PR Guardian reconciliation failed without blocking issue intake: ${String(error)}`);
        }
      }
      summary.skipped = selection.skipped;
      if (selection.selected.length > 0) {
        selection = await applyIssueIntakeGate({
          selection,
          repo: resolved.project.repo,
          runId,
          github,
          openPullRequests: selection.openPullRequests
        });
        if (options.scheduled && options.issueNumbers === undefined && options.issue === undefined) {
          selection = applyImplementationBudget(selection, configuredMaxIssues());
          const selectedIssueNumbers = new Set(selection.selected.map((issue) => issue.number));
          const resumableIssueNumbers = new Set(
            [...(selection.resumableIssueNumbers ?? [])].filter((issue) => selectedIssueNumbers.has(issue))
          );
          const resumeBranches = new Set(
            [...(selection.resumeBranchByIssue ?? [])]
              .filter(([issue]) => selectedIssueNumbers.has(issue))
              .map(([, branch]) => branch)
          );
          selection = {
            ...selection,
            ...await applyOpenPullRequestLimit({
              config,
              selection,
              automatic: true,
              openPullRequests: selection.openPullRequests,
              resumableIssueNumbers,
              resumeBranches
            })
          };
          selection = {
            ...selection,
            ...await applyGeneratedPullRequestWipLimit({
              config,
              selection,
              automatic: true,
              repo: resolved.project.repo,
              github,
              resumableIssueNumbers
            })
          };
        }
        summary.skipped = selection.skipped;
      }
      if (selection.selected.length > 0) {
        const verifierPreflightFailure = await preflightVerifier({ config, runCommand, runDir });
        if (verifierPreflightFailure) {
          runFailed = true;
          summary.skipped.push({ number: 0, reason: verifierPreflightFailure });
          return summary;
        }
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
              const checkpoint = await loadImplementationState(stateDir, issue.number);
              try {
                const worktree = await baseWorkspace.createIssueWorktree(config, issue, runId, {
                  branch: checkpoint?.branch,
                  resume: isResumableImplementationState(checkpoint)
                });
                worktrees.push({ issue, branch: worktree.branch, path: worktree.path });
              } catch (error) {
                if (
                  !(error instanceof CheckpointBranchMissingError) &&
                  !(error instanceof CheckpointBranchDivergedError)
                ) throw error;
                if (!checkpoint) throw error;
                const attempt = countAttempts(issue.comments ?? []) + 1;
                const reason = `${error.message}. Automatic resume stopped to avoid replacing the saved implementation with the default branch.`;
                await saveImplementationState(stateDir, {
                  issue: issue.number,
                  branch: checkpoint.branch,
                  phase: 'recovery-needed',
                  attempt,
                  lastFailure: reason,
                  pr: checkpoint.pr,
                  prUrl: checkpoint.prUrl
                });
                await github.comment(issue.number, buildResultComment({
                  runId,
                  issue: issue.number,
                  attempt,
                  outcome: 'blocked',
                  agent: 'orchestrator',
                  summary: reason,
                  reason,
                  trigger,
                  maxAttempts: config.run.maxAttemptsPerIssue,
                  prUrl: checkpoint.prUrl
                }));
                await applyIssueDisposition(github, issue.number, 'blocked');
                await github.removeLabels(issue.number, ['kaizen:in-progress']);
                summary.issues.push({
                  number: issue.number,
                  title: issue.title,
                  priority: priorityLabel(issue, config),
                  outcome: 'blocked',
                  reason
                });
              }
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
    }

    return summary;
  } finally {
    await lock.release();
  }
}

async function preflightVerifier(options: {
  config: KaizenConfig;
  runCommand: CommandRunner;
  runDir: string;
}): Promise<string | undefined> {
  if (!options.config.verifier.enabled) return undefined;
  const adapter = new VerifierAgentAdapter(options.runCommand, {
    ...options.config.verifier,
    envAllowlist: options.config.safety.envAllowlist
  });
  const runtimePath = path.join(options.runDir, 'verifier-runtime.json');
  try {
    const runtime = await adapter.inspectRuntime();
    await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    if (runtime.stale) {
      return `Verifier preflight failed: stale build (built ${runtime.build.commit ?? '<unknown>'}, runtime ${runtime.runtime.commit ?? '<unknown>'}). Rebuild and relink ${runtime.command}.`;
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fs.writeFile(runtimePath, `${JSON.stringify({
      protocol: 'unavailable',
      command: options.config.verifier.command,
      status: 'unavailable',
      stale: null,
      error: message
    }, null, 2)}\n`);
    return `Verifier preflight failed: ${message}`;
  }
}

export function applyImplementationBudget(selection: RunIssueSelection, maxIssues: number): RunIssueSelection {
  if (selection.selected.length <= maxIssues) return selection;
  return {
    ...selection,
    selected: selection.selected.slice(0, maxIssues),
    skipped: [
      ...selection.skipped,
      ...selection.selected.slice(maxIssues).map((issue) => ({ number: issue.number, reason: 'maxIssuesPerNight reached' }))
    ]
  };
}

async function applyExecutionAuthorizationGate(options: {
  selection: IssueSelection;
  config: KaizenConfig;
  repo: string;
  github: GitHubClient;
}): Promise<IssueSelection> {
  const selected: GitHubIssue[] = [];
  const skipped = [...options.selection.skipped];
  const authorization = options.config.issues.executionAuthorization;

  for (const issue of options.selection.selected) {
    if (!labelNames(issue).some((label) => label.toLowerCase() === authorization.label.toLowerCase())) {
      skipped.push({ number: issue.number, reason: `missing execution authorization label: ${authorization.label}` });
      continue;
    }
    try {
      const decision = await options.github.checkExecutionAuthorization({
        repo: options.repo,
        issue: issue.number,
        label: authorization.label,
        minimumPermission: authorization.minimumPermission
      });
      if (decision.authorized) selected.push(issue);
      else skipped.push({ number: issue.number, reason: decision.reason });
    } catch (error) {
      skipped.push({
        number: issue.number,
        reason: `execution authorization could not be verified: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return { selected, skipped };
}

function assertJobEnabled(config: KaizenConfig, jobName: string | undefined): void {
  if (!jobName) return;
  const configuredJob = config.scheduler.jobs[jobName];
  if (!configuredJob) throw new ConfigError(`Unknown scheduler job: ${jobName}`);
  if (!configuredJob.enabled) throw new ConfigError(`Scheduler job is disabled: ${jobName}`);
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

    const request = humanRequestForIntake(decision);
    if (request) {
      const humanState = await ensureHumanRequest({
        issue,
        request,
        runId: options.runId,
        repo: options.repo,
        github: options.github
      });
      if (humanState === 'acknowledged') {
        selected.push(issue);
        continue;
      }
    }

    await recordIntakeSkip({
      issue,
      decision,
      runId: options.runId,
      github: options.github,
      humanRequestAlreadyRecorded: Boolean(request)
    });
    skipped.push({ number: issue.number, reason: `intake ${decision.status}: ${decision.reason}` });
  }

  return { ...options.selection, selected, skipped, openPullRequests: options.openPullRequests };
}

async function loadLatestConfigFromExistingWorkspace(options: {
  config: KaizenConfig;
  project: { workspacePath: string };
  runCommand: CommandRunner;
}): Promise<KaizenConfig | undefined> {
  try {
    await fs.access(path.join(options.project.workspacePath, '.git'));
  } catch {
    return undefined;
  }

  const workspace = new WorkspaceManager(options.runCommand, options.project.workspacePath);
  await workspace.sync(options.config.git.defaultBranch);
  let config = await loadConfigIfPresent(workspace.path);
  if (!config) return undefined;
  if (config.git.defaultBranch !== options.config.git.defaultBranch) {
    await workspace.sync(config.git.defaultBranch);
    config = await loadConfigIfPresent(workspace.path);
    if (!config) return undefined;
  }
  return config;
}

async function loadConfigIfPresent(repoDir: string): Promise<KaizenConfig | undefined> {
  try {
    return await loadConfig(repoDir);
  } catch (error) {
    if (error instanceof ConfigError && error.message.includes('Missing Kaizen config:')) return undefined;
    throw error;
  }
}

async function reconcileMergedPullRequestIssues(options: {
  issues: GitHubIssue[];
  github: GitHubClient;
  dryRun: boolean;
}): Promise<number[]> {
  const closed: number[] = [];
  let defaultBranch: string | undefined;
  for (const issue of options.issues) {
    const prNumbers = markedPullRequestNumbers(issue.comments ?? []);
    const resolutions = await Promise.all(
      prNumbers.map((prNumber) => options.github.getPullRequestResolution(prNumber).catch(() => undefined))
    );
    for (const pr of resolutions) {
      if (!pr) continue;
      if (pr.state !== 'MERGED' && !pr.mergedAt) continue;
      if (!pr.closingIssuesReferences.some((reference) => reference.number === issue.number)) continue;
      defaultBranch ??= await options.github.getRepositoryDefaultBranch().catch(() => '');
      if (defaultBranch && pr.baseRefName && pr.baseRefName !== defaultBranch) continue;
      if (!options.dryRun) {
        try {
          await options.github.closeIssue(
            issue.number,
            `Kaizen Loop reconciled this issue after merged PR ${pr.url} did not leave the issue closed automatically.`
          );
          await options.github.removeLabels(issue.number, ['kaizen:in-progress']);
          await applyIssueDisposition(options.github, issue.number);
        } catch {
          break;
        }
      }
      closed.push(issue.number);
      break;
    }
  }
  return closed;
}

async function recordIntakeSkip(options: {
  issue: GitHubIssue;
  decision: IssueIntakeDecision;
  runId: string;
  github: GitHubClient;
  humanRequestAlreadyRecorded?: boolean;
}): Promise<void> {
  if (
    options.decision.status === 'already_resolved' &&
    hasIssueIntakeDecisionComment(options.issue, options.decision.status)
  ) {
    return;
  }
  await options.github.comment(options.issue.number, buildIssueIntakeComment(options.runId, options.decision));
  const disposition = dispositionForIntake(options.decision.status);
  if (disposition && !options.humanRequestAlreadyRecorded) {
    await applyIssueDisposition(options.github, options.issue.number, disposition);
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
  resumableIssueNumbers?: Set<number>;
  resumeBranches?: Set<string>;
}): Promise<{ selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> }> {
  if (!options.automatic || options.selection.selected.length === 0) return options.selection;
  const limit = options.config.run.maxOpenPullRequests;
  if (limit === 0) {
    return skipNewIssuesForLimit(options.selection, options.resumableIssueNumbers, 'open pull request limit reached (0/0)');
  }

  const countedOpenPullRequests = options.openPullRequests.filter(
    (pullRequest) => !isSyncPullRequest(pullRequest) && !options.resumeBranches?.has(pullRequest.headRefName ?? '')
  );
  const openCount = countedOpenPullRequests.length;
  const remaining = limit - openCount;
  if (remaining <= 0) {
    return skipNewIssuesForLimit(options.selection, options.resumableIssueNumbers, `open pull request limit reached (${openCount}/${limit})`);
  }
  if (options.selection.selected.length <= remaining) return options.selection;
  const newIssues = options.selection.selected.filter((issue) => !options.resumableIssueNumbers?.has(issue.number));
  const allowedNewIssues = new Set(newIssues.slice(0, remaining).map((issue) => issue.number));
  return {
    selected: options.selection.selected.filter((issue) => options.resumableIssueNumbers?.has(issue.number) || allowedNewIssues.has(issue.number)),
    skipped: [
      ...options.selection.skipped,
      ...newIssues.slice(remaining).map((issue) => ({
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
  resumableIssueNumbers?: Set<number>;
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
  return skipNewIssuesForLimit(options.selection, options.resumableIssueNumbers, generatedPullRequestWipLimitReason(backlog));
}

function skipNewIssuesForLimit(
  selection: { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> },
  resumableIssueNumbers: Set<number> | undefined,
  reason: string
) {
  const resumable = selection.selected.filter((issue) => resumableIssueNumbers?.has(issue.number));
  const skipped = selection.selected.filter((issue) => !resumableIssueNumbers?.has(issue.number));
  return {
    selected: resumable,
    skipped: [...selection.skipped, ...skipped.map((issue) => ({ number: issue.number, reason }))]
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
  const preferredBackends = selectPreferredBackends(options.config, options.issue, options.requestedAgent);
  const primaryBackend = preferredBackends[0];
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
    await applyIssueDisposition(options.github, options.issue.number);
    await options.github.addLabels(options.issue.number, ['kaizen:in-progress']);
    const savedState = await loadImplementationState(options.stateDir, options.issue.number);
    const previousState = isResumableImplementationState(savedState) ? savedState : undefined;
    if (previousState?.pr) {
      const currentPullRequest = await options.github.getPullRequest(previousState.pr).catch(() => undefined);
      if (currentPullRequest && (currentPullRequest.state === 'OPEN' || currentPullRequest.state === undefined)) {
        if (currentPullRequest.headRefName !== options.branch) {
          return await finishCheckpointPullRequestMismatch(options, attempts, previousState, currentPullRequest, started);
        }
        if (currentPullRequest.isDraft === false) {
          return await handOffReadyCheckpointPullRequest(options, attempts, currentPullRequest, started);
        }
      }
    }
    const resumeAtVerifier = previousState?.phase === 'infrastructure-failure';
    await saveImplementationState(options.stateDir, {
      issue: options.issue.number,
      branch: options.branch,
      phase: resumeAtVerifier ? 'verifying' : 'implementing',
      attempt: attempts,
      lastFailure: resumeAtVerifier ? undefined : previousState?.lastFailure,
      pr: previousState?.pr,
      prUrl: previousState?.prUrl
    });
    const setupResult = await workspace.runSetup(options.config, options.runDeadlineAt);
    if (setupResult && !setupResult.ok) {
      const reason = `Setup failed: ${setupResult.command}`;
      await fs.writeFile(path.join(issueDir, 'setup.log'), `# ${setupResult.command}\n${setupResult.output}`);
      return withDiscoveredFollowups(await finishFailed(options, agent, attempts, reason, started, [setupResult]), discoveredFollowups);
    }
    if (!resumeAtVerifier) agent = await selectAgent(options.config, options.runCommand);
    const branch = options.branch;

    let agentResult: AgentResult | undefined = resumeAtVerifier
      ? {
          status: 'fixed',
          summary: 'Resumed the preserved implementation checkpoint at verifier.',
          notes: 'Builder execution was skipped because the previous run stopped on verifier infrastructure.',
          discoveredIssues: [],
          raw: '',
          durationMs: 0
        }
      : undefined;
    let verifierResult: VerifierResult | undefined;
    let verifyResults: Array<{ command: string; ok: boolean; output: string }> = [];
    let previousFailure = previousState?.lastFailure;
    const filedDiscoveredIssues = new Set<string>();

    for (let retry = 0; retry <= options.config.run.maxVerifyRetries; retry += 1) {
      const skipBuilder = resumeAtVerifier && retry === 0;
      if (!skipBuilder) {
        if (resumeAtVerifier && retry === 1) agent = await selectAgent(options.config, options.runCommand);
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
          model: modelFor(options.config, primaryBackend),
          preferredBackends
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
      }

      if (!agentResult) throw new Error('Agent did not produce a result.');
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

      await saveImplementationState(options.stateDir, {
        issue: options.issue.number,
        branch,
        phase: 'verifying',
        attempt: attempts,
        lastFailure: previousFailure,
        pr: previousState?.pr,
        prUrl: previousState?.prUrl
      });
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
          await finishVerifierInfrastructureFailure(options, attempts, verifierResult, started, verifyResults),
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
    await saveImplementationState(options.stateDir, {
      issue: options.issue.number,
      branch,
      phase: 'publishing',
      attempt: attempts,
      pr: previousState?.pr,
      prUrl: previousState?.prUrl
    });

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
        stateDir: options.stateDir,
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
    if (previousState?.pr) {
      const pr = await reflectPullRequest({
        workspace,
        branch,
        issue: options.issue,
        config: options.config,
        agentResult,
        verifyResults,
        diff: finalDiff,
        github: options.github,
        stateDir: options.stateDir,
        runId: options.runId,
        trigger: options.trigger,
        attempt: attempts,
        reason: `Resumed checkpoint draft PR after verification passed: ${decision.reason}`
      });
      return withDiscoveredFollowups(await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started), discoveredFollowups);
    }
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
        stateDir: options.stateDir,
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
          stateDir: options.stateDir,
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
          stateDir: options.stateDir,
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
        await applyIssueDisposition(options.github, options.issue.number);
        await saveImplementationState(options.stateDir, {
          issue: options.issue.number,
          branch,
          phase: 'complete',
          attempt: attempts
        });
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
      stateDir: options.stateDir,
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
  await saveImplementationState(options.stateDir, {
    issue: options.issue.number,
    branch: pr.branch,
    phase: guardian.status === 'success' ? 'complete' : guardian.status === 'skipped' ? 'handoff' : 'guardian',
    attempt: attempts,
    pr: pr.number,
    prUrl: pr.url,
    lastFailure: guardian.status === 'failed' ? guardian.summary : undefined
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
  await applyIssueDisposition(options.github, options.issue.number, guardianFailed ? 'blocked' : undefined);
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

async function handOffReadyCheckpointPullRequest(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    stateDir: string;
    project: { repo: string; workspacePath: string };
    github: GitHubClient;
    runCommand: CommandRunner;
    runDeadlineAt: number;
    branch: string;
    runId: string;
    trigger: RunSummary['trigger'];
  },
  attempt: number,
  pullRequest: GitHubPullRequestDetails,
  started: number
): Promise<RunIssueSummary> {
  const guardian = await runPrGuardianAfterPullRequest({
    issue: options.issue,
    config: options.config,
    project: options.project,
    stateDir: options.stateDir,
    github: options.github,
    runCommand: options.runCommand,
    pr: {
      url: pullRequest.url,
      number: pullRequest.number,
      branch: options.branch,
      baseBranch: pullRequest.baseRefName,
      headSha: pullRequest.headRefOid
    },
    runDeadlineAt: options.runDeadlineAt
  });
  const reason = `Checkpoint PR was already ready for review; skipped implementation and handed it to PR guardian. ${guardian.summary}`;
  await saveImplementationState(options.stateDir, {
    issue: options.issue.number,
    branch: options.branch,
    phase: guardian.status === 'success' ? 'complete' : guardian.status === 'skipped' ? 'handoff' : 'guardian',
    attempt,
    pr: pullRequest.number,
    prUrl: pullRequest.url,
    lastFailure: guardian.status === 'failed' ? guardian.summary : undefined
  });
  await options.github.comment(options.issue.number, buildResultComment({
    runId: options.runId,
    issue: options.issue.number,
    attempt,
    outcome: 'pr-created',
    agent: 'orchestrator',
    summary: reason,
    reason,
    trigger: options.trigger,
    maxAttempts: options.config.run.maxAttemptsPerIssue,
    prUrl: pullRequest.url
  }));
  await applyIssueDisposition(options.github, options.issue.number, guardian.status === 'failed' ? 'blocked' : undefined);
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
  return {
    number: options.issue.number,
    title: options.issue.title,
    priority: priorityLabel(options.issue, options.config),
    agent: 'orchestrator',
    attempt,
    outcome: 'pr-created',
    branch: options.branch,
    pr: pullRequest.number,
    prUrl: pullRequest.url,
    guardian: {
      status: guardian.status,
      summary: guardian.summary,
      jobId: guardian.jobId
    },
    reason,
    durationMs: Date.now() - started
  };
}

async function finishCheckpointPullRequestMismatch(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    stateDir: string;
    github: GitHubClient;
    branch: string;
    runId: string;
    trigger: RunSummary['trigger'];
  },
  attempt: number,
  checkpoint: ImplementationState,
  pullRequest: GitHubPullRequestDetails,
  started: number
): Promise<RunIssueSummary> {
  const reason = `Checkpoint PR #${pullRequest.number} uses head branch ${pullRequest.headRefName ?? '<unknown>'}, expected ${options.branch}. Automatic update stopped.`;
  await saveImplementationState(options.stateDir, {
    issue: options.issue.number,
    branch: options.branch,
    phase: 'recovery-needed',
    attempt,
    lastFailure: reason,
    pr: checkpoint.pr,
    prUrl: checkpoint.prUrl ?? pullRequest.url
  });
  await options.github.comment(options.issue.number, buildResultComment({
    runId: options.runId,
    issue: options.issue.number,
    attempt,
    outcome: 'blocked',
    agent: 'orchestrator',
    summary: reason,
    reason,
    trigger: options.trigger,
    maxAttempts: options.config.run.maxAttemptsPerIssue,
    prUrl: checkpoint.prUrl ?? pullRequest.url
  }));
  await applyIssueDisposition(options.github, options.issue.number, 'blocked');
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
  return {
    number: options.issue.number,
    title: options.issue.title,
    priority: priorityLabel(options.issue, options.config),
    agent: 'orchestrator',
    attempt,
    outcome: 'blocked',
    branch: options.branch,
    pr: pullRequest.number,
    prUrl: checkpoint.prUrl ?? pullRequest.url,
    reason,
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

export function selectPreferredBackends(
  config: KaizenConfig,
  issue: GitHubIssue,
  requested: 'claude' | 'codex' | undefined
): Array<'claude' | 'codex'> {
  const labels = labelNames(issue);
  const primary = labels.includes('kaizen:agent:codex')
    ? 'codex'
    : labels.includes('kaizen:agent:claude')
      ? 'claude'
      : requested ?? config.agent.default;
  if (!config.agent.fallback) return [primary];
  const fallback = primary === 'codex' ? 'claude' : 'codex';
  return [primary, fallback];
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
    stateDir: string;
    project: { repo: string; workspacePath: string };
    runCommand: CommandRunner;
    branch: string;
  },
  agent: AgentAdapter,
  attempt: number,
  agentResult: AgentResult,
  started: number
): Promise<RunIssueSummary> {
  let disposition: Extract<
    IssueDisposition,
    'human-input-required' | 'retryable' | 'blocked' | 'attempts-exhausted'
  > = dispositionForBlockedAgent(agentResult);
  if (
    disposition === 'retryable' &&
    countConsecutiveRetryableBlocks(options.issue.comments ?? []) + 1 >= options.config.run.maxAttemptsPerIssue
  ) {
    disposition = 'attempts-exhausted';
  }
  if (disposition === 'human-input-required' && agentResult.humanRequest) {
    const humanState = await ensureHumanRequest({
      issue: options.issue,
      request: agentResult.humanRequest,
      runId: options.runId,
      repo: options.project.repo,
      github: options.github
    });
    if (humanState === 'acknowledged') disposition = 'blocked';
  }
  const reason = agentResult.blockedReason ?? agentResult.summary;
  const previousState = await loadImplementationState(options.stateDir, options.issue.number);
  const checkpoint = await checkpointPartialChanges(options, options.issue);
  const checkpointErrorReason = checkpoint.error ? `${reason}\n\nCheckpoint commit failed: ${checkpoint.error}` : reason;
  const checkpointReason = checkpoint.forbiddenFiles?.length
    ? `${checkpointErrorReason}\n\nForbidden changes discarded: ${checkpoint.forbiddenFiles.join(', ')}`
    : checkpointErrorReason;
  const draft = checkpoint.forbiddenFiles?.length
    ? { skipped: 'forbidden changes were discarded before checkpoint publication' }
    : await publishDraftCheckpoint(options, attempt, checkpointReason);
  const publicationReason = draft.skipped ? `${checkpointReason}\n\nDraft PR publication skipped: ${draft.skipped}` : checkpointReason;
  const recordedReason = draft.error
    ? `${publicationReason}\n\nDraft PR publication failed: ${draft.error}`
    : publicationReason;
  await saveImplementationState(options.stateDir, {
    issue: options.issue.number,
    branch: options.branch,
    phase: checkpoint.forbiddenFiles?.length && !checkpoint.restoredCheckpoint ? 'discarded' : 'blocked',
    attempt,
    lastFailure: recordedReason,
    pr: draft.pr?.number ?? previousState?.pr,
    prUrl: draft.pr?.url ?? previousState?.prUrl
  });
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
      reason: recordedReason,
      trigger: options.trigger,
      maxAttempts: options.config.run.maxAttemptsPerIssue,
      blockDisposition: disposition,
      resumeBranch: options.branch,
      prUrl: draft.pr?.url ?? previousState?.prUrl,
      checkpointPublished: Boolean(draft.pr?.url ?? previousState?.prUrl) && (!checkpoint.forbiddenFiles?.length || checkpoint.restoredCheckpoint)
    })
  );
  if (disposition !== 'human-input-required') {
    await applyIssueDisposition(options.github, options.issue.number, disposition);
  }
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
  return {
    number: options.issue.number,
    title: options.issue.title,
    agent: agent.name,
    attempt,
    outcome: 'blocked',
    reason: recordedReason,
    durationMs: Date.now() - started
  };
}

async function finishFailed(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    runId: string;
    github: GitHubClient;
    trigger: RunSummary['trigger'];
    stateDir: string;
    project: { workspacePath: string };
    runCommand: CommandRunner;
    branch: string;
  },
  agent: AgentAdapter,
  attempt: number,
  reason: string,
  started: number,
  verifyResults?: Array<{ command: string; ok: boolean; output: string }>
): Promise<RunIssueSummary> {
  const previousState = await loadImplementationState(options.stateDir, options.issue.number);
  const checkpoint = await checkpointPartialChanges(options, options.issue);
  const checkpointErrorReason = checkpoint.error ? `${reason}\n\nCheckpoint commit failed: ${checkpoint.error}` : reason;
  const checkpointReason = checkpoint.forbiddenFiles?.length
    ? `${checkpointErrorReason}\n\nForbidden changes discarded: ${checkpoint.forbiddenFiles.join(', ')}`
    : checkpointErrorReason;
  const draft = checkpoint.forbiddenFiles?.length
    ? { skipped: 'forbidden changes were discarded before checkpoint publication' }
    : await publishDraftCheckpoint(options, attempt, checkpointReason, verifyResults);
  const publicationReason = draft.skipped ? `${checkpointReason}\n\nDraft PR publication skipped: ${draft.skipped}` : checkpointReason;
  const recordedReason = draft.error ? `${publicationReason}\n\nDraft PR publication failed: ${draft.error}` : publicationReason;
  await saveImplementationState(options.stateDir, {
    issue: options.issue.number,
    branch: options.branch,
    phase: checkpoint.forbiddenFiles?.length && !checkpoint.restoredCheckpoint ? 'discarded' : 'failed',
    attempt,
    lastFailure: recordedReason,
    pr: draft.pr?.number ?? previousState?.pr,
    prUrl: draft.pr?.url ?? previousState?.prUrl
  });
  await options.github.comment(
    options.issue.number,
    buildResultComment({
      runId: options.runId,
      issue: options.issue.number,
      attempt,
      outcome: 'failed',
      agent: agent.name,
      summary: recordedReason,
      verifyResults,
      reason: recordedReason,
      trigger: options.trigger,
      maxAttempts: options.config.run.maxAttemptsPerIssue,
      resumeBranch: options.branch,
      prUrl: draft.pr?.url ?? previousState?.prUrl,
      checkpointPublished: Boolean(draft.pr?.url ?? previousState?.prUrl) && (!checkpoint.forbiddenFiles?.length || checkpoint.restoredCheckpoint)
    })
  );
  if (attempt >= options.config.run.maxAttemptsPerIssue) {
    await applyIssueDisposition(options.github, options.issue.number, 'attempts-exhausted');
  }
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
  return {
    number: options.issue.number,
    title: options.issue.title,
    agent: agent.name,
    attempt,
    outcome: 'failed',
    reason: recordedReason,
    durationMs: Date.now() - started
  };
}

async function finishVerifierInfrastructureFailure(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    runId: string;
    github: GitHubClient;
    trigger: RunSummary['trigger'];
    stateDir: string;
    project: { workspacePath: string };
    runCommand: CommandRunner;
    branch: string;
  },
  attempt: number,
  verifierResult: VerifierResult,
  started: number,
  verifyResults: Array<{ command: string; ok: boolean; output: string }>
): Promise<RunIssueSummary> {
  const previousState = await loadImplementationState(options.stateDir, options.issue.number);
  const reason = `Verifier infrastructure failure: ${verifierResult.summary}`;
  const checkpoint = await checkpointPartialChanges(options, options.issue);
  const checkpointErrorReason = checkpoint.error ? `${reason}\n\nCheckpoint commit failed: ${checkpoint.error}` : reason;
  const checkpointReason = checkpoint.forbiddenFiles?.length
    ? `${checkpointErrorReason}\n\nForbidden changes discarded: ${checkpoint.forbiddenFiles.join(', ')}`
    : checkpointErrorReason;
  const draft = checkpoint.forbiddenFiles?.length
    ? { skipped: 'forbidden changes were discarded before checkpoint publication' }
    : await publishDraftCheckpoint(options, attempt, checkpointReason, verifyResults);
  const publicationReason = draft.skipped ? `${checkpointReason}\n\nDraft PR publication skipped: ${draft.skipped}` : checkpointReason;
  const recordedReason = draft.error ? `${publicationReason}\n\nDraft PR publication failed: ${draft.error}` : publicationReason;
  await saveImplementationState(options.stateDir, {
    issue: options.issue.number,
    branch: options.branch,
    phase: checkpoint.forbiddenFiles?.length && !checkpoint.restoredCheckpoint ? 'discarded' : 'infrastructure-failure',
    attempt,
    lastFailure: recordedReason,
    pr: draft.pr?.number ?? previousState?.pr,
    prUrl: draft.pr?.url ?? previousState?.prUrl
  });
  await options.github.comment(
    options.issue.number,
    buildResultComment({
      runId: options.runId,
      issue: options.issue.number,
      attempt,
      outcome: 'infrastructure-failure',
      agent: 'verifier',
      summary: recordedReason,
      notes: verifierResult.notes,
      verifyResults,
      reason: recordedReason,
      trigger: options.trigger,
      maxAttempts: options.config.run.maxAttemptsPerIssue,
      resumeBranch: options.branch,
      prUrl: draft.pr?.url ?? previousState?.prUrl,
      checkpointPublished: Boolean(draft.pr?.url ?? previousState?.prUrl) && (!checkpoint.forbiddenFiles?.length || checkpoint.restoredCheckpoint)
    })
  );
  await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
  return {
    number: options.issue.number,
    title: options.issue.title,
    agent: 'verifier',
    attempt,
    outcome: 'infrastructure-failure',
    reason: recordedReason,
    durationMs: Date.now() - started
  };
}

async function publishDraftCheckpoint(
  options: {
    issue: GitHubIssue;
    config: KaizenConfig;
    stateDir: string;
    project: { repo?: string; workspacePath: string };
    github: GitHubClient;
    runCommand: CommandRunner;
    branch: string;
  },
  attempt: number,
  reason: string,
  verifyResults: Array<{ command: string; ok: boolean; output: string }> = []
): Promise<{ pr?: PullRequestResult; error?: string; skipped?: string }> {
  try {
    const workspace = new WorkspaceManager(options.runCommand, options.project.workspacePath);
    const current = await loadImplementationState(options.stateDir, options.issue.number);
    const existing = current?.pr ? await options.github.getPullRequest(current.pr) : undefined;
    if (existing && (existing.state === 'OPEN' || existing.state === undefined)) {
      const updateError = checkpointPullRequestUpdateError(existing, options.branch);
      if (updateError) return { pr: { number: existing.number, url: existing.url }, error: updateError };
    }
    const diff = await workspace.collectCheckpointDiffStats(options.config);
    const publicationBlocker = forbiddenCheckpointPublicationReason(diff.forbiddenFiles);
    if (publicationBlocker) return { skipped: publicationBlocker };
    if (diff.changedFiles === 0 && !current?.pr) return {};
    await workspace.git().push(options.branch, { forceWithLease: true });
    const title = `[WIP] kaizen: ${shortSummary(options.issue.title)} (#${options.issue.number})`;
    const body = buildDraftCheckpointBody(options.issue, options.branch, attempt, reason, verifyResults, diff);
    if (current?.pr && existing && (existing.state === 'OPEN' || existing.state === undefined)) {
      await options.github.editPullRequest(current.pr, { title, body });
      return { pr: { number: current.pr, url: current.prUrl ?? existing.url } };
    }
    const pr = await options.github.createPullRequest({
      base: options.config.git.defaultBranch,
      head: options.branch,
      title,
      body,
      expectedClosingIssueNumber: options.issue.number,
      draft: true
    });
    return { pr };
  } catch (error) {
    if (error instanceof CreatedPullRequestValidationError) {
      return { pr: error.pr, error: error.message };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function checkpointPullRequestUpdateError(pullRequest: GitHubPullRequestDetails, branch: string): string | undefined {
  if (pullRequest.headRefName !== branch) {
    return `Checkpoint PR #${pullRequest.number} head is ${pullRequest.headRefName ?? '<unknown>'}, expected ${branch}.`;
  }
  if (pullRequest.isDraft !== true) {
    return `Checkpoint PR #${pullRequest.number} is already ready for review; automatic checkpoint updates are disabled.`;
  }
  return undefined;
}

function buildDraftCheckpointBody(
  issue: GitHubIssue,
  branch: string,
  attempt: number,
  reason: string,
  verifyResults: Array<{ command: string; ok: boolean }>,
  diff: DiffStats
): string {
  const checks = verifyResults.length
    ? verifyResults.map((result) => `- [${result.ok ? 'x' : ' '}] \`${result.command}\``).join('\n')
    : '- [ ] Verification has not completed';
  return `## Work in progress

Kaizen Loop preserved a partial implementation after the run stopped. The next eligible run resumes from this branch and updates this draft PR.

Closes #${issue.number}

| | |
|---|---|
| Checkpoint branch | \`${branch}\` |
| Attempt | ${attempt} |
| Changed files | ${diff.changedFiles} |
| Changed lines | ${diff.changedLines} |

## Why the run stopped

${reason}

## Verification

${checks}

## Remaining work

- [ ] Resume implementation from the checkpoint
- [ ] Pass configured verification
- [ ] Pass verifier review
- [ ] Mark this PR ready for review
- [ ] Run PR guardian until merge-ready

<!-- kaizen-loop:draft-checkpoint issue=${issue.number} attempt=${attempt} -->`;
}

async function checkpointPartialChanges(
  options: {
    project: { workspacePath: string };
    runCommand: CommandRunner;
    config: KaizenConfig;
    branch: string;
  },
  issue: GitHubIssue
): Promise<{ error?: string; forbiddenFiles?: string[]; restoredCheckpoint?: boolean }> {
  try {
    const workspace = new WorkspaceManager(options.runCommand, options.project.workspacePath);
    const diff = await workspace.collectCheckpointDiffStats(options.config);
    if (diff.forbiddenFiles.length > 0) {
      const discarded = await workspace.discardIssueChanges(options.branch, options.config.git.defaultBranch);
      return { forbiddenFiles: diff.forbiddenFiles, ...discarded };
    }
    const git = workspace.git();
    if (!(await git.statusPorcelain()).trim()) return {};
    await git.addAll();
    await git.commit(`kaizen: checkpoint partial implementation (#${issue.number})`);
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
    ? verifyResults.map((result) => `- ${result.ok ? '[x]' : '[ ]'} \`${result.command}\` — ${result.ok ? '成功' : '失敗'}`).join('\n')
    : '- スキップ: リポジトリに検証コマンドが設定されていません';
  const notes = agentResult.notes.trim() ? `\n## Builder notes\n${agentResult.notes.trim()}\n` : '';
  const verifier = verifierResult
    ? verifierPrBodyLines(verifierResult).join('\n')
    : 'verifier: not run (verifier.enabled is false for this project)';
  const evidence = [
    '- reported: builder summary and builder notes come from the builder-agent self-report.',
    verifyResults.length > 0
      ? '- executed: Kaizen Loop ran the verification commands listed above.'
      : '- unverified: no repository verification commands are configured.',
    verifierEvidenceStrength(verifierResult),
    '- static: changed file and line counts come from git diff metadata.'
  ].join('\n');
  const changedFiles = diff.files.length
    ? diff.files.map((file) => `- \`${file}\` — ${agentResult.summary}`).join('\n')
    : '- (no files changed)';

  return `Closes #${issue.number}

## 元Issue
**#${issue.number}: ${escapeClosingReferences(issue.title)}**
${summarizeIssueBody(issue.body)}

## Builder task understanding
${agentResult.summary}
${notes}

## 変更ファイル
${changedFiles}

Changed files: ${diff.changedFiles} / Changed lines: ${diff.changedLines}

## Verification
${verify}

## Verifier verdict
${verifier}

## Evidence strength
${evidence}

## 残存リスク / レビュー観点
${riskReason}
`;
}

function summarizeIssueBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '(issue has no body)';
  const firstLines = trimmed.split('\n').slice(0, 10).join('\n');
  const summary = trimmed.length > firstLines.length || trimmed.split('\n').length > 10
    ? `${firstLines}\n…`
    : firstLines;
  return escapeClosingReferences(summary);
}

function escapeClosingReferences(text: string): string {
  return text.replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi, '$1 \\#$2');
}

function verifierPrBodyLines(verifierResult: VerifierResult): string[] {
  const lines = [
    `verifier: ${verifierResult.status}`,
    `summary: ${verifierResult.summary || '(none)'}`,
    `evidence: ${formatVerifierEvidenceGrade(verifierResult)}`
  ];
  if (verifierResult.reason) lines.push(`reason: ${verifierResult.reason}`);
  lines.push(...verifierStructuredEvidenceLines(verifierResult));
  const notes = verifierNotesWithoutStructuredDuplicates(verifierResult);
  if (notes) lines.push(`notes: ${notes}`);
  if (verifierResult.evidenceGrade === 'reported') {
    lines.push('warning: この判定は実行証拠ではなくテキスト報告に基づくため、未実行の可能性があります。');
  }
  return lines;
}

function verifierStructuredEvidenceLines(result: VerifierResult): string[] {
  const lines: string[] = [];
  for (const finding of result.mustFix ?? []) lines.push(`must_fix: ${formatVerifierFinding(finding)}`);
  for (const finding of result.shouldFix ?? []) lines.push(`should_fix: ${formatVerifierFinding(finding)}`);
  if (result.confidence !== undefined) lines.push(`confidence: ${result.confidence}/100`);
  if (result.risk !== undefined) lines.push(`risk: ${result.risk}`);
  return lines;
}

function formatVerifierFinding(finding: NonNullable<VerifierResult['mustFix']>[number]): string {
  const evidence = finding.evidence ? ` — evidence: ${finding.evidence}` : '';
  return `[${finding.source}] ${finding.message}${evidence}`;
}

function verifierNotesWithoutStructuredDuplicates(result: VerifierResult): string {
  const duplicateLines = new Set<string>();
  if (result.risk !== undefined) duplicateLines.add(`risk=${result.risk}`);
  if (result.confidence !== undefined) duplicateLines.add(`confidence=${result.confidence}`);
  if (result.mustFix?.length) duplicateLines.add(`must_fix=${result.mustFix.map((finding) => finding.message).join('; ')}`);
  if (result.shouldFix?.length) duplicateLines.add(`should_fix=${result.shouldFix.map((finding) => finding.message).join('; ')}`);
  return result.notes
    .split('\n')
    .filter((line) => !duplicateLines.has(line.trim()))
    .join('\n')
    .trim();
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
  stateDir: string;
  runId: string;
  trigger: RunSummary['trigger'];
  attempt: number;
  reason: string;
  verifierResult?: VerifierResult;
}): Promise<PullRequestReflection> {
  const title = `kaizen: ${shortSummary(options.agentResult.summary)} (#${options.issue.number})`;
  const body = buildPullRequestBody(options.issue, options.agentResult, options.verifyResults, options.diff, options.reason, options.verifierResult);
  const checkpoint = await loadImplementationState(options.stateDir, options.issue.number);
  const current = checkpoint?.pr ? await options.github.getPullRequest(checkpoint.pr) : undefined;
  if (current && (current.state === 'OPEN' || current.state === undefined)) {
    const updateError = checkpointPullRequestUpdateError(current, options.branch);
    if (updateError) throw new Error(updateError);
  }
  await options.workspace.git().push(options.branch, { forceWithLease: true });
  const headSha = await options.workspace.git().revParse('HEAD');
  if (checkpoint?.pr) {
    if (current && (current.state === 'OPEN' || current.state === undefined)) {
      await options.github.editPullRequest(checkpoint.pr, { title, body });
      await options.github.markPullRequestReady(checkpoint.pr);
      return {
        url: checkpoint.prUrl ?? current.url,
        number: checkpoint.pr,
        reason: options.reason,
        branch: options.branch,
        baseBranch: options.config.git.defaultBranch,
        headSha
      };
    }
  }
  try {
    const pr = await options.github.createPullRequest({
      base: options.config.git.defaultBranch,
      head: options.branch,
      title,
      body,
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
      issueNumber: options.issue.number,
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
  const reason = result.status === 'open_pr_with_warning'
    ? `Verifier cleared PR with warning: ${detail}`
    : `Verifier cleared PR: ${detail}`;
  return appendVerifierStructuredEvidence(reason, result);
}

function verifierBlockedReason(result: VerifierResult): string {
  const detail = result.reason || result.summary;
  const reason = result.status === 'needs_context'
    ? `Verifier needs context: ${detail}`
    : `Verifier blocked PR: ${detail}`;
  return appendVerifierStructuredEvidence(reason, result);
}

function appendVerifierStructuredEvidence(reason: string, result: VerifierResult): string {
  const evidence = verifierStructuredEvidenceLines(result);
  return evidence.length ? `${reason}\n${evidence.join('\n')}` : reason;
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
    const fingerprint = buildDiscoveredIssueFingerprint({
      repo,
      evidence: issue.evidence,
      failureClass: parseFailureClass(issue.evidence)
    });
    const key = `${repo}\n${fingerprint?.marker ?? issue.title.trim().toLowerCase()}`;
    if (options.filedKeys.has(key)) continue;

    try {
      const existing = await options.github.findOpenIssueByTitle({
        repo,
        title: issue.title,
        body: [issue.body, issue.expected, issue.evidence].filter(Boolean).join('\n\n'),
        evidence: issue.evidence,
        failureClass: parseFailureClass(issue.evidence)
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
  const fingerprint = buildDiscoveredIssueFingerprint({
    repo: options.repo,
    evidence: options.issue.evidence,
    failureClass: parseFailureClass(options.issue.evidence)
  });

  return `${fingerprint ? `${fingerprint.marker}\n\n` : ''}## Bug
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
  const lastRun = {
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    result: summary.result,
    processed: summary.issues.length,
    fixed: summary.issues.filter((issue) => issue.outcome === 'direct-commit' || issue.outcome === 'pr-created').length,
    prCreated: summary.issues.filter((issue) => issue.outcome === 'pr-created').length,
    failed: summary.issues.filter((issue) => issue.outcome === 'failed').length,
    infrastructureFailed: summary.issues.filter((issue) => issue.outcome === 'infrastructure-failure').length
  };
  await fs.writeFile(path.join(projectStateDir(slug), 'last-run.json'), `${JSON.stringify(lastRun, null, 2)}\n`);
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
