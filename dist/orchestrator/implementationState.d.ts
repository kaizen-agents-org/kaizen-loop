import type { GitHubPullRequest } from '../github/types.js';
export type ImplementationPhase = 'implementing' | 'verifying' | 'publishing' | 'guardian' | 'blocked' | 'failed' | 'infrastructure-failure' | 'discarded' | 'recovery-needed' | 'handoff' | 'complete';
export interface ImplementationState {
    version: 1;
    issue: number;
    branch: string;
    phase: ImplementationPhase;
    attempt: number;
    updatedAt: string;
    lastFailure?: string;
    pr?: number;
    prUrl?: string;
}
export declare function loadImplementationState(stateDir: string, issue: number): Promise<ImplementationState | undefined>;
export declare function listImplementationStates(stateDir: string): Promise<ImplementationState[]>;
export declare function saveImplementationState(stateDir: string, state: Omit<ImplementationState, 'version' | 'updatedAt'>): Promise<ImplementationState>;
export declare function implementationStatePath(stateDir: string, issue: number): string;
export declare function openCheckpointStates(states: ImplementationState[], openPullRequests: GitHubPullRequest[]): ImplementationState[];
export declare function forbiddenCheckpointPublicationReason(forbiddenFiles: string[]): string | undefined;
export declare function isResumableImplementationState(state: ImplementationState | undefined): state is ImplementationState;
