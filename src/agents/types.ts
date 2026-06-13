export interface AgentRequest {
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
  model?: string | null;
  preferredBackend?: 'claude' | 'codex';
}

export interface AgentResult {
  status: 'fixed' | 'partial' | 'blocked' | 'error' | 'timeout';
  summary: string;
  notes: string;
  blockedReason?: string;
  discoveredIssues: DiscoveredIssue[];
  raw: string;
  durationMs: number;
}

export interface DiscoveredIssue {
  title: string;
  body?: string;
  expected?: string;
  evidence?: string;
  repo?: string;
  severity?: string;
  labels?: string[];
}

export interface AgentAdapter {
  readonly name: 'builder' | 'claude' | 'codex';
  isAvailable(): Promise<boolean>;
  run(req: AgentRequest): Promise<AgentResult>;
}
