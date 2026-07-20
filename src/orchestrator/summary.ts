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
  outcome: 'direct-commit' | 'pr-created' | 'failed' | 'blocked' | 'skipped' | 'infrastructure-failure';
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
    state: 'healthy' | 'idle' | 'degraded' | 'starved';
    consecutiveZeroThroughputRuns: number;
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
  if (options.backlogCount === 0) {
    return queueSummary(options, skipReasons, 'idle', 0);
  }

  const fullySkippedByOneGate = options.eligibleCount === 0 &&
    options.processedCount === 0 &&
    skipReasons.length === 1 &&
    skipReasons[0].count === options.backlogCount;
  if (!fullySkippedByOneGate) {
    return queueSummary(options, skipReasons, 'healthy', 0);
  }

  const reason = skipReasons[0].reason;
  const previous = [...options.previousSummaries]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .at(0);
  const repeatsPreviousGate = previous?.queue?.backlogCount !== 0 &&
    previous?.queue?.eligibleCount === 0 &&
    previous.queue.processedCount === 0 &&
    previous.queue.skipReasons.length === 1 &&
    previous.queue.skipReasons[0].reason === reason;
  const consecutive = repeatsPreviousGate
    ? previous!.queue!.health.consecutiveZeroThroughputRuns + 1
    : 1;
  const since = repeatsPreviousGate
    ? previous!.queue!.health.since ?? previous!.startedAt
    : options.observedAt;
  const state = consecutive >= options.starvationRuns ? 'starved' : 'degraded';
  return queueSummary(
    options,
    skipReasons,
    state,
    consecutive,
    since,
    state === 'starved'
      ? `Queue starvation: ${options.backlogCount} backlog issue(s) skipped by "${reason}" for ${consecutive} consecutive run(s).`
      : undefined
  );
}

function queueSummary(
  options: Pick<RunQueueSummary, 'backlogCount' | 'eligibleCount' | 'processedCount'>,
  skipReasons: RunQueueSummary['skipReasons'],
  state: RunQueueSummary['health']['state'],
  consecutiveZeroThroughputRuns: number,
  since?: string,
  warning?: string
): RunQueueSummary {
  return {
    backlogCount: options.backlogCount,
    eligibleCount: options.eligibleCount,
    processedCount: options.processedCount,
    skipReasons,
    health: { state, consecutiveZeroThroughputRuns, since, warning }
  };
}
