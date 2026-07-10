import { describe, expect, it } from 'vitest';
import { requiresHumanForBlockedAgent } from '../src/orchestrator/run.js';
import type { AgentResult } from '../src/agents/types.js';

describe('blocked agent classification', () => {
  it('does not require human input for provider capacity failures', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      summary: 'Builder agent exited with code 1.',
      notes: [
        'Provider evidence:',
        '- codex: exitCode=1, failureClass=timeout, fallbackReason=timeout',
        '- claude: exitCode=1, failureClass=rate_limited',
        'Agent command timed out after 600000ms.',
        '{"api_error_status":429,"result":"You have hit your session limit"}'
      ].join('\n')
    }))).toBe(false);
  });

  it('does not require human input for structured too-many-requests results', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      raw: '{"result":"429 Too Many Requests: rate limit exceeded"}'
    }))).toBe(false);
  });

  it('does not require human input for runner sandbox app-server failures', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      raw: [
        'WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)',
        'Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)',
        '{"result":"Not logged in · Please run /login"}'
      ].join('\n')
    }))).toBe(false);
  });

  it('keeps human-input labeling for ordinary blocked builder results', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      summary: 'Production credentials are required.',
      blockedReason: 'Needs human approval for billing credentials.'
    }))).toBe(true);
  });

  it('keeps human-input labeling for plain login failures', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      raw: '{"result":"Not logged in · Please run /login"}'
    }))).toBe(true);
  });

  it('retries command and authentication failures from the execution environment', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      notes: 'failureClass=command_missing; fallbackReason=auth_failed'
    }))).toBe(false);
  });

  it('does not treat free-form retry wording as provider capacity evidence', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      summary: 'Add a rate limited retry scenario to the fixture corpus.',
      notes: 'This issue mentions http 429 and session limit behavior in the task description, but credentials are missing.',
      blockedReason: 'Needs human approval for fixture access.'
    }))).toBe(true);
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
