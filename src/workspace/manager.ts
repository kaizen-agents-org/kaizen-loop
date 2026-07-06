import fs from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { KaizenConfig } from '../config/schema.js';
import { buildAllowlistedEnv, type CommandRunner } from '../utils/command.js';
import { slugify } from '../utils/slug.js';
import { envWithKaizenTemp } from '../utils/temp.js';
import { GitClient } from './git.js';

export interface DiffStats {
  files: string[];
  changedFiles: number;
  changedLines: number;
  forbiddenFiles: string[];
  protectedFiles: string[];
}

export interface WorkspaceCommandResult {
  command: string;
  ok: boolean;
  output: string;
}

const DEFAULT_DIFF_TEXT_MAX_CHARS = 30_000;

export class WorkspaceManager {
  constructor(
    private readonly run: CommandRunner,
    private readonly workspacePath: string,
    private readonly remoteUrl = ''
  ) {}

  async ensure(): Promise<void> {
    try {
      await fs.access(path.join(this.workspacePath, '.git'));
    } catch {
      await fs.rm(this.workspacePath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(this.workspacePath), { recursive: true });
      const parentGit = new GitClient(this.run, path.dirname(this.workspacePath));
      await parentGit.clone(this.remoteUrl, this.workspacePath);
    }
  }

  git(): GitClient {
    return new GitClient(this.run, this.workspacePath);
  }

  get path(): string {
    return this.workspacePath;
  }

  async sync(defaultBranch: string): Promise<void> {
    const git = this.git();
    await git.fetch();
    await git.checkout(defaultBranch);
    await git.resetHard(`origin/${defaultBranch}`);
    await git.clean();
  }

  async runSetup(config: KaizenConfig, runDeadlineAt?: number): Promise<WorkspaceCommandResult | undefined> {
    if (!config.commands.setup) return undefined;
    const result = await this.runShell(config.commands.setup, undefined, config, runDeadlineAt);
    return {
      command: config.commands.setup,
      ok: result.exitCode === 0,
      output: `${result.stdout}${result.stderr}`
    };
  }

  async runVerify(config: KaizenConfig, runDeadlineAt?: number): Promise<WorkspaceCommandResult[]> {
    const results = [];
    for (const command of config.commands.verify) {
      const result = await this.runVerifyCommand(command, config, runDeadlineAt);
      results.push({
        command,
        ok: result.exitCode === 0,
        output: `${result.stdout}${result.stderr}`
      });
      if (result.exitCode !== 0) break;
    }
    return results;
  }

  private async runVerifyCommand(command: string, config: KaizenConfig, runDeadlineAt?: number) {
    const timeoutMs = config.commands.verifyTimeoutMinutes * 60_000;
    const result = await this.runShell(command, timeoutMs, config, runDeadlineAt);
    const output = `${result.stdout}${result.stderr}`;
    if (result.exitCode === 0 || !config.commands.setup || !isTransientDependencyFailure(output)) {
      return result;
    }

    const setup = await this.runShell(config.commands.setup, undefined, config, runDeadlineAt);
    const retried = setup.exitCode === 0
      ? await this.runShell(command, timeoutMs, config, runDeadlineAt)
      : result;
    const retryOutput = retried === result ? '' : `${retried.stdout}${retried.stderr}`;
    return {
      ...retried,
      stdout: [
        output,
        '',
        `# kaizen-loop dependency repair: ${config.commands.setup}`,
        setup.stdout,
        setup.stderr,
        setup.exitCode === 0 ? '# kaizen-loop dependency repair: retrying verification command' : '',
        retryOutput
      ].filter(Boolean).join('\n'),
      stderr: ''
    };
  }

  async createIssueBranch(config: KaizenConfig, issue: { number: number; title: string }): Promise<string> {
    const branch = issueBranchName(config, issue);
    const git = this.git();
    await git.deleteLocalBranch(branch);
    await git.switchNew(branch);
    return branch;
  }

  async createIssueWorktree(
    config: KaizenConfig,
    issue: { number: number; title: string },
    runId: string
  ): Promise<{ branch: string; path: string }> {
    const branch = issueBranchName(config, issue);
    const worktreePath = issueWorktreePath(this.workspacePath, runId, issue.number);
    const git = this.git();
    await git.worktreePrune();
    await git.worktreeRemove(worktreePath);
    await fs.rm(worktreePath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await this.removeWorktreesForBranch(branch);
    await git.deleteLocalBranch(branch);
    await git.worktreeAdd(worktreePath, branch, `origin/${config.git.defaultBranch}`);
    return { branch, path: worktreePath };
  }

  async removeIssueWorktree(worktreePath: string): Promise<void> {
    const git = this.git();
    await git.worktreeRemove(worktreePath);
    await fs.rm(worktreePath, { recursive: true, force: true });
    await git.worktreePrune();
  }

  async collectDiffStats(config: KaizenConfig): Promise<DiffStats> {
    const base = `origin/${config.git.defaultBranch}`;
    const git = this.git();
    const files = await git.diffNameOnly(base);
    const stats = await git.diffNumstat(base);
    const changedLines = stats.reduce((sum, item) => sum + item.added + item.deleted, 0);
    return {
      files,
      changedFiles: files.length,
      changedLines,
      forbiddenFiles: files.filter((file) => matchesAny(file, config.policy.forbiddenPaths)),
      protectedFiles: files.filter((file) => matchesAny(file, config.policy.protectedPaths))
    };
  }

  async collectDiffText(config: KaizenConfig, maxChars = DEFAULT_DIFF_TEXT_MAX_CHARS): Promise<string> {
    const base = `origin/${config.git.defaultBranch}`;
    const diff = await this.git().diff(base);
    return truncateText(diff.trim(), maxChars);
  }

  private async runShell(command: string, timeoutMs: number | undefined, config: KaizenConfig, runDeadlineAt: number | undefined) {
    return this.run(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', command] : ['-lc', command], {
      cwd: this.workspacePath,
      env: await envWithKaizenTemp(buildAllowlistedEnv(process.env, config.safety.envAllowlist), this.workspacePath),
      timeoutMs: boundedTimeoutMs(timeoutMs, runDeadlineAt),
      rejectOnNonZero: false
    });
  }

  private async removeWorktreesForBranch(branch: string): Promise<void> {
    const git = this.git();
    const worktrees = await git.worktreeList();
    for (const worktree of worktrees) {
      if (worktree.branch !== branch || worktree.path === this.workspacePath) continue;
      await git.worktreeRemove(worktree.path);
      await fs.rm(worktree.path, { recursive: true, force: true });
    }
  }
}

function boundedTimeoutMs(configuredTimeoutMs: number | undefined, runDeadlineAt: number | undefined): number | undefined {
  if (!runDeadlineAt) return configuredTimeoutMs;
  const remainingMs = runDeadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Kaizen run timeout exceeded.');
  return configuredTimeoutMs === undefined ? remainingMs : Math.min(configuredTimeoutMs, remainingMs);
}

function issueBranchName(config: KaizenConfig, issue: { number: number; title: string }): string {
  return `${config.git.branchPrefix}issue-${issue.number}-${slugify(issue.title)}`;
}

function issueWorktreePath(workspacePath: string, runId: string, issueNumber: number): string {
  return path.join(path.dirname(workspacePath), `${path.basename(workspacePath)}-worktrees`, runId, `issue-${issueNumber}`);
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true }));
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated after ${maxChars} characters]`;
}

function isTransientDependencyFailure(output: string): boolean {
  return (
    /Cannot find module ['"]?@rollup\/rollup-/i.test(output) ||
    /npm has a bug related to optional dependencies/i.test(output)
  );
}
