import fs from 'node:fs/promises';
import path from 'node:path';
import { BuilderAgentAdapter } from '../agents/builder.js';
import { VerifierAgentAdapter, type VerifierResult } from '../agents/verifier.js';
import type { AgentAdapter, AgentResult, DiscoveredIssue } from '../agents/types.js';
import { buildFixPrompt, buildVerifierPrompt } from '../agents/prompt.js';
import { loadConfig } from '../config/config.js';
import { loadRegistry, resolveProject, saveRegistry } from '../config/registry.js';
import type { KaizenConfig } from '../config/schema.js';
import { GitHubClient } from '../github/client.js';
import type { GitHubIssue } from '../github/types.js';
import { agentSummary, buildResultComment, countAttempts } from '../report/comments.js';
import type { CommandRunner } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { projectStateDir } from '../utils/paths.js';
import { WorkspaceManager, type DiffStats } from '../workspace/manager.js';
import { GitClient } from '../workspace/git.js';
import { labelNames, priorityLabel, selectIssues } from './issues.js';
import { RunLock } from './lock.js';
import { runPrGuardianSkill, type PrGuardianSkillResult } from './prGuardian.js';
import { decideReflection, type ReflectionDecision } from './reflection.js';
import type { RunIssueSummary, RunSummary } from './summary.js';

export interface RunOptions {
  cwd: string;
  project?: string;
  scheduled: boolean;
  trigger?: 'manual' | 'scheduled' | 'instant' | 'watch';
  issue?: number;
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
}

