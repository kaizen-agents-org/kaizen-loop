export interface RunIssueSummary {
  number: number;
  title: string;
  priority?: string;
  agent?: string;
  attempt?: number;
  outcome: 'pr-created' | 'failed' | 'blocked' | 'skipped';
  pr?: number;
  prUrl?: string;
  reason?: string;
  changedFiles?: number;
  changedLines?: number;
  verifyRetries?: number;
  durationMs?: number;
}

export interface RunSummary {
  version: 1;
  project: string;
  startedAt: string;
  finishedAt: string;
  trigger: 'manual' | 'scheduled';
  result: 'success' | 'failed' | 'partial';
  issues: RunIssueSummary[];
  skipped: Array<{ number: number; reason: string }>;
}
