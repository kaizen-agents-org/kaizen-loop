import type { HumanRequest } from '../agents/types.js';
import type { GitHubIssue, GitHubLabelEvent } from '../github/types.js';
import { type DispositionLabelClient } from './disposition.js';
export type HumanRequestLifecycle = 'pending' | 'acknowledged';
interface HumanRequestMarker {
    version: 1;
    id: string;
    fingerprint: string;
    state: HumanRequestLifecycle;
    reasonCode: HumanRequest['reasonCode'];
    requestKey: string;
    question: string;
    run: string;
}
export interface HumanRequestRecord extends HumanRequestMarker {
    createdAt?: string;
}
interface HumanRequestClient extends DispositionLabelClient {
    comment(issue: number, body: string): Promise<void>;
    getIssue(issue: number): Promise<GitHubIssue>;
    getIssueLabelEvents(repo: string, issue: number, label: string): Promise<GitHubLabelEvent[]>;
}
export declare function ensureHumanRequest(options: {
    issue: GitHubIssue;
    request: HumanRequest;
    runId: string;
    repo: string;
    github: HumanRequestClient;
}): Promise<'pending' | 'acknowledged'>;
export declare function humanRequestFingerprint(request: HumanRequest): string;
export declare function buildHumanRequestComment(request: HumanRequest, runId: string, state?: HumanRequestLifecycle): string;
export declare function latestHumanRequestRecord(issue: GitHubIssue, request: HumanRequest): HumanRequestRecord | undefined;
export declare function humanRequestWasAcknowledged(options: {
    issue: GitHubIssue;
    request: HumanRequest;
    labelEvents: GitHubLabelEvent[];
}): boolean;
export {};