export async function runKaizen(options: RunOptions): Promise<RunSummary | { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> }> {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  if (options.scheduled && new Date().getHours() > config.run.latestStartHour) {
    const now = new Date().toISOString();
    return {
      version: 1,
      project: resolved.slug,
      startedAt: now,
      finishedAt: now,
      trigger: 'scheduled',
      result: 'success',
      issues: [],
      skipped: [{ number: 0, reason: `latestStartHour(${config.run.latestStartHour}) passed` }]
    };
  }
  const github = new GitHubClient(options.runCommand, resolved.project.localPath);
  const maxIssues = options.maxIssues ?? config.run.maxIssuesPerNight;
  const issues = options.issue ? [await github.getIssue(options.issue)] : await github.listIssues(config.issues.label);
  const selection = selectIssues({ issues, config, maxIssues, onlyIssue: options.issue });

  if (options.dryRun) return selection;

  const stateDir = projectStateDir(resolved.slug);
  await fs.mkdir(stateDir, { recursive: true });
  await ensureNotPaused(stateDir);
  const lock = await RunLock.acquire(stateDir);

  const startedAt = new Date();
  const runId = toRunId(startedAt);
  const runDir = path.join(stateDir, 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const trigger = options.trigger ?? (options.scheduled ? 'scheduled' : 'manual');
  const summary: RunSummary = {
    version: 1,
    project: resolved.slug,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    trigger,
    result: 'success',
    issues: [],
    skipped: selection.skipped,
  };

  let abortReason: string | undefined;
  try {
    for (let index = 0; index < selection.selected.length; index += 1) {
      const issue = selection.selected[index];
      try {
        const issueSummary = await processIssue({
          issue,
          config,
          runId,
          runDir,
          project: resolved.project,
          github,
          requestedAgent: options.agent,
          trigger,
          assumeYes: Boolean(options.assumeYes),
          confirmDirectCommit: options.confirmDirectCommit,
          runCommand: options.runCommand
        });
        summary.issues.push(issueSummary);
      } catch (error) {
        if (!(error instanceof RunAbortError)) throw error;
        abortReason = error.message;
        summary.skipped.push(
          ...selection.selected.slice(index).map((skippedIssue) => ({
            number: skippedIssue.number,
            reason: `run aborted: ${abortReason}`
          }))
        );
        break;
      }
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.result = abortReason ? 'failed' : resultFor(summary.issues);
    await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await updateLastRun(resolved.slug, summary);
    await lock.release();
  }

  return summary;
}

async function processIssue(options: {
  issue: GitHubIssue;
  config: KaizenConfig;
  runId: string;
  runDir: string;
  project: { repo: string; localPath: string; workspacePath: string };
  github: GitHubClient;
  requestedAgent?: 'claude' | 'codex';
  trigger: RunSummary['trigger'];
  assumeYes: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<DirectCommitChoice>;
  runCommand: CommandRunner;
}): Promise<RunIssueSummary> {
  const started = Date.now();
  const issueDir = path.join(options.runDir, `issue-${options.issue.number}`);
  await fs.mkdir(issueDir, { recursive: true });
  const attempts = countAttempts(options.issue.comments ?? []) + 1;
  const preferredBackend = selectPreferredBackend(options.config, options.issue, options.requestedAgent);
  const agent = await selectAgent(options.config, options.runCommand);
  const verifier = options.config.verifier.enabled ? new VerifierAgentAdapter(options.runCommand, options.config.verifier) : undefined;
  const remoteUrl = await new GitClient(options.runCommand, options.project.localPath).remoteUrl('origin');
  const workspace = new WorkspaceManager(options.runCommand, options.project.workspacePath, remoteUrl);

  try {
    await options.github.addLabels(options.issue.number, ['kaizen:in-progress']);
    await workspace.ensure();
    await workspace.sync(options.config.git.defaultBranch);
    await workspace.runSetup(options.config);
    const baselineVerify = await workspace.runVerify(options.config);
    const failedBaseline = baselineVerify.find((item) => !item.ok);
    if (failedBaseline) {
      const reason = `Baseline verification failed: ${failedBaseline.command}`;
      await fs.writeFile(path.join(issueDir, 'verify.log'), baselineVerify.map((item) => `# ${item.command}\n${item.output}`).join('\n\n'));
      await options.github.comment(options.issue.number, buildRunAbortComment(options.runId, reason, baselineVerify));
      await options.github.removeLabels(options.issue.number, ['kaizen:in-progress']);
      throw new RunAbortError(reason);
    }
    await workspace.sync(options.config.git.defaultBranch);
    await workspace.runSetup(options.config);
    const branch = await workspace.createIssueBranch(options.config, options.issue);

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
        timeoutMs: options.config.run.issueTimeoutMinutes * 60_000,
        model: modelFor(options.config, preferredBackend),
        preferredBackend
      });
      await fs.appendFile(path.join(issueDir, 'agent.log'), `\n# Agent attempt ${retry + 1}\n${agentResult.raw}\n`);
      await fileDiscoveredIssues({
        sourceIssue: options.issue,
        projectRepo: options.project.repo,
        github: options.github,
        runId: options.runId,
        issueDir,
        discoveredIssues: agentResult.discoveredIssues,
        filedKeys: filedDiscoveredIssues
      });

      if (agentResult.status === 'blocked') {
        return await finishBlocked(options, agent, attempts, agentResult, started);
      }
      if (agentResult.status === 'error' || agentResult.status === 'timeout') {
        return await finishFailed(options, agent, attempts, agentResult.summary, started);
      }

      await commitLeftovers(workspace, options.issue, agentResult);
      const diff = await workspace.collectDiffStats(options.config);
      if (diff.changedFiles === 0) {
        return await finishFailed(options, agent, attempts, 'Agent produced no changes.', started);
      }
      if (diff.forbiddenFiles.length > 0) {
        return await finishFailed(options, agent, attempts, `Forbidden paths changed: ${diff.forbiddenFiles.join(', ')}`, started);
      }

      verifyResults = await workspace.runVerify(options.config);
      await fs.writeFile(path.join(issueDir, 'verify.log'), verifyResults.map((item) => `# ${item.command}\n${item.output}`).join('\n\n'));
      const failedVerify = verifyResults.find((item) => !item.ok);
      if (failedVerify) {
        if (retry >= options.config.run.maxVerifyRetries) {
          return await finishFailed(options, agent, attempts, `Verification failed: ${failedVerify.command}`, started, verifyResults);
        }
        previousFailure = `Verification failed: ${failedVerify.command}\n\n${tail(failedVerify.output, 200)}`;
        continue;
      }

      if (!verifier) break;

      const verifierDiff = await workspace.collectDiffStats(options.config);
      verifierResult = await verifier.run({
        workspaceDir: options.project.workspacePath,
        prompt: buildVerifierPrompt({
          repo: options.project.repo,
          issue: options.issue,
          agentResult,
          verifyResults,
          diff: verifierDiff
        })
      });
      await fs.appendFile(path.join(issueDir, 'verifier.log'), `\n# Verifier attempt ${retry + 1}\n${verifierResult.raw}\n`);

      if (verifierResult.status === 'open_pr' || verifierResult.status === 'open_pr_with_warning') break;
      if (verifierResult.status === 'error' || verifierResult.status === 'timeout') {
        return await finishFailed(options, agent, attempts, `Verifier failed: ${verifierResult.summary}`, started, verifyResults);
      }
      if (retry >= options.config.run.maxVerifyRetries) {
        return await finishFailed(options, agent, attempts, verifierBlockedReason(verifierResult), started, verifyResults);
      }
      previousFailure = `${verifierBlockedReason(verifierResult)}\n\n${verifierResult.notes || verifierResult.raw}`;
    }

    if (!agentResult) {
      return await finishFailed(options, agent, attempts, 'Agent did not produce a result.', started);
    }

    await commitLeftovers(workspace, options.issue, agentResult);
    const diff = await workspace.collectDiffStats(options.config);
    if (diff.changedFiles === 0) {
      return await finishFailed(options, agent, attempts, 'Agent produced no changes.', started);
    }
    if (diff.forbiddenFiles.length > 0) {
      return await finishFailed(options, agent, attempts, `Forbidden paths changed: ${diff.forbiddenFiles.join(', ')}`, started);
    }
    await commitLeftovers(workspace, options.issue, agentResult);
    const finalDiff = await workspace.collectDiffStats(options.config);
    if (finalDiff.forbiddenFiles.length > 0) {
      return await finishFailed(options, agent, attempts, `Forbidden paths changed: ${finalDiff.forbiddenFiles.join(', ')}`, started, verifyResults);
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
        reason: verifierPrReason(verifierResult)
      });
      return await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started);
    }

    const decision = decideReflection({
      config: options.config,
      labels: labelNames(options.issue),
      diff: finalDiff,
      verifyConfigured: options.config.commands.verify.length > 0
    });
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
        return await finishFailed(options, agent, attempts, `Direct commit rejected: ${decision.reason}`, started, verifyResults);
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
          reason: `Instant direct commit switched to PR: ${decision.reason}`
        });
        return await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started);
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
        return {
          number: options.issue.number,
          title: options.issue.title,
          priority: priorityLabel(options.issue, options.config),
          agent: agent.name,
          attempt: attempts,
          outcome: 'direct-commit',
          commit: direct.commit,
          reason: decision.reason,
          changedFiles: finalDiff.changedFiles,
          changedLines: finalDiff.changedLines,
          verifyRetries: Math.max(0, verifyResults.filter((result) => !result.ok).length),
          durationMs: Date.now() - started
        };
      }
      return await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, direct, started);
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
      reason: decision.reason
    });
    return await finishPr(options, agent, attempts, agentResult, verifyResults, finalDiff, pr, started);
  } catch (error) {
    if (error instanceof RunAbortError) throw error;
    return await finishFailed(options, agent, attempts, String(error), started);
  }
}

class RunAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunAbortError';
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
    runCommand: CommandRunner;
  },
  agent: AgentAdapter,
  attempts: number,
  agentResult: AgentResult,
  verifyResults: Array<{ command: string; ok: boolean; output: string }>,
  finalDiff: DiffStats,
  pr: PullRequestReflection,
  started: number
): Promise<RunIssueSummary> {
    const guardian = await runPrGuardianAfterPullRequest({
      issue: options.issue,
      config: options.config,
      project: options.project,
      github: options.github,
      runCommand: options.runCommand,
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
      pr: pr.number,
      prUrl: pr.url,
      guardian: {
        status: guardian.status,
        summary: guardian.summary
      },
      reason,
      changedFiles: finalDiff.changedFiles,
      changedLines: finalDiff.changedLines,
      verifyRetries: 0,
      durationMs: Date.now() - started
    };
}

async function selectAgent(config: KaizenConfig, runCommand: CommandRunner): Promise<AgentAdapter> {
  const agent = new BuilderAgentAdapter(runCommand, config.builder);
  await agent.isAvailable();
  return agent;
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
      maxAttempts: options.config.run.maxAttemptsPerIssue
    })
  );
  await options.github.addLabels(options.issue.number, ['kaizen:needs-human']);
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
  riskReason: string
): string {
  const verify = verifyResults.length
    ? verifyResults.map((result) => `- ${result.ok ? '[x]' : '[ ]'} \`${result.command}\``).join('\n')
    : '- Verification commands are not configured';
  const notes = agentResult.notes.trim() ? `\n## Builder notes\n${agentResult.notes.trim()}\n` : '';
  return `Closes #${issue.number}

## Summary
${agentResult.summary}
${notes}

## Verification
${verify}

## Kaizen risk policy
${riskReason}

Changed files: ${diff.changedFiles}
Changed lines: ${diff.changedLines}
`;
}

function buildRunAbortComment(
  runId: string,
  reason: string,
  verifyResults: Array<{ command: string; ok: boolean; output: string }>
): string {
  const verify = verifyResults.length
    ? verifyResults.map((result) => `- ${result.ok ? '[x]' : '[ ]'} \`${result.command}\``).join('\n')
    : '- Verification commands are not configured';

  return `## Kaizen Loop run aborted

The run stopped before agent execution because the baseline verification failed on the clean default branch.
This is treated as an environment or existing-repository failure, not as an Issue attempt.

| | |
|---|---|
| Run | ${runId} |
| Reason | ${reason} |

## Baseline verification
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
  await git.checkout(options.config.git.defaultBranch);
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
  reason: string;
}): Promise<PullRequestReflection> {
  await options.workspace.git().push(options.branch, { forceWithLease: true });
  const pr = await options.github.createPullRequest({
    base: options.config.git.defaultBranch,
    head: options.branch,
    title: `kaizen: ${shortSummary(options.agentResult.summary)} (#${options.issue.number})`,
    body: buildPullRequestBody(options.issue, options.agentResult, options.verifyResults, options.diff, options.reason)
  });
  return { ...pr, reason: options.reason, branch: options.branch, baseBranch: options.config.git.defaultBranch };
}

