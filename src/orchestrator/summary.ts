export interface RunDiscoveredFollowupSummary {
  title: string;
  repo: string;
  status: 'created' | 'duplicate';
  url?: string;
}

export interface RunIssueSummary {
  number: number;
  title: string;
  priority?: string;
  agent?: string;
  attempt?: number;
  outcome: 'direct-commit' | 'pr-created' | 'already-fixed' | 'failed' | 'blocked' | 'skipped' | 'infrastructure-failure';
  branch?: string;
  commit?: string;
  pr?: number;
  prUrl?: string;
  guardian?: {
    status: 'success' | 'failed' | 'skipped' | 'queued';
    summary: string;
    jobId?: string;
  };
  reason?: string;
  changedFiles?: number;
  changedLines?: number;
  verifyRetries?: number;
  durationMs?: number;
  discoveredFollowups?: RunDiscoveredFollowupSummary[];
}

export interface RunQueueSummary {
  backlogCount: number;
  eligibleCount: number;
  processedCount: number;
  skipReasons: Array<{ reason: string; count: number }>;
  health: {
    state: 'healthy' | 'idle' | 'degraded' | 'starved' | 'blocked';
    consecutiveZeroThroughputRuns: number;
    reasonCode?: 'run_failed' | 'trusted_github_cli_unavailable' | 'eligible_not_processed' | 'repeated_gate' | 'empty_queue';
    since?: string;
    warning?: string;
  };
}

export interface RunSummary {
  version: 1;
  project: string;
  startedAt: string;
  finishedAt: string;
  trigger: string;
  result: 'success' | 'failed' | 'partial';
  issues: RunIssueSummary[];
  skipped: Array<{ number: number; reason: string }>;
  queue?: RunQueueSummary;
}

export function summarizeQueue(options: {
  backlogCount: number;
  eligibleCount: number;
  processedCount: number;
  result: RunSummary['result'];
  skipped: Array<{ number: number; reason: string }>;
  previousSummaries: RunSummary[];
  starvationRuns: number;
  observedAt: string;
}): RunQueueSummary {
  const skipReasons = [...options.skipped
    .filter((item) => item.number > 0)
    .reduce((groups, item) => groups.set(item.reason, (groups.get(item.reason) ?? 0) + 1), new Map<string, number>())]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
  if (options.result === 'failed') {
    const failureReason = options.skipped.find((item) => item.number === 0)?.reason;
    return queueSummary(
      options,
      skipReasons,
      'blocked',
      options.processedCount === 0 ? 1 : 0,
      failureReason?.startsWith('Trusted GitHub CLI executable was not found')
        ? 'trusted_github_cli_unavailable'
        : 'run_failed',
      options.processedCount === 0 ? options.observedAt : undefined,
      failureReason
        ? `Queue blocked because the run failed: ${failureReason}`
        : 'Queue blocked because the run failed.'
    );
  }
  if (options.backlogCount === 0) {
    return queueSummary(options, skipReasons, 'idle', 0, 'empty_queue');
  }

  if (options.eligibleCount > 0 && options.processedCount === 0) {
    return queueSummary(
      options,
      skipReasons,
      'degraded',
      1,
      'eligible_not_processed',
      options.observedAt,
      `Queue degraded because ${options.eligibleCount} eligible issue(s) were not processed.`
    );
  }

  const gate = singleSkipGate(skipReasons, options.backlogCount);
  const fullySkippedByOneGate = options.eligibleCount === 0 &&
    options.processedCount === 0 &&
    gate !== undefined;
  if (!fullySkippedByOneGate) {
    return queueSummary(options, skipReasons, 'healthy', 0);
  }

  const previous = [...options.previousSummaries]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .at(0);
  const previousGate = previous?.queue
    ? singleSkipGate(previous.queue.skipReasons, previous.queue.backlogCount)
    : undefined;
  const repeatsPreviousGate = previous?.queue?.backlogCount !== 0 &&
    previous?.queue?.eligibleCount === 0 &&
    previous?.queue?.processedCount === 0 &&
    previousGate === gate;
  const consecutive = repeatsPreviousGate
    ? previous!.queue!.health.consecutiveZeroThroughputRuns + 1
    : 1;
  const since = repeatsPreviousGate
    ? previous!.queue!.health.since ?? previous!.startedAt
    : options.observedAt;
  const state = consecutive >= options.starvationRuns ? 'starved' : 'degraded';
  const displayedReason = skipReasons.length === 1 ? skipReasons[0].reason : gate;
  return queueSummary(
    options,
    skipReasons,
    state,
    consecutive,
    'repeated_gate',
    since,
    state === 'starved'
      ? `Queue starvation: ${options.backlogCount} backlog issue(s) skipped by "${displayedReason}" for ${consecutive} consecutive run(s).`
      : undefined
  );
}

function singleSkipGate(skipReasons: RunQueueSummary['skipReasons'], backlogCount: number): string | undefined {
  if (skipReasons.length === 0 || skipReasons.reduce((total, item) => total + item.count, 0) !== backlogCount) {
    return undefined;
  }
  const gate = normalizeSkipReason(skipReasons[0].reason);
  return skipReasons.every((item) => normalizeSkipReason(item.reason) === gate) ? gate : undefined;
}

function normalizeSkipReason(reason: string): string {
  if (reason.startsWith('open pull request limit ')) return 'open pull request limit';
  if (reason.startsWith('generated pull request WIP limit reached ')) return 'generated pull request WIP limit reached';
  const detailSeparator = reason.indexOf(': ');
  return detailSeparator === -1 ? reason : reason.slice(0, detailSeparator);
}

function queueSummary(
  options: Pick<RunQueueSummary, 'backlogCount' | 'eligibleCount' | 'processedCount'>,
  skipReasons: RunQueueSummary['skipReasons'],
  state: RunQueueSummary['health']['state'],
  consecutiveZeroThroughputRuns: number,
  reasonCode?: RunQueueSummary['health']['reasonCode'],
  since?: string,
  warning?: string
): RunQueueSummary {
  return {
    backlogCount: options.backlogCount,
    eligibleCount: options.eligibleCount,
    processedCount: options.processedCount,
    skipReasons,
    health: { state, consecutiveZeroThroughputRuns, reasonCode, since, warning }
  };
}
