import type { AgentResult, HumanRequest } from '../agents/types.js';
import type { IssueIntakeDecision, IssueIntakeDecisionStatus } from './issueIntake.js';

export type IssueDisposition =
  | 'human-input-required'
  | 'retryable'
  | 'blocked'
  | 'upstream-first'
  | 'not-actionable'
  | 'attempts-exhausted';

export const DISPOSITION_LABELS: Record<IssueDisposition, string> = {
  'human-input-required': 'kaizen:needs-human',
  retryable: 'kaizen:retryable',
  blocked: 'kaizen:blocked',
  'upstream-first': 'kaizen:upstream-first',
  'not-actionable': 'kaizen:not-actionable',
  'attempts-exhausted': 'kaizen:attempts-exhausted'
};

export const TERMINAL_DISPOSITION_LABELS = [
  DISPOSITION_LABELS['human-input-required'],
  DISPOSITION_LABELS.blocked,
  DISPOSITION_LABELS['upstream-first'],
  DISPOSITION_LABELS['not-actionable'],
  DISPOSITION_LABELS['attempts-exhausted']
];

export interface DispositionLabelClient {
  addLabels(issue: number, labels: string[]): Promise<void>;
  removeLabels(issue: number, labels: string[]): Promise<void>;
}

export async function applyIssueDisposition(
  github: DispositionLabelClient,
  issue: number,
  disposition?: IssueDisposition
): Promise<void> {
  const destination = disposition ? DISPOSITION_LABELS[disposition] : undefined;
  if (destination) await github.addLabels(issue, [destination]);
  // A pending human request is only cleared by a human label removal. Generic
  // reconciliation must never manufacture an acknowledgement.
  const stale = Object.values(DISPOSITION_LABELS).filter(
    (label) => label !== destination && label !== DISPOSITION_LABELS['human-input-required']
  );
  if (stale.length > 0) await github.removeLabels(issue, stale);
}

export function dispositionForIntake(status: IssueIntakeDecisionStatus): IssueDisposition | undefined {
  switch (status) {
    case 'proceed':
    case 'already_resolved':
      return undefined;
    case 'needs_human':
    case 'needs_context':
      return 'human-input-required';
    case 'upstream_first':
      return 'upstream-first';
    case 'not_improvement':
      return 'not-actionable';
    default:
      return assertNever(status);
  }
}

export function humanRequestForIntake(decision: IssueIntakeDecision): HumanRequest | undefined {
  switch (decision.status) {
    case 'needs_human':
      return {
        reasonCode: 'external_repository_action',
        requestKey: 'external-repository-live-actions',
        question: 'Approve proceeding with the requested live actions outside this repository?'
      };
    case 'needs_context':
      return {
        reasonCode: 'missing_information',
        requestKey: 'missing-implementation-context',
        question: 'Provide the missing implementation context, or approve proceeding with the information currently recorded.'
      };
    case 'proceed':
    case 'upstream_first':
    case 'not_improvement':
    case 'already_resolved':
      return undefined;
    default:
      return assertNever(decision.status);
  }
}

export function dispositionForBlockedAgent(
  agentResult: AgentResult
): 'human-input-required' | 'retryable' | 'blocked' {
  if (agentResult.humanRequest) return 'human-input-required';
  if (isRetryableExternalBlock(agentResult)) return 'retryable';
  return 'blocked';
}

export function isRetryableExternalBlock(agentResult: AgentResult): boolean {
  const text = `${agentResult.blockedReason ?? ''}\n${agentResult.notes}\n${agentResult.raw}`;
  return [
    /\bfailureclass\s*[:=]\s*(timeout|rate_limited|rate limited)\b/i,
    /\bfallbackreason\s*[:=]\s*(timeout|rate_limited|rate limited)\b/i,
    /\bapi_error_status["']?\s*[:=]\s*429\b/i,
    /\b(?:http|status)\s*[:=]\s*429\b/i,
    /\bagent command timed out after \d+ms\b/i,
    /["']result["']\s*:\s*["'][^"']*(session limit|rate limit exceeded|too many requests)/i,
    /\bfailed to initialize in-process app-server client:\s*operation not permitted\b/i,
    /\bcould not create path aliases:\s*operation not permitted\b/i,
    /\bfailureclass\s*[:=]\s*(command_missing|auth_failed|authentication_failed|login_required)\b/i,
    /\bfallbackreason\s*[:=]\s*(command_missing|auth_failed|authentication_failed|login_required)\b/i
  ].some((pattern) => pattern.test(text));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled issue disposition input: ${String(value)}`);
}
