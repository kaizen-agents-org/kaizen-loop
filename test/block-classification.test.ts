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

  it('keeps human-input labeling for ordinary blocked builder results', () => {
    expect(requiresHumanForBlockedAgent(agentResult({
      summary: 'Production credentials are required.',
      blockedReason: 'Needs human approval for billing credentials.'
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
