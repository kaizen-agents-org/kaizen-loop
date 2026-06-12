import { describe, expect, it } from 'vitest';
import { parseAgentResult } from '../src/agents/claude.js';

describe('parseAgentResult', () => {
  it('extracts final json from claude json result', () => {
    const parsed = parseAgentResult(
      JSON.stringify({
        result: 'done\n```json\n{"status":"fixed","summary":"直した","notes":""}\n```'
      }),
      123
    );

    expect(parsed.status).toBe('fixed');
    expect(parsed.summary).toBe('直した');
    expect(parsed.durationMs).toBe(123);
  });
});
