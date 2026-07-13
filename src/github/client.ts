import { setTimeout as sleep } from 'node:timers/promises';
import { githubCliEnv, type CommandRunner } from '../utils/command.js';
import {
  buildDiscoveredIssueFingerprint,
  extractEvidence,
  hasDiscoveredIssueFingerprint,
  hasDiscoveredIssueMarker,
  parseFailureClass
} from '../discovered-issue-fingerprint.js';
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestDetails,
  GitHubPullRequestLinkage,
  GitHubPullRequestResolution,
  PullRequestResult
} from './types.js';

export const KAIZEN_LABELS = [
  'kaizen',
  'kaizen:P0',
  'kaizen:P1',
  'kaizen:P2',
  'kaizen:ready',
  'kaizen:authorized',
  'kaizen:direct',
  'kaizen:pr-only',
  'kaizen:in-progress',
  'kaizen:needs-human',
  'kaizen:goal',
  'kaizen:agent:claude',
  'kaizen:agent:codex'
];

export type RepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin';

export interface ExecutionAuthorization {
  authorized: boolean;
  actor?: string;
  permission?: RepositoryPermission;
  reason: string;
}

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

  async checkExecutionAuthorization(options: {
    repo: string;
    issue: number;
    label: string;
    minimumPermission: Exclude<RepositoryPermission, 'none' | 'read'>;
  }): Promise<ExecutionAuthorization> {
    const currentIssue = await this.getIssue(options.issue);
    const normalizedLabel = options.label.toLowerCase();
    if (!currentIssue.labels.some((label) => label.name.toLowerCase() === normalizedLabel)) {
      return { authorized: false, reason: `execution authorization label is not active: ${options.label}` };
    }

    const eventsResult = await this.gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${options.repo}/issues/${options.issue}/events`
    ]);
    const pages = JSON.parse(eventsResult.stdout || '[]') as Array<Array<{
      event?: string;
      actor?: { login?: string };
      label?: { name?: string };
    }>>;
    const transition = pages
      .flat()
      .filter((item) =>
        (item.event === 'labeled' || item.event === 'unlabeled')
        && item.label?.name?.toLowerCase() === normalizedLabel
      )
      .at(-1);
    const actor = transition?.actor?.login;
    if (transition?.event !== 'labeled' || !actor) {
      return { authorized: false, reason: `qualifying authorization label event not found: ${options.label}` };
    }

    const permissionResult = await this.gh(['api', `repos/${options.repo}/collaborators/${actor}/permission`]);
    const payload = JSON.parse(permissionResult.stdout || '{}') as {
      permission?: string;
      role_name?: string;
      user?: { permissions?: Record<string, boolean> };
    };
    const permission = repositoryPermission(payload);
    const authorized = permissionRank(permission) >= permissionRank(options.minimumPermission);
    return {
      authorized,
      actor,
      permission,
      reason: authorized
        ? `authorized by ${actor} (${permission})`
        : `authorization label was applied by ${actor} with insufficient permission: ${permission}`
    };
  }

  async listOpenPullRequests(limit = 100): Promise<GitHubPullRequest[]> {
    const result = await this.gh([
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,headRefName,headRepositoryOwner,createdAt,url,isDraft',
      '--limit',
      String(limit)
    ]);
    return JSON.parse(result.stdout || '[]') as GitHubPullRequest[];
  }

  async searchOpenPullRequestsForOwner(owner: string, limit = 1000): Promise<GitHubPullRequest[]> {
    const pullRequests: GitHubPullRequest[] = [];
    let cursor: string | undefined;

    while (pullRequests.length < limit) {
      const pageLimit = Math.min(100, limit - pullRequests.length);
      const result = await this.gh(searchOpenPullRequestsForOwnerArgs(owner, pageLimit, cursor));
      const page = parseOwnerPullRequestSearchPage(result.stdout);
      pullRequests.push(...page.pullRequests);
      if (!page.hasNextPage || !page.endCursor) break;
      cursor = page.endCursor;
    }

    return pullRequests;
  }

  async getPullRequest(number: number): Promise<GitHubPullRequestDetails> {
    const result = await this.gh([
      'pr',
      'view',
      String(number),
      '--json',
      'number,headRefName,headRepositoryOwner,url,baseRefName,headRefOid,isDraft,state'
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

  async getPullRequestResolution(number: number): Promise<GitHubPullRequestResolution> {
    const result = await this.gh([
      'pr',
      'view',
      String(number),
      '--json',
      'number,url,state,mergedAt,baseRefName,closingIssuesReferences'
    ]);
    return JSON.parse(result.stdout) as GitHubPullRequestResolution;
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

  async findOpenIssueByTitle(options: {
    repo?: string;
    title: string;
    body?: string;
    evidence?: string;
    failureClass?: string;
  }): Promise<GitHubIssue | undefined> {
    const fingerprint = buildDiscoveredIssueFingerprint(options);
    if (fingerprint) {
      const markerArgs = openIssueListArgs(options.repo, '1000', fingerprint.searchTerm);
      const markerResult = await this.gh(markerArgs);
      const markerIssues = JSON.parse(markerResult.stdout || '[]') as GitHubIssue[];
      const markerMatch = markerIssues.find((issue) => hasDiscoveredIssueFingerprint(issue.body, fingerprint.marker));
      if (markerMatch) return markerMatch;
    }

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
      '1000'
    ];
    if (options.repo) exactArgs.push('--repo', options.repo);
    const exactResult = await this.gh(exactArgs);
    const exactIssues = JSON.parse(exactResult.stdout || '[]') as GitHubIssue[];
    const exactMatch = exactIssues.find((issue) => normalizedTitle(issue.title) === normalizedTitle(options.title));
    if (exactMatch) return exactMatch;

    const args = openIssueListArgs(options.repo, '1000');
    const result = await this.gh(args);
    const issues = JSON.parse(result.stdout || '[]') as GitHubIssue[];
    return (fingerprint && issues.find((issue) => hasDiscoveredIssueFingerprint(issue.body, fingerprint.marker)))
      ?? issues.find((issue) => isEquivalentLegacyEvidence(issue, fingerprint))
      ?? issues.find((issue) => isEquivalentOpenIssue(issue, options));
  }

  async findOpenIssueByBodyMarker(marker: string): Promise<GitHubIssue | undefined> {
    return (await this.findOpenIssuesByBodyMarker(marker))[0];
  }

  async findOpenIssuesByBodyMarker(marker: string): Promise<GitHubIssue[]> {
    const goalId = marker.match(/"goalId":"([^"]+)"/)?.[1];
    if (!goalId) throw new Error('Goal issue marker does not contain a searchable goalId.');
    const result = await this.gh([
      'issue', 'list', '--state', 'open', '--json', 'number,title,body,labels,createdAt,comments,url',
      '--search', `${goalId} in:body`, '--limit', '100'
    ]);
    const issues = JSON.parse(result.stdout || '[]') as GitHubIssue[];
    return issues.filter((issue) => issue.body?.includes(marker)).sort((left, right) => left.number - right.number);
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
    draft?: boolean;
  }): Promise<PullRequestResult> {
    const args = [
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
    ];
    if (options.draft) args.push('--draft');
    const result = await this.gh(args);
    const url = result.stdout.trim().split(/\s+/).find((part) => part.startsWith('http')) ?? result.stdout.trim();
    const number = url.match(/\/pull\/(\d+)/)?.[1];
    if (!number) throw new Error(`Could not parse created pull request URL: ${result.stdout.trim()}`);

    const prNumber = Number(number);
    const created = { url, number: prNumber };
    try {
      const defaultBranch = await this.getRepositoryDefaultBranch();
      if (!defaultBranch) throw new Error('Could not verify created pull request: repository default branch is unknown');

      const linkage = await this.waitForCreatedPullRequestLinkage({
        number: prNumber,
        defaultBranch,
        expectedClosingIssueNumber: options.expectedClosingIssueNumber,
        allowDraft: Boolean(options.draft)
      });
      return { url: linkage.url || url, number: prNumber };
    } catch (error) {
      throw new CreatedPullRequestValidationError(created, error);
    }
  }

  private async waitForCreatedPullRequestLinkage(options: {
    number: number;
    defaultBranch: string;
    expectedClosingIssueNumber: number;
    allowDraft: boolean;
  }): Promise<GitHubPullRequestLinkage> {
    const attempts = 5;
    let linkage = await this.getPullRequestLinkage(options.number);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      validateCreatedPullRequestStructure(linkage, options.defaultBranch, options.allowDraft);
      if (linkage.closingIssuesReferences.some((issue) => issue.number === options.expectedClosingIssueNumber)) {
        return linkage;
      }
      if (attempt < attempts) {
        await sleep(250 * 2 ** (attempt - 1));
        linkage = await this.getPullRequestLinkage(options.number);
      }
    }
    const observed = linkage.closingIssuesReferences.map((issue) => `#${issue.number}`).join(', ') || 'none';
    throw new Error(
      `Created pull request #${linkage.number} is not ready: closing issue reference #${options.expectedClosingIssueNumber} ` +
        `was not recognized by GitHub after ${attempts} attempts (observed: ${observed})`
    );
  }

  async editPullRequest(number: number, options: { title: string; body: string }): Promise<void> {
    await this.gh(['pr', 'edit', String(number), '--title', options.title, '--body', options.body]);
  }

  async markPullRequestReady(number: number): Promise<void> {
    await this.gh(['pr', 'ready', String(number)]);
  }

  async markPullRequestDraft(number: number): Promise<void> {
    await this.gh(['pr', 'ready', String(number), '--undo']);
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

const OWNER_PULL_REQUEST_SEARCH_QUERY = `
query($searchQuery: String!, $limit: Int!, $cursor: String) {
  search(query: $searchQuery, type: ISSUE, first: $limit, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        headRefName
        createdAt
        url
        author {
          login
          __typename
        }
        repository {
          nameWithOwner
        }
      }
    }
  }
}`;

function searchOpenPullRequestsForOwnerArgs(owner: string, limit: number, cursor?: string): string[] {
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${OWNER_PULL_REQUEST_SEARCH_QUERY}`,
    '-F',
    `searchQuery=is:pr is:open owner:${owner}`,
    '-F',
    `limit=${limit}`
  ];
  if (cursor) args.push('-F', `cursor=${cursor}`);
  return args;
}

function parseOwnerPullRequestSearchPage(stdout: string): {
  pullRequests: GitHubPullRequest[];
  hasNextPage: boolean;
  endCursor?: string;
} {
  const payload = JSON.parse(stdout || '{}') as {
    data?: {
      search?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{
          number?: number;
          headRefName?: string;
          createdAt?: string;
          url?: string;
          author?: { login?: string; __typename?: string };
          repository?: { nameWithOwner?: string };
        } | null>;
      };
    };
  };
  const search = payload.data?.search;
  return {
    pullRequests:
      search?.nodes
        ?.filter((node): node is NonNullable<typeof node> => Boolean(node?.number && node.url))
        .map((node) => ({
          number: node.number as number,
          headRefName: node.headRefName,
          createdAt: node.createdAt,
          url: node.url as string,
          author: node.author
            ? {
                login: node.author.login,
                type: node.author.__typename
              }
            : undefined,
          repository: node.repository
        })) ?? [],
    hasNextPage: Boolean(search?.pageInfo?.hasNextPage),
    endCursor: search?.pageInfo?.endCursor ?? undefined
  };
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

function openIssueListArgs(repo: string | undefined, limit: string, search?: string): string[] {
  const args = [
    'issue', 'list',
    '--state', 'open',
    '--json', 'number,title,body,labels,createdAt,comments,url',
    '--limit', limit
  ];
  if (repo) args.push('--repo', repo);
  if (search) args.push('--search', search);
  return args;
}

function isEquivalentLegacyEvidence(
  issue: GitHubIssue,
  target: ReturnType<typeof buildDiscoveredIssueFingerprint>
): boolean {
  if (!target?.failureClass || hasDiscoveredIssueMarker(issue.body)) return false;
  const evidence = extractEvidence(issue.body);
  const candidateFailureClass = parseFailureClass(evidence ?? issue.body);
  if (!candidateFailureClass || candidateFailureClass !== target.failureClass) return false;
  const candidate = buildDiscoveredIssueFingerprint({
    repo: 'legacy-comparison',
    evidence,
    failureClass: candidateFailureClass
  });
  return candidate?.normalizedEvidence === target.normalizedEvidence;
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

function validateCreatedPullRequestStructure(
  linkage: GitHubPullRequestLinkage,
  defaultBranch: string,
  allowDraft: boolean
): void {
  const errors: string[] = [];
  if (linkage.baseRefName !== defaultBranch) {
    errors.push(`base branch is ${linkage.baseRefName || '<unknown>'}, expected repository default branch ${defaultBranch}`);
  }
  if (allowDraft && !linkage.isDraft) errors.push('pull request was expected to be a draft');
  if (linkage.isDraft && !allowDraft) errors.push('pull request is a draft');
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
    'kaizen:authorized': 'Execution authorized by a repository maintainer',
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

function repositoryPermission(payload: {
  permission?: string;
  role_name?: string;
  user?: { permissions?: Record<string, boolean> };
}): RepositoryPermission {
  const permissions = payload.user?.permissions;
  if (permissions?.admin) return 'admin';
  if (permissions?.maintain) return 'maintain';
  if (permissions?.push) return 'write';
  if (permissions?.triage) return 'triage';
  const role = payload.role_name ?? payload.permission;
  return role === 'read' || role === 'triage' || role === 'write' || role === 'maintain' || role === 'admin'
    ? role
    : 'none';
}

function permissionRank(permission: RepositoryPermission): number {
  return ['none', 'read', 'triage', 'write', 'maintain', 'admin'].indexOf(permission);
}