async function runPrGuardianAfterPullRequest(options: {
  issue: GitHubIssue;
  config: KaizenConfig;
  project: { repo: string; workspacePath: string };
  github: GitHubClient;
  runCommand: CommandRunner;
  pr: { url: string; number?: number; branch: string; baseBranch: string };
}): Promise<PrGuardianSkillResult> {
  if (!options.pr.number) {
    return {
      status: 'skipped',
      summary: 'PR number could not be parsed; skipped mergeability monitoring.',
      raw: '',
      durationMs: 0
    };
  }

  const result = await runPrGuardianSkill(options.runCommand, {
    config: options.config,
    workspaceDir: options.project.workspacePath,
    repo: options.project.repo,
    prUrl: options.pr.url,
    prNumber: options.pr.number,
    branch: options.pr.branch,
    baseBranch: options.pr.baseBranch
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

async function fileDiscoveredIssues(options: {
  sourceIssue: GitHubIssue;
  projectRepo: string;
  github: GitHubClient;
  runId: string;
  issueDir: string;
  discoveredIssues: DiscoveredIssue[];
  filedKeys: Set<string>;
}): Promise<void> {
  const filed: Array<{ title: string; repo: string; url?: string; duplicate?: boolean }> = [];

  for (const issue of options.discoveredIssues) {
    const repo = resolveDiscoveredIssueRepo(issue.repo, options.projectRepo);
    const key = `${repo}\n${issue.title.trim().toLowerCase()}`;
    if (options.filedKeys.has(key)) continue;

    try {
      const existing = await options.github.findOpenIssueByTitle({ repo, title: issue.title });
      if (existing) {
        filed.push({ title: issue.title, repo, url: existing.url, duplicate: true });
        options.filedKeys.add(key);
        continue;
      }
      const created = await options.github.createIssue({
        repo,
        title: issue.title,
        body: buildDiscoveredIssueBody({
          issue,
          repo,
          sourceIssue: options.sourceIssue,
          sourceRepo: options.projectRepo,
          runId: options.runId
        }),
        labels: labelsForDiscoveredIssue(issue)
      });
      filed.push({ title: issue.title, repo, url: created.url });
      options.filedKeys.add(key);
    } catch (error) {
      await fs.appendFile(
        path.join(options.issueDir, 'discovered-issues.log'),
        `Failed to file discovered issue "${issue.title}" in ${repo}: ${String(error)}\n`
      );
    }
  }

  if (filed.length === 0) return;

  try {
    await options.github.comment(
      options.sourceIssue.number,
      `## Kaizen discovered follow-up issue${filed.length === 1 ? '' : 's'}

${filed.map((item) => `- ${item.duplicate ? 'Existing' : 'Created'} in \`${item.repo}\`: ${item.url ?? item.title}`).join('\n')}

These were reported by the builder agent as separate bugs and filed by kaizen-loop.`
    );
  } catch (error) {
    await fs.appendFile(
      path.join(options.issueDir, 'discovered-issues.log'),
      `Failed to comment about discovered issue filing on source issue #${options.sourceIssue.number}: ${String(error)}\n`
    );
  }
}

function buildDiscoveredIssueBody(options: {
  issue: DiscoveredIssue;
  repo: string;
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
Filed in \`${options.repo}\` because the builder agent reported this target while processing \`${options.sourceRepo}#${options.sourceIssue.number}\`.

## Notes
- Source issue: ${options.sourceIssue.url ?? `${options.sourceRepo}#${options.sourceIssue.number}`}
- Source title: ${options.sourceIssue.title}
- Kaizen run: ${options.runId}
${options.issue.severity ? `- Reported severity: ${options.issue.severity}` : ''}`;
}

function resolveDiscoveredIssueRepo(repo: string | undefined, fallbackRepo: string): string {
  if (!repo?.trim()) return fallbackRepo;
  const normalized = repo.trim();
  if (normalized.includes('/')) return normalized;
  const key = normalized.toLowerCase();
  const aliases: Record<string, string> = {
    'kaizen-loop': 'kaizen-agents-org/kaizen-loop',
    'builder-agent': 'kaizen-agents-org/builder-agent',
    verifier: 'kaizen-agents-org/verifier',
    '.github': 'kaizen-agents-org/.github',
    github: 'kaizen-agents-org/.github'
  };
  return aliases[key] ?? fallbackRepo;
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

function toRunId(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

function tail(output: string, lines: number): string {
  return output.split('\n').slice(-lines).join('\n');
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
