export interface RunIssueSummary {
  number: number;
  title: string;
  priority?: string;
  agent?: string;
  attempt?: number;
  outcome: 'direct-commit' | 'pr-created' | 'failed' | 'blocked' | 'skipped';
  commit?: string;
  pr?: number;
  prUrl?: string;
  guardian?: {
    status: 'success' | 'failed' | 'skipped';
    summary: string;
  };
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
  trigger: 'manual' | 'scheduled' | 'instant' | 'watch';
  result: 'success' | 'failed' | 'partial';
  issues: RunIssueSummary[];
  skipped: Array<{ number: number; reason: string }>;
}
