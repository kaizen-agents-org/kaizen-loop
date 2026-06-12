import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async run(_req: AgentRequest): Promise<AgentResult> {
    return {
      status: 'error',
      summary: 'CodexAdapter is not implemented in Phase 1.',
      notes: '',
      raw: 'CodexAdapter is not implemented in Phase 1.',
      durationMs: 0
    };
  }
}
