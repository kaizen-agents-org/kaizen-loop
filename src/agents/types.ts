export interface AgentRequest {
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
  model?: string | null;
  preferredBackends?: Array<'claude' | 'codex'>;
}

export interface AgentResult {
  status: 'fixed' | 'partial' | 'blocked' | 'error' | 'timeout';
  summary: string;
  notes: string;
  blockedReason?: string;
  humanRequest?: HumanRequest;
  discoveredIssues: DiscoveredIssue[];
  raw: string;
  durationMs: number;
}

export type HumanRequestReasonCode =
  | 'missing_information'
  | 'credentials'
  | 'billing'
  | 'destructive_action'
  | 'production_change'
  | 'policy_exception'
  | 'external_repository_action'
  | 'other_approval';

export interface HumanRequest {
  reasonCode: HumanRequestReasonCode;
  requestKey: string;
  question: string;
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
