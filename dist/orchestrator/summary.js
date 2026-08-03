export function summarizeQueue(options) {
    const skipReasons = [...options.skipped
            .filter((item) => item.number > 0)
            .reduce((groups, item) => groups.set(item.reason, (groups.get(item.reason) ?? 0) + 1), new Map())]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
    if (options.result === 'failed') {
        const failureReason = options.skipped.find((item) => item.number === 0)?.reason;
        return queueSummary(options, skipReasons, 'blocked', options.processedCount === 0 ? 1 : 0, options.processedCount === 0 ? options.observedAt : undefined, failureReason
            ? `Queue blocked because the run failed: ${failureReason}`
            : 'Queue blocked because the run failed.');
    }
    if (options.backlogCount === 0) {
        return queueSummary(options, skipReasons, 'idle', 0);
    }
    if (options.eligibleCount > 0 && options.processedCount === 0) {
        return queueSummary(options, skipReasons, 'degraded', 1, options.observedAt, `Queue degraded because ${options.eligibleCount} eligible issue(s) were not processed.`);
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
        ? previous.queue.health.consecutiveZeroThroughputRuns + 1
        : 1;
    const since = repeatsPreviousGate
        ? previous.queue.health.since ?? previous.startedAt
        : options.observedAt;
    const state = consecutive >= options.starvationRuns ? 'starved' : 'degraded';
    const displayedReason = skipReasons.length === 1 ? skipReasons[0].reason : gate;
    return queueSummary(options, skipReasons, state, consecutive, since, state === 'starved'
        ? `Queue starvation: ${options.backlogCount} backlog issue(s) skipped by "${displayedReason}" for ${consecutive} consecutive run(s).`
        : undefined);
}
function singleSkipGate(skipReasons, backlogCount) {
    if (skipReasons.length === 0 || skipReasons.reduce((total, item) => total + item.count, 0) !== backlogCount) {
        return undefined;
    }
    const gate = normalizeSkipReason(skipReasons[0].reason);
    return skipReasons.every((item) => normalizeSkipReason(item.reason) === gate) ? gate : undefined;
}
function normalizeSkipReason(reason) {
    if (reason.startsWith('open pull request limit '))
        return 'open pull request limit';
    if (reason.startsWith('generated pull request WIP limit reached '))
        return 'generated pull request WIP limit reached';
    const detailSeparator = reason.indexOf(': ');
    return detailSeparator === -1 ? reason : reason.slice(0, detailSeparator);
}
function queueSummary(options, skipReasons, state, consecutiveZeroThroughputRuns, since, warning) {
    return {
        backlogCount: options.backlogCount,
        eligibleCount: options.eligibleCount,
        processedCount: options.processedCount,
        skipReasons,
        health: { state, consecutiveZeroThroughputRuns, since, warning }
    };
}
//# sourceMappingURL=summary.js.map