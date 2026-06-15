import { runKaizen, type DirectCommitConfirmation } from '../orchestrator/run.js';
import type { IssueSelection } from '../orchestrator/issues.js';
import type { RunSummary } from '../orchestrator/summary.js';
import type { CommandRunner } from '../utils/command.js';

export interface ImproveOptions {
  cwd: string;
  project?: string;
  issueNumbers?: number[];
  dryRun: boolean;
  maxIssues?: number;
  agent?: 'claude' | 'codex';
  json: boolean;
  confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
  runCommand: CommandRunner;
}

export async function planImprove(options: ImproveOptions): Promise<IssueSelection> {
  const result = await runKaizen({
    cwd: options.cwd,
    project: options.project,
    scheduled: false,
    trigger: 'instant',
    issueNumbers: options.issueNumbers,
    dryRun: true,
    maxIssues: maxIssuesFor(options),
    agent: options.agent,
    json: options.json,
    runCommand: options.runCommand
  });
  if ('issues' in result) {
    return { selected: [], skipped: result.skipped };
  }
  return result;
}

export async function runImprove(options: ImproveOptions): Promise<RunSummary | IssueSelection> {
  return runKaizen({
    cwd: options.cwd,
    project: options.project,
    scheduled: false,
    trigger: 'instant',
    issueNumbers: options.issueNumbers,
    dryRun: options.dryRun,
    maxIssues: maxIssuesFor(options),
    agent: options.agent,
    json: options.json,
    confirmDirectCommit: options.confirmDirectCommit,
    runCommand: options.runCommand
  });
}

function maxIssuesFor(options: ImproveOptions): number | undefined {
  return options.maxIssues ?? (options.issueNumbers && options.issueNumbers.length > 0 ? options.issueNumbers.length : undefined);
}
