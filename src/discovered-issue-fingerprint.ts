import { createHash } from 'node:crypto';

const MARKER_PREFIX = 'kaizen-loop:discovered-issue:v1';

export interface DiscoveredIssueFingerprint {
  marker: string;
  searchTerm: string;
  normalizedEvidence: string;
  failureClass?: string;
}

export function buildDiscoveredIssueFingerprint(options: {
  repo?: string;
  evidence?: string;
  failureClass?: string;
}): DiscoveredIssueFingerprint | undefined {
  if (!options.repo) return undefined;
  const failureClass = normalizeFailureClass(options.failureClass ?? parseFailureClass(options.evidence));
  const normalizedEvidence = normalizeEvidence(stripFailureClass(options.evidence ?? ''));
  if (!isSubstantiveEvidence(normalizedEvidence)) return undefined;

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

export function parseFailureClass(input?: string): string | undefined {
  return normalizeFailureClass(input?.match(/\bfailureClass\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i)?.[1]);
}

export function normalizeEvidence(input: string): string {
  return input.replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

export function extractEvidence(body?: string): string | undefined {
  if (!body) return undefined;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^##\s+Evidence\s*$/i.test(line.trim()));
  if (start < 0) return undefined;
  let fenced = false;
  const evidence: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s+/.test(line)) break;
    evidence.push(line);
  }
  return evidence.join('\n').trim();
}

export function hasDiscoveredIssueMarker(body?: string): boolean {
  return Boolean(body?.match(discoveredIssueMarkerPattern()));
}

export function hasDiscoveredIssueFingerprint(body: string | undefined, marker: string): boolean {
  return [...(body?.matchAll(discoveredIssueMarkerPattern()) ?? [])]
    .some((match) => match[0] === marker);
}

function discoveredIssueMarkerPattern(): RegExp {
  return new RegExp(`<!-- ${MARKER_PREFIX} fingerprint=[a-f0-9]{64} -->`, 'g');
}

function normalizeFailureClass(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function stripFailureClass(input: string): string {
  return input.replace(/\bfailureClass\s*[:=]\s*["']?[a-zA-Z0-9._-]+["']?\s*[;,]?/gi, ' ');
}

function isSubstantiveEvidence(normalized: string): boolean {
  if (normalized.length < 24) return false;
  const generic = /^(?:error|failed|failure|unknown|none|n\/a|no additional evidence(?: was provided by the builder agent)?\.?|existing issue|see logs?|investigate)\.?$/i;
  if (generic.test(normalized)) return false;
  return (normalized.match(/[a-z0-9][a-z0-9._:/=-]*/gi) ?? []).length >= 3;
}
