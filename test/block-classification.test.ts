import { describe, expect, it } from 'vitest';
import { dispositionForBlockedAgent } from '../src/orchestrator/disposition.js';
import type { AgentResult } from '../src/agents/types.js';

describe('blocked agent classification', () => {
  it('does not require human input for provider capacity failures', () => {
    expect(dispositionForBlockedAgent(agentResult({
      summary: 'Builder agent exited with code 1.',
      notes: [
        'Provider evidence:',
        '- codex: exitCode=1, failureClass=timeout, fallbackReason=timeout',
        '- claude: exitCode=1, failureClass=rate_limited',
        'Agent command timed out after 600000ms.',
        '{"api_error_status":429,"result":"You have hit your session limit"}'
      ].join('\n')
    }))).toBe('retryable');
  });

  it('does not require human input for structured too-many-requests results', () => {
    expect(dispositionForBlockedAgent(agentResult({
      raw: '{"result":"429 Too Many Requests: rate limit exceeded"}'
    }))).toBe('retryable');
  });

  it('does not require human input for runner sandbox app-server failures', () => {
    expect(dispositionForBlockedAgent(agentResult({
      raw: [
        'WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)',
        'Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)',
        '{"result":"Not logged in · Please run /login"}'
      ].join('\n')
    }))).toBe('retryable');
  });

  it('does not infer human-input labeling from free-form blocked text', () => {
    expect(dispositionForBlockedAgent(agentResult({
      summary: 'Production credentials are required.',
      blockedReason: 'Needs human approval for billing credentials.'
    }))).toBe('blocked');
  });

  it('does not infer human-input labeling for plain login failures', () => {
    expect(dispositionForBlockedAgent(agentResult({
      raw: '{"result":"Not logged in · Please run /login"}'
    }))).toBe('blocked');
  });

  it('requires human input only for a structured request', () => {
    expect(dispositionForBlockedAgent(agentResult({
      humanRequest: {
        reasonCode: 'credentials',
        requestKey: 'billing-credentials',
        question: 'Provide credentials for the billing account?'
      }
    }))).toBe('human-input-required');
  });

  it('retries command and authentication failures from the execution environment', () => {
    expect(dispositionForBlockedAgent(agentResult({
      notes: 'failureClass=command_missing; fallbackReason=auth_failed'
    }))).toBe('retryable');
  });

  it('does not treat free-form retry wording as provider capacity evidence', () => {
    expect(dispositionForBlockedAgent(agentResult({
      summary: 'Add a rate limited retry scenario to the fixture corpus.',
      notes: 'This issue mentions http 429 and session limit behavior in the task description, but credentials are missing.',
      blockedReason: 'Needs human approval for fixture access.'
    }))).toBe('blocked');
  });
});

function agentResult(overrides: Partial<AgentResult>): AgentResult {
  return {
    status: 'blocked',
    summary: 'blocked',
    notes: '',
    discoveredIssues: [],
    raw: '',
    durationMs: 1,
    ...overrides
  };
}
