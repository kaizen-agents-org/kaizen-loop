import { resolveProject } from '../config/registry.js';
import { loadConfig } from '../config/config.js';
import { GitHubClient } from '../github/client.js';
import { type DirectCommitConfirmation, runKaizen } from '../orchestrator/run.js';
import type { CommandRunner } from '../utils/command.js';
import type { RunLock } from '../orchestrator/lock.js';

export interface ReportIssueOptions {
  cwd: string;
  project?: string;
  title: string;
  body: string;
  priority?: 'P0' | 'P1' | 'P2';
  direct?: boolean;
  prOnly?: boolean;
  agent?: 'claude' | 'codex';
  queue?: boolean;
  extraLabels: string[];
  runCommand: CommandRunner;
}

export interface ReportIssueNowOptions extends ReportIssueOptions {
  json: boolean;
  assumeYes?: boolean;
  scheduled?: boolean;
  job?: string;
  existingLock?: RunLock;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
}

export async function reportIssue(options: ReportIssueOptions) {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  const github = new GitHubClient(options.runCommand, resolved.project.localPath);
  const labels = [config.issues.label, `kaizen:${options.priority ?? 'P2'}`, ...options.extraLabels];
  if (options.queue) {
    const queueLabels = uniqueLabels([
      config.issues.label,
      config.issues.executionAuthorization.label,
      config.issues.selection.includeLabel
    ]);
    await github.createLabels(queueLabels);
    labels.push(...queueLabels.filter((label) => !labels.includes(label)));
  }
  if (options.direct) labels.push('kaizen:direct');
  if (options.prOnly) labels.push('kaizen:pr-only');
  if (options.agent) labels.push(`kaizen:agent:${options.agent}`);
  return github.createIssue({
    title: options.title,
    body: options.body,
    labels
  });
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels)];
}

export async function reportIssueNow(options: ReportIssueNowOptions) {
  const issue = await reportIssue(options);
  const fix = await runKaizen({
    cwd: options.cwd,
    project: options.project,
    scheduled: Boolean(options.scheduled),
    trigger: options.job ? undefined : 'instant',
    job: options.job,
    issue: issue.number,
    dryRun: false,
    maxIssues: 1,
    agent: options.agent,
    json: options.json,
    assumeYes: Boolean(options.assumeYes),
    confirmDirectCommit: options.confirmDirectCommit,
    existingLock: options.existingLock,
    runCommand: options.runCommand
  });
  return { issue, fix };
}
