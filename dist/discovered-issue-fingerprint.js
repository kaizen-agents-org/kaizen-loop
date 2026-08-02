import { createHash } from 'node:crypto';
const MARKER_PREFIX = 'kaizen-loop:discovered-issue:v1';
export function buildDiscoveredIssueFingerprint(options) {
    if (!options.repo)
        return undefined;
    const failureClass = normalizeFailureClass(options.failureClass ?? parseFailureClass(options.evidence));
    const normalizedEvidence = normalizeEvidence(stripFailureClass(options.evidence ?? ''));
    if (!isSubstantiveEvidence(normalizedEvidence))
        return undefined;
    const digest = createHash('sha256')
        .update(JSON.stringify({ version: 1, repo: options.repo.toLowerCase(), evidence: normalizedEvidence, failureClass: failureClass ?? null }))
        .digest('hex');
    return {
        marker: `<!-- ${MARKER_PREFIX} fingerprint=${digest} -->`,
        searchTerm: `${MARKER_PREFIX} ${digest}`,
        normalizedEvidence,
        failureClass
    };
}
export function parseFailureClass(input) {
    return normalizeFailureClass(input?.match(/\bfailureClass\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i)?.[1]);
}
export function normalizeEvidence(input) {
    return input.replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}
export function extractEvidence(body) {
    if (!body)
        return undefined;
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex((line) => /^##\s+Evidence\s*$/i.test(line.trim()));
    if (start < 0)
        return undefined;
    let fenced = false;
    const evidence = [];
    for (const line of lines.slice(start + 1)) {
        if (/^\s*(```|~~~)/.test(line))
            fenced = !fenced;
        if (!fenced && /^#{1,2}\s+/.test(line))
            break;
        evidence.push(line);
    }
    return evidence.join('\n').trim();
}
export function hasDiscoveredIssueMarker(body) {
    return Boolean(body?.match(discoveredIssueMarkerPattern()));
}
export function hasDiscoveredIssueFingerprint(body, marker) {
    return [...(body?.matchAll(discoveredIssueMarkerPattern()) ?? [])]
        .some((match) => match[0] === marker);
}
function discoveredIssueMarkerPattern() {
    return new RegExp(`<!-- ${MARKER_PREFIX} fingerprint=[a-f0-9]{64} -->`, 'g');
}
function normalizeFailureClass(value) {
    const normalized = value?.trim().toLowerCase();
    return normalized || undefined;
}
function stripFailureClass(input) {
    return input.replace(/\bfailureClass\s*[:=]\s*["']?[a-zA-Z0-9._-]+["']?\s*[;,]?/gi, ' ');
}
function isSubstantiveEvidence(normalized) {
    if (normalized.length < 24)
        return false;
    const generic = /^(?:error|failed|failure|unknown|none|n\/a|no additional evidence(?: was provided by the builder agent)?\.?|existing issue|see logs?|investigate)\.?$/i;
    if (generic.test(normalized))
        return false;
    return (normalized.match(/[a-z0-9][a-z0-9._:/=-]*/gi) ?? []).length >= 3;
}
//# sourceMappingURL=discovered-issue-fingerprint.js.map