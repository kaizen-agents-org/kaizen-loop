import type { KaizenConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/types.js';
import type { DiffStats } from '../workspace/manager.js';
import type { AgentResult } from './types.js';
export declare function buildFixPrompt(options: {
    repo: string;
    issue: GitHubIssue;
    config: KaizenConfig;
    attempt: number;
    previousFailure?: string;
}): string;
export declare function buildActionsFixPrompt(options: {
    repo: string;
    issue: GitHubIssue;
    config: KaizenConfig;
    attempt: number;
    previousFailure?: string;
}): string;
export declare function buildVerifierPrompt(options: {
    repo: string;
    issue: GitHubIssue;
    agentResult: AgentResult;
    verifyResults: Array<{
        command: string;
        ok: boolean;
        output: string;
    }>;
    diff: DiffStats;
    diffText: string;
}): string;
