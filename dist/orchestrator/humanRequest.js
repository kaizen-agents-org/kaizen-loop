import { createHash } from 'node:crypto';
import { applyIssueDisposition } from './disposition.js';
const HUMAN_REQUEST_VERSION = 1;
const HUMAN_REQUEST_LABEL = 'kaizen:needs-human';
export async function ensureHumanRequest(options) {
    if (await acknowledgeRemovedRequest(options))
        return 'acknowledged';
    const existing = latestHumanRequestRecord(options.issue, options.request);
    if (existing?.state !== 'pending') {
        await options.github.comment(options.issue.number, buildHumanRequestComment(options.request, options.runId, 'pending'));
    }
    if (await acknowledgeRemovedRequest(options))
        return 'acknowledged';
    await applyIssueDisposition(options.github, options.issue.number, 'human-input-required');
    if (await acknowledgeRemovedRequest(options))
        return 'acknowledged';
    return 'pending';
}
async function acknowledgeRemovedRequest(options) {
    const issue = await options.github.getIssue(options.issue.number);
    const events = await options.github.getIssueLabelEvents(options.repo, options.issue.number, HUMAN_REQUEST_LABEL);
    if (!humanRequestWasAcknowledged({ issue, request: options.request, labelEvents: events }))
        return false;
    if (latestHumanRequestRecord(issue, options.request)?.state !== 'acknowledged') {
        await options.github.comment(options.issue.number, buildHumanRequestComment(options.request, options.runId, 'acknowledged'));
    }
    if (issue.labels.some((label) => label.name.toLowerCase() === HUMAN_REQUEST_LABEL)) {
        await options.github.removeLabels(options.issue.number, [HUMAN_REQUEST_LABEL]);
    }
    return true;
}
export function humanRequestFingerprint(request) {
    const semanticInput = `${request.reasonCode}\n${request.requestKey}`;
    return createHash('sha256').update(`v${HUMAN_REQUEST_VERSION}\n${semanticInput}`).digest('hex');
}
export function buildHumanRequestComment(request, runId, state = 'pending') {
    const fingerprint = humanRequestFingerprint(request);
    const marker = {
        version: HUMAN_REQUEST_VERSION,
        id: fingerprint.slice(0, 16),
        fingerprint,
        state,
        reasonCode: request.reasonCode,
        requestKey: request.requestKey,
        question: request.question.trim(),
        run: runId
    };
    const encoded = JSON.stringify(marker)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/--/g, '\\u002d\\u002d');
    const heading = state === 'pending'
        ? '## Kaizen Loop human confirmation required'
        : `## Kaizen Loop human confirmation ${state}`;
    return `<!-- kaizen-loop:human-request ${encoded} -->\n\n${heading}\n\n${request.question.trim()}`;
}
export function latestHumanRequestRecord(issue, request) {
    const fingerprint = humanRequestFingerprint(request);
    return humanRequestRecords(issue).find((marker) => marker.fingerprint === fingerprint);
}
function humanRequestRecords(issue) {
    const records = [...(issue.comments ?? [])]
        .reverse()
        .map((comment) => {
        const marker = parseHumanRequestMarker(comment.body);
        return marker ? { ...marker, createdAt: comment.createdAt } : undefined;
    })
        .filter((marker) => marker !== undefined);
    return records;
}
export function humanRequestWasAcknowledged(options) {
    const fingerprint = humanRequestFingerprint(options.request);
    const record = humanRequestRecords(options.issue).find((marker) => marker.fingerprint === fingerprint && marker.state === 'pending');
    if (!record)
        return false;
    if (!record.createdAt)
        return false;
    const appliedIndex = options.labelEvents.findIndex((event) => event.event === 'labeled' && Date.parse(event.createdAt) >= Date.parse(record.createdAt));
    if (appliedIndex < 0)
        return false;
    return options.labelEvents.slice(appliedIndex + 1).some((event) => event.event === 'unlabeled');
}
function parseHumanRequestMarker(body) {
    const match = body.match(/<!--\s*kaizen-loop:human-request\s+([\s\S]*?)\s*-->/);
    if (!match)
        return undefined;
    try {
        const marker = JSON.parse(match[1].trim());
        if (marker.version !== HUMAN_REQUEST_VERSION ||
            typeof marker.id !== 'string' ||
            typeof marker.fingerprint !== 'string' ||
            !['pending', 'acknowledged'].includes(String(marker.state)) ||
            typeof marker.reasonCode !== 'string' ||
            typeof marker.requestKey !== 'string' ||
            typeof marker.question !== 'string' ||
            typeof marker.run !== 'string')
            return undefined;
        return marker;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=humanRequest.js.map