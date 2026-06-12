import fs from 'node:fs/promises';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../agents/claude.js';
import { CodexAdapter } from '../agents/codex.js';
import type { AgentAdapter, AgentResult } from '../agents/types.js';
import { buildFixPrompt } from '../agents/prompt.js';
import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
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
import type { RunIssueSummary, RunSummary } from './summary.js';

export interface RunOptions {
  cwd: string;
  project?: string;
  scheduled: boolean;
  issue?: number;
  dryRun: boolean;
  maxIssues?: number;
  agent?: 'claude' | 'codex';
  json: boolean;
  runCommand: CommandRunner;
}

export async function runKaizen(options: RunOptions): Promise<RunSummary | { selected: GitHubIssue[]; skipped: Array<{ number: number; reason: string }> }> {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
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

  const summary: RunSummary = {
    version: 1,
    project: resolved.slug,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    trigger: options.scheduled ? 'scheduled' : 'manual',
    result: 'success',
    issues: [],
    skipped: selection.skipped,
  };

  try {
    for (const issue of selection.selected) {
      const issueSummary = await processIssue({
        issue,
        config,
        runId,
        runDir,
        project: resolved.project,
        github,
        requestedAgent: options.agent,
        runCommand: options.runCommand
      });
      summary.issues.push(issueSummary);
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.result = resultFor(summary.issues);
    await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
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
  runCommand: CommandRunner;
}): Promise<RunIssueSummary> {
  const started = Date.now();
  const issueDir = path.join(options.runDir, `issue-${options.issue.number}`);
  await fs.mkdir(issueDir, { recursive: true });
  const attempts = countAttempts(options.issue.comments ?? []) + 1;
  const agent = selectAgent(options.config, options.issue, options.requestedAgent, options.runCommand);
  const remoteUrl = await new GitClient(options.runCommand, options.project.localPath).remoteUrl('origin');
  const workspace = new WorkspaceManager(options.runCommand, options.project.workspacePath, remoteUrl);

  try {
    await options.github.addLabels(options.issue.number, ['kaizen:in-progress']);
    await workspace.ensure();
    await workspace.sync(options.config.git.defaultBranch);
    await workspace.runSetup(options.config);
    const branch = await workspace.createIssueBranch(options.config, options.issue);

    const prompt = buildFixPrompt({
      repo: options.project.repo,
      issue: options.issue,
      config: options.config,
      attempt: attempts
    });
    if (!(await agent.isAvailable())) {
      return await finishFailed(options, agent, attempts, `${agent.name} agent is not available.`, started);
    }
    const agentResult = await agent.run({
      workspaceDir: options.project.workspacePath,
      prompt,
      timeoutMs: options.config.run.issueTimeoutMinutes * 60_000,
      model: modelFor(options.config, agent.name)
    });
    await fs.writeFile(path.join(issueDir, 'agent.log'), agentResult.raw);

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

    const verifyResults = await workspace.runVerify(options.config);
    await fs.writeFile(path.join(issueDir, 'verify.log'), verifyResults.map((item) => `# ${item.command}\n${item.output}`).join('\n\n'));
    const failedVerify = verifyResults.find((item) => !item.ok);
    if (failedVerify) {
      return await finishFailed(options, agent, attempts, `Verification failed: ${failedVerify.command}`, started, verifyResults);
    }
    await commitLeftovers(workspace, options.issue, agentResult);
    const finalDiff = await workspace.collectDiffStats(options.config);
    if (finalDiff.forbiddenFiles.length > 0) {
      return await finishFailed(options, agent, attempts, `Forbidden paths changed: ${finalDiff.forbiddenFiles.join(', ')}`, started, verifyResults);
    }

    await workspace.git().push(branch, { forceWithLease: true });
    const pr = await options.github.createPullRequest({
      base: options.config.git.defaultBranch,
      head: branch,
      title: `kaizen: ${shortSummary(agentResult.summary)} (#${options.issue.number})`,
      body: buildPullRequestBody(options.issue, agentResult, verifyResults, finalDiff)
    });
    await options.github.comment(
      options.issue.number,
      buildResultComment({
        runId: options.runId,
        issue: options.issue.number,
        attempt: attempts,
        outcome: 'pr-created',
        agent: agent.name,
        summary: agentSummary(agentResult),
        verifyResults,
        prUrl: pr.url,
        reason: 'Phase 1 MVP always creates a pull request.',
        maxAttempts: options.config.run.maxAttemptsPerIssue
      })
    );
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
      reason: 'phase1-pr-only',
      changedFiles: finalDiff.changedFiles,
      changedLines: finalDiff.changedLines,
      verifyRetries: 0,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return await finishFailed(options, agent, attempts, String(error), started);
  }
}

function selectAgent(config: KaizenConfig, issue: GitHubIssue, requested: 'claude' | 'codex' | undefined, runCommand: CommandRunner): AgentAdapter {
  const labels = labelNames(issue);
  const selected = labels.includes('kaizen:agent:codex')
    ? 'codex'
    : labels.includes('kaizen:agent:claude')
      ? 'claude'
      : requested ?? config.agent.default;
  if (selected === 'codex') return new CodexAdapter();
  return new ClaudeCodeAdapter(runCommand);
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
      reason: agentResult.blockedReason ?? agentResult.summary,
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

function buildPullRequestBody(
  issue: GitHubIssue,
  agentResult: AgentResult,
  verifyResults: Array<{ command: string; ok: boolean }>,
  diff: DiffStats
): string {
  const verify = verifyResults.length
    ? verifyResults.map((result) => `- ${result.ok ? '[x]' : '[ ]'} \`${result.command}\``).join('\n')
    : '- Verification commands are not configured';
  return `Closes #${issue.number}

## Summary
${agentResult.summary}

## Verification
${verify}

## Kaizen risk policy
Phase 1 MVP always creates a pull request.

Changed files: ${diff.changedFiles}
Changed lines: ${diff.changedLines}
`;
}

function modelFor(config: KaizenConfig, agent: 'claude' | 'codex'): string | null | undefined {
  return config.agent.model[agent];
}

function shortSummary(summary: string): string {
  return (summary || 'fix issue').split('\n')[0].slice(0, 80);
}

function resultFor(issues: RunIssueSummary[]): RunSummary['result'] {
  if (issues.length === 0) return 'success';
  if (issues.every((issue) => issue.outcome === 'pr-created')) return 'success';
  if (issues.some((issue) => issue.outcome === 'pr-created')) return 'partial';
  return 'failed';
}

function toRunId(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
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
