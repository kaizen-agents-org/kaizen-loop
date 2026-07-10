import type { KaizenConfig } from '../config/schema.js';
import type { GitHubIssue, GitHubPullRequest } from '../github/types.js';
import { countAttempts, hasPendingPullRequest, hasRetryableExternalBlock } from '../report/comments.js';

export interface IssueSelection {
  selected: GitHubIssue[];
  skipped: Array<{ number: number; reason: string }>;
}

export function selectIssues(options: {
  issues: GitHubIssue[];
  config: KaizenConfig;
  maxIssues: number;
  onlyIssue?: number;
  explicit?: boolean;
  openPullRequests?: GitHubPullRequest[];
  now?: Date;
}): IssueSelection {
  const now = options.now ?? new Date();
  const skipped: Array<{ number: number; reason: string }> = [];
  const candidates = options.issues.filter((issue) => {
    if (options.onlyIssue && issue.number !== options.onlyIssue) return false;

    const labels = labelNames(issue);
    if (!labels.includes(options.config.issues.label)) {
      skipped.push({ number: issue.number, reason: `missing required label: ${options.config.issues.label}` });
      return false;
    }

    if (!options.explicit && options.config.issues.selection.mode === 'manual-only') {
      skipped.push({ number: issue.number, reason: 'manual-only selection mode' });
      return false;
    }

    if (
      !options.explicit &&
      options.config.issues.selection.mode === 'opt-in' &&
      !labels.includes(options.config.issues.selection.includeLabel)
    ) {
      skipped.push({ number: issue.number, reason: `missing selection label: ${options.config.issues.selection.includeLabel}` });
      return false;
    }

    const retryableExternalBlock = hasRetryableExternalBlock(issue.comments ?? []);
    const excludedLabel = options.config.issues.selection.excludeLabels.find(
      (label) => labels.includes(label) && !(label === 'kaizen:needs-human' && retryableExternalBlock)
    );
    if (excludedLabel) {
      skipped.push({ number: issue.number, reason: excludedLabel === 'kaizen:needs-human' ? 'needs-human' : `excluded label: ${excludedLabel}` });
      return false;
    }

    if (hasActiveInProgress(issue, now)) {
      skipped.push({ number: issue.number, reason: 'in-progress' });
      return false;
    }

    if (!options.explicit && hasPendingPullRequest(issue.comments ?? [], options.openPullRequests)) {
      skipped.push({ number: issue.number, reason: 'pending pull request' });
      return false;
    }

    const attempts = countAttempts(issue.comments ?? []);
    if (attempts >= options.config.run.maxAttemptsPerIssue) {
      skipped.push({ number: issue.number, reason: 'max attempts reached' });
      return false;
    }

    return true;
  });

  const sorted = candidates.sort((a, b) => {
    const priority = priorityRank(a, options.config) - priorityRank(b, options.config);
    if (priority !== 0) return priority;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });

  const selected = sorted.slice(0, options.maxIssues);
  for (const issue of sorted.slice(options.maxIssues)) {
    skipped.push({ number: issue.number, reason: 'maxIssuesPerNight reached' });
  }

  return { selected, skipped };
}

export function labelNames(issue: GitHubIssue): string[] {
  return (issue.labels ?? []).map((label) => label.name);
}

export function priorityLabel(issue: GitHubIssue, config: KaizenConfig): string | undefined {
  const labels = labelNames(issue);
  return config.issues.priorityOrder.find((label) => labels.includes(label));
}

function priorityRank(issue: GitHubIssue, config: KaizenConfig): number {
  const label = priorityLabel(issue, config);
  return label ? config.issues.priorityOrder.indexOf(label) : config.issues.priorityOrder.length;
}

function hasActiveInProgress(issue: GitHubIssue, now: Date): boolean {
  const label = issue.labels.find((item) => item.name === 'kaizen:in-progress');
  if (!label) return false;
  if (!label.createdAt) return true;
  const ageMs = now.getTime() - Date.parse(label.createdAt);
  return ageMs < 24 * 60 * 60 * 1000;
}
