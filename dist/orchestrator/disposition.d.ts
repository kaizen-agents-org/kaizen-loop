import type { AgentResult, HumanRequest } from '../agents/types.js';
import type { IssueIntakeDecision, IssueIntakeDecisionStatus } from './issueIntake.js';
export type IssueDisposition = 'human-input-required' | 'retryable' | 'blocked' | 'upstream-first' | 'not-actionable' | 'attempts-exhausted';
export declare const DISPOSITION_LABELS: Record<IssueDisposition, string>;
export declare const TERMINAL_DISPOSITION_LABELS: string[];
export interface DispositionLabelClient {
    addLabels(issue: number, labels: string[]): Promise<void>;
    removeLabels(issue: number, labels: string[]): Promise<void>;
}
export declare function applyIssueDisposition(github: DispositionLabelClient, issue: number, disposition?: IssueDisposition): Promise<void>;
export declare function dispositionForIntake(status: IssueIntakeDecisionStatus): IssueDisposition | undefined;
export declare function humanRequestForIntake(decision: IssueIntakeDecision): HumanRequest | undefined;
export declare function dispositionForBlockedAgent(agentResult: AgentResult): 'human-input-required' | 'retryable' | 'blocked';
export declare function isRetryableExternalBlock(agentResult: AgentResult): boolean;
