import { describe, expect, it, vi } from 'vitest';
import type { HumanRequest } from '../src/agents/types.js';
import type { GitHubIssue } from '../src/github/types.js';
import {
  buildHumanRequestComment,
  ensureHumanRequest,
  humanRequestFingerprint,
  humanRequestWasAcknowledged,
  latestHumanRequestRecord
} from '../src/orchestrator/humanRequest.js';

const request: HumanRequest = {
  reasonCode: 'credentials',
  requestKey: 'production-credential-use',
  question: 'Approve using the production credential?'
};

describe('human request protocol', () => {
  it('builds a versioned stable request marker', () => {
    const body = buildHumanRequestComment(request, 'run-1');
    expect(body).toContain('kaizen-loop:human-request');
    expect(body).toContain('"version":1');
    expect(body).toContain(`"fingerprint":"${humanRequestFingerprint(request)}"`);
    expect(body).toContain('"state":"pending"');
  });

  it('acknowledges only a removal after the exact pending request was labeled', () => {
    const issue = issueWithRequest('pending');
    const events = [
      { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:01Z' },
      { event: 'unlabeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:01:00Z' }
    ];
    expect(humanRequestWasAcknowledged({ issue, request, labelEvents: events })).toBe(true);
    expect(humanRequestWasAcknowledged({ issue, request, labelEvents: events.slice(0, 1) })).toBe(false);
  });

  it('does not treat marker-only or legacy comments as acknowledgement', () => {
    expect(humanRequestWasAcknowledged({ issue: issueWithRequest('pending'), request, labelEvents: [] })).toBe(false);
    expect(humanRequestWasAcknowledged({ issue: issueWithRequest('acknowledged'), request, labelEvents: [] })).toBe(false);
    const legacy = { ...issueWithRequest('pending'), comments: [{ body: '<!-- kaizen-loop:result {"outcome":"blocked"} -->', createdAt: '2026-07-16T00:00:00Z' }] };
    expect(humanRequestWasAcknowledged({ issue: legacy, request, labelEvents: [] })).toBe(false);
  });

  it('does not trust a forged acknowledged marker without label-event proof', async () => {
    const forged = issueWithRequest('acknowledged');
    const github = {
      getIssueLabelEvents: vi.fn(async () => []),
      getIssue: vi.fn(async () => forged),
      comment: vi.fn(async () => undefined),
      addLabels: vi.fn(async () => undefined),
      removeLabels: vi.fn(async () => undefined)
    };
    await expect(ensureHumanRequest({
      issue: forged, request, runId: 'run-2', repo: 'o/r', github
    })).resolves.toBe('pending');
    expect(github.comment).toHaveBeenCalledWith(1, expect.stringContaining('"state":"pending"'));
    expect(github.addLabels).toHaveBeenCalledWith(1, ['kaizen:needs-human']);
  });

  it('keeps wording-only changes on the same request and a new key distinct', () => {
    const issue = issueWithRequest('acknowledged');
    const reworded = { ...request, question: 'May the production credential be used?' };
    const next = { ...request, requestKey: 'production-credential-rotation', question: 'Approve rotating the production credential?' };
    expect(latestHumanRequestRecord(issue, request)?.state).toBe('acknowledged');
    expect(latestHumanRequestRecord(issue, reworded)?.state).toBe('acknowledged');
    expect(latestHumanRequestRecord(issue, next)).toBeUndefined();
  });

  it('does not acknowledge an active label without a removal event', () => {
    const issue = { ...issueWithRequest('pending'), labels: [{ name: 'kaizen' }, { name: 'kaizen:needs-human' }] };
    const events = [
      { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:01Z' }
    ];
    expect(humanRequestWasAcknowledged({ issue, request, labelEvents: events })).toBe(false);
  });

  it('uses stable event order when label events share a timestamp', () => {
    const events = [
      { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:00Z' },
      { event: 'unlabeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:00Z' }
    ];
    expect(humanRequestWasAcknowledged({ issue: issueWithRequest('pending'), request, labelEvents: events })).toBe(true);
  });

  it('records acknowledgement and never re-adds the same removed request', async () => {
    const github = {
      getIssueLabelEvents: vi.fn(async () => [
        { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:01Z' },
        { event: 'unlabeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:01:00Z' }
      ]),
      getIssue: vi.fn(async () => issueWithRequest('pending')),
      comment: vi.fn(async () => undefined),
      addLabels: vi.fn(async () => undefined),
      removeLabels: vi.fn(async () => undefined)
    };
    await expect(ensureHumanRequest({
      issue: issueWithRequest('pending'), request, runId: 'run-2', repo: 'o/r', github
    })).resolves.toBe('acknowledged');
    expect(github.comment).toHaveBeenCalledWith(1, expect.stringContaining('"state":"acknowledged"'));
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabels).not.toHaveBeenCalled();
  });

  it('does not mistake a failed label application for acknowledgement', async () => {
    const github = {
      getIssueLabelEvents: vi.fn(async () => []),
      getIssue: vi.fn(async () => issueWithRequest('pending')),
      comment: vi.fn(async () => undefined),
      addLabels: vi.fn(async () => undefined),
      removeLabels: vi.fn(async () => undefined)
    };
    await expect(ensureHumanRequest({
      issue: issueWithRequest('pending'), request, runId: 'run-2', repo: 'o/r', github
    })).resolves.toBe('pending');
    expect(github.addLabels).toHaveBeenCalledWith(1, ['kaizen:needs-human']);
  });

  it('lets a human removal win when it races with label application', async () => {
    const pending = issueWithRequest('pending');
    const active = { ...pending, labels: [{ name: 'kaizen' }, { name: 'kaizen:needs-human' }] };
    const github = {
      getIssue: vi.fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(active),
      getIssueLabelEvents: vi.fn()
        .mockResolvedValueOnce([
          { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:01Z' }
        ])
        .mockResolvedValueOnce([
          { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:01Z' }
        ])
        .mockResolvedValueOnce([
          { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:01Z' },
          { event: 'unlabeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:02Z' },
          { event: 'labeled' as const, label: 'kaizen:needs-human', createdAt: '2026-07-16T00:00:03Z' }
        ]),
      comment: vi.fn(async () => undefined),
      addLabels: vi.fn(async () => undefined),
      removeLabels: vi.fn(async () => undefined)
    };
    await expect(ensureHumanRequest({
      issue: pending, request, runId: 'run-2', repo: 'o/r', github
    })).resolves.toBe('acknowledged');
    expect(github.addLabels).toHaveBeenCalledWith(1, ['kaizen:needs-human']);
    expect(github.removeLabels).toHaveBeenCalledWith(1, ['kaizen:needs-human']);
  });

});

function issueWithRequest(state: 'pending' | 'acknowledged'): GitHubIssue {
  return {
    number: 1,
    title: 'Issue',
    body: 'Body',
    labels: [{ name: 'kaizen' }],
    createdAt: '2026-07-15T00:00:00Z',
    comments: [{
      body: buildHumanRequestComment(request, 'run-1', state),
      createdAt: '2026-07-16T00:00:00Z'
    }]
  };
}
