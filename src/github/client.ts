import { setTimeout as sleep } from 'node:timers/promises';
import type { CommandRunner } from '../utils/command.js';
import type { GitHubIssue, PullRequestResult } from './types.js';

export const KAIZEN_LABELS = [
  'kaizen',
  'kaizen:P0',
  'kaizen:P1',
  'kaizen:P2',
  'kaizen:direct',
  'kaizen:pr-only',
  'kaizen:in-progress',
  'kaizen:needs-human',
  'kaizen:agent:claude',
  'kaizen:agent:codex'
];

export class GitHubClient {
  constructor(
    private readonly run: CommandRunner,
    private readonly cwd: string
  ) {}

  async authStatus(): Promise<void> {
    await this.gh(['auth', 'status']);
  }

  async createLabels(labels = KAIZEN_LABELS): Promise<void> {
    for (const label of labels) {
      await this.gh(
        ['label', 'create', label, '--color', colorForLabel(label), '--description', descriptionForLabel(label)],
        { ignoreAlreadyExists: true }
      );
    }
  }

  async listIssues(label: string, limit = 100): Promise<GitHubIssue[]> {
    const result = await this.gh([
      'issue',
      'list',
      '--label',
      label,
      '--state',
      'open',
      '--json',
      'number,title,body,labels,createdAt,comments,url',
      '--limit',
      String(limit)
    ]);
    return JSON.parse(result.stdout || '[]') as GitHubIssue[];
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    const result = await this.gh([
      'issue',
      'view',
      String(number),
      '--json',
      'number,title,body,labels,createdAt,comments,url'
    ]);
    return JSON.parse(result.stdout) as GitHubIssue;
  }

  async addLabels(issue: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.gh(['issue', 'edit', String(issue), '--add-label', labels.join(',')]);
  }

  async removeLabels(issue: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.gh(['issue', 'edit', String(issue), '--remove-label', labels.join(',')], { ignoreMissingLabel: true });
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.gh(['issue', 'comment', String(issue), '--body', body]);
  }

  async createIssue(options: { title: string; body: string; labels: string[] }): Promise<GitHubIssue> {
    const result = await this.gh([
      'issue',
      'create',
      '--title',
      options.title,
      '--body',
      options.body,
      '--label',
      options.labels.join(',')
    ]);
    const number = Number(result.stdout.match(/\/issues\/(\d+)/)?.[1]);
    if (!number) throw new Error(`Could not parse created issue URL: ${result.stdout.trim()}`);
    return this.getIssue(number);
  }

  async closeIssue(issue: number, comment?: string): Promise<void> {
    const args = ['issue', 'close', String(issue)];
    if (comment) args.push('--comment', comment);
    await this.gh(args);
  }

  async createPullRequest(options: {
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<PullRequestResult> {
    const result = await this.gh([
      'pr',
      'create',
      '--base',
      options.base,
      '--head',
      options.head,
      '--title',
      options.title,
      '--body',
      options.body
    ]);
    const url = result.stdout.trim().split(/\s+/).find((part) => part.startsWith('http')) ?? result.stdout.trim();
    const number = url.match(/\/pull\/(\d+)/)?.[1];
    return { url, number: number ? Number(number) : undefined };
  }

  private async gh(args: string[], options: { ignoreAlreadyExists?: boolean; ignoreMissingLabel?: boolean } = {}) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.run('gh', args, { cwd: this.cwd });
      } catch (error) {
        const message = String(error);
        if (options.ignoreAlreadyExists && /already exists/i.test(message)) return emptyResult(args, this.cwd);
        if (options.ignoreMissingLabel && /not found|does not exist|missing/i.test(message)) return emptyResult(args, this.cwd);
        lastError = error;
        if (attempt < 3) await sleep(250 * attempt);
      }
    }
    throw lastError;
  }
}

function emptyResult(args: string[], cwd: string) {
  return { command: 'gh', args, cwd, exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
}

function colorForLabel(label: string): string {
  if (label.includes(':P0')) return 'b60205';
  if (label.includes(':P1')) return 'd93f0b';
  if (label.includes(':P2')) return 'fbca04';
  if (label.includes('needs-human')) return '5319e7';
  if (label.includes('in-progress')) return '1d76db';
  return '0e8a16';
}

function descriptionForLabel(label: string): string {
  const descriptions: Record<string, string> = {
    kaizen: 'Issue processed by Kaizen Loop',
    'kaizen:P0': 'Kaizen priority P0',
    'kaizen:P1': 'Kaizen priority P1',
    'kaizen:P2': 'Kaizen priority P2',
    'kaizen:direct': 'Allow direct commit when policy permits',
    'kaizen:pr-only': 'Force pull request reflection',
    'kaizen:in-progress': 'Currently being processed by Kaizen Loop',
    'kaizen:needs-human': 'Needs human input before retry',
    'kaizen:agent:claude': 'Use Claude Code for this issue',
    'kaizen:agent:codex': 'Use Codex for this issue'
  };
  return descriptions[label] ?? 'Kaizen Loop label';
}
