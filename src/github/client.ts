import { setTimeout as sleep } from 'node:timers/promises';
import { githubCliEnv, type CommandRunner } from '../utils/command.js';
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDetails,
  GitHubPullRequestLinkage,
  PullRequestResult
} from './types.js';

export const KAIZEN_LABELS = [
  'kaizen',
  'kaizen:P0',
  'kaizen:P1',
  'kaizen:P2',
  'kaizen:ready',
  'kaizen:direct',
  'kaizen:pr-only',
  'kaizen:in-progress',
  'kaizen:needs-human',
  'kaizen:goal',
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

  async listOpenPullRequests(limit = 100): Promise<GitHubPullRequest[]> {
    const result = await this.gh([
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,headRefName,headRepositoryOwner,url',
      '--limit',
      String(limit)
    ]);
    return JSON.parse(result.stdout || '[]') as GitHubPullRequest[];
  }

  async searchOpenPullRequestsForOwner(owner: string, limit = 1000): Promise<GitHubPullRequest[]> {
    const result = await this.gh([
      'search',
      'prs',
      '--owner',
      owner,
      '--state',
      'open',
      '--json',
      'number,url,author,repository',
      '--limit',
      String(limit)
    ]);
    return JSON.parse(result.stdout || '[]') as GitHubPullRequest[];
  }

  async getPullRequest(number: number): Promise<GitHubPullRequestDetails> {
    const result = await this.gh([
      'pr',
      'view',
      String(number),
      '--json',
      'number,headRefName,headRepositoryOwner,url,baseRefName,headRefOid'
    ]);
    return JSON.parse(result.stdout) as GitHubPullRequestDetails;
  }

  async getRepositoryDefaultBranch(): Promise<string> {
    const result = await this.gh(['repo', 'view', '--json', 'defaultBranchRef']);
    const payload = JSON.parse(result.stdout || '{}') as { defaultBranchRef?: { name?: string } };
    return payload.defaultBranchRef?.name ?? '';
  }

  async getPullRequestLinkage(number: number): Promise<GitHubPullRequestLinkage> {
    const result = await this.gh([
      'pr',
      'view',
      String(number),
      '--json',
      'number,url,baseRefName,isDraft,closingIssuesReferences'
    ]);
    return JSON.parse(result.stdout) as GitHubPullRequestLinkage;
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

  async findOpenIssueByTitle(options: { repo?: string; title: string; body?: string }): Promise<GitHubIssue | undefined> {
    const exactArgs = [
      'issue',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,body,labels,createdAt,comments,url',
      '--search',
      exactTitleSearch(options.title),
      '--limit',
      '100'
    ];
    if (options.repo) exactArgs.push('--repo', options.repo);
    const exactResult = await this.gh(exactArgs);
    const exactIssues = JSON.parse(exactResult.stdout || '[]') as GitHubIssue[];
    const exactMatch = exactIssues.find((issue) => normalizedTitle(issue.title) === normalizedTitle(options.title));
    if (exactMatch) return exactMatch;

    const args = [
      'issue',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,body,labels,createdAt,comments,url',
      '--limit',
      '100'
    ];
    if (options.repo) args.push('--repo', options.repo);
    const result = await this.gh(args);
    const issues = JSON.parse(result.stdout || '[]') as GitHubIssue[];
    return issues.find((issue) => isEquivalentOpenIssue(issue, options));
  }

  async createIssue(options: { title: string; body: string; labels: string[]; repo?: string }): Promise<GitHubIssue> {
    let labels = options.labels;
    let result;
    while (!result) {
      try {
        result = await this.gh(createIssueArgs(options, labels), { noRetry: true });
      } catch (error) {
        const nextLabels = labelsAfterMissingLabelError(labels, error);
        if (nextLabels.length === labels.length) throw error;
        labels = nextLabels;
      }
    }
    const number = Number(result.stdout.match(/\/issues\/(\d+)/)?.[1]);
    if (!number) throw new Error(`Could not parse created issue URL: ${result.stdout.trim()}`);
    if (options.repo) {
      return {
        number,
        title: options.title,
        body: options.body,
        labels: labels.map((name) => ({ name })),
        createdAt: new Date().toISOString(),
        comments: [],
        url: result.stdout.trim().split(/\s+/).find((part) => part.startsWith('http')) ?? result.stdout.trim()
      };
    }
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
    expectedClosingIssueNumber: number;
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
    if (!number) throw new Error(`Could not parse created pull request URL: ${result.stdout.trim()}`);

    const prNumber = Number(number);
    const created = { url, number: prNumber };
    try {
      const defaultBranch = await this.getRepositoryDefaultBranch();
      if (!defaultBranch) throw new Error('Could not verify created pull request: repository default branch is unknown');

      const linkage = await this.getPullRequestLinkage(prNumber);
      validateCreatedPullRequest({
        linkage,
        defaultBranch,
        expectedClosingIssueNumber: options.expectedClosingIssueNumber
      });
      return { url: linkage.url || url, number: prNumber };
    } catch (error) {
      throw new CreatedPullRequestValidationError(created, error);
    }
  }

  private async gh(args: string[], options: { ignoreAlreadyExists?: boolean; ignoreMissingLabel?: boolean; noRetry?: boolean } = {}) {
    let lastError: unknown;
    const attempts = options.noRetry ? 1 : 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.run('gh', args, { cwd: this.cwd, env: githubCliEnv() });
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

export class CreatedPullRequestValidationError extends Error {
  constructor(
    readonly pr: PullRequestResult,
    readonly originalError: unknown
  ) {
    super(`Created pull request ${pr.url} failed readiness validation: ${errorMessage(originalError)}`);
    this.name = 'CreatedPullRequestValidationError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createIssueArgs(options: { title: string; body: string; repo?: string }, labels: string[]): string[] {
  const args = ['issue', 'create', '--title', options.title, '--body', options.body];
  if (labels.length > 0) args.push('--label', labels.join(','));
  if (options.repo) args.push('--repo', options.repo);
  return args;
}

function isMissingLabelError(error: unknown): boolean {
  const message = String(error);
  return /label/i.test(message) && /not found|does not exist|could not resolve|missing/i.test(message);
}

function labelsAfterMissingLabelError(labels: string[], error: unknown): string[] {
  if (labels.length === 0 || !isMissingLabelError(error)) return labels;
  const message = String(error).toLowerCase();
  const baseLabel = labels[0];
  const missingOptional = labels.slice(1).find((label) => message.includes(label.toLowerCase()));
  if (missingOptional) return labels.filter((label) => label !== missingOptional);
  if (baseLabel && labels.length > 1) return [baseLabel];
  return [];
}

function emptyResult(args: string[], cwd: string) {
  return { command: 'gh', args, cwd, exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
}

function normalizedTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function exactTitleSearch(title: string): string {
  return `in:title "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isEquivalentOpenIssue(issue: GitHubIssue, target: { title: string; body?: string }): boolean {
  const issueIsMonitor = isMonitorTitle(issue.title);
  const targetIsMonitor = isMonitorTitle(target.title);
  if (!issueIsMonitor || !targetIsMonitor) return false;

  const existingTokens = duplicateTokens(`${issue.title}\n${issue.body ?? ''}`);
  const targetTokens = duplicateTokens(`${target.title}\n${target.body ?? ''}`);
  const overlap = [...targetTokens].filter((token) => existingTokens.has(token));
  const smallerSetSize = Math.min(existingTokens.size, targetTokens.size);
  if (smallerSetSize === 0) return false;

  if (overlap.length >= 4) return true;
  return overlap.length >= 2 && overlap.includes('ci') && (targetTokens.has('pr') || targetTokens.has('workflow') || targetTokens.has('build'));
}

function isMonitorTitle(title: string): boolean {
  return /^\s*\[monitor\]/i.test(title);
}

function duplicateTokens(input: string): Set<string> {
  const normalized = input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/github actions?/g, ' ci ')
    .replace(/\bpull requests?\b/g, ' pr ')
    .replace(/\bprs?\b/g, ' pr ')
    .replace(/\bchecks?\b/g, ' ci ')
    .replace(/\bvalidation\b/g, ' ci ')
    .replace(/\bworkflows?\b/g, ' workflow ')
    .replace(/\btests?\b/g, ' test ');
  const stopwords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'the',
    'to',
    'with',
    'add',
    'baseline',
    'monitor',
    'observed',
    'recommended',
    'action',
    'affected',
    'repository',
    'repositories',
    'relevant',
    'links'
  ]);
  return new Set(
    normalized
      .match(/[a-z0-9][a-z0-9._-]*/g)
      ?.filter((token) => token.length > 1 && !stopwords.has(token)) ?? []
  );
}

function validateCreatedPullRequest(options: {
  linkage: GitHubPullRequestLinkage;
  defaultBranch: string;
  expectedClosingIssueNumber: number;
}): void {
  const { linkage, defaultBranch, expectedClosingIssueNumber } = options;
  const errors: string[] = [];
  if (linkage.baseRefName !== defaultBranch) {
    errors.push(`base branch is ${linkage.baseRefName || '<unknown>'}, expected repository default branch ${defaultBranch}`);
  }
  if (linkage.isDraft) errors.push('pull request is a draft');
  if (!linkage.closingIssuesReferences.some((issue) => issue.number === expectedClosingIssueNumber)) {
    errors.push(`closing issue reference #${expectedClosingIssueNumber} was not recognized by GitHub`);
  }
  if (errors.length > 0) {
    throw new Error(`Created pull request #${linkage.number} is not ready: ${errors.join('; ')}`);
  }
}

function colorForLabel(label: string): string {
  if (label.includes(':P0')) return 'b60205';
  if (label.includes(':P1')) return 'd93f0b';
  if (label.includes(':P2')) return 'fbca04';
  if (label.includes('ready')) return '0e8a16';
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
    'kaizen:ready': 'Approved for Kaizen Loop execution',
    'kaizen:direct': 'Allow direct commit when policy permits',
    'kaizen:pr-only': 'Force pull request reflection',
    'kaizen:in-progress': 'Currently being processed by Kaizen Loop',
    'kaizen:needs-human': 'Needs human input before retry',
    'kaizen:goal': 'Goal-linked iteration issue',
    'kaizen:agent:claude': 'Prefer Claude through builder-agent for this issue',
    'kaizen:agent:codex': 'Prefer Codex through builder-agent for this issue'
  };
  return descriptions[label] ?? 'Kaizen Loop label';
}
