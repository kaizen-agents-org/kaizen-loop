import type { KaizenConfig } from '../config/schema.js';
import { type CommandRunner } from '../utils/command.js';
import { GitClient } from './git.js';
export interface DiffStats {
    files: string[];
    changedFiles: number;
    changedLines: number;
    forbiddenFiles: string[];
    protectedFiles: string[];
}
export interface WorkspaceCommandResult {
    command: string;
    ok: boolean;
    output: string;
}
export declare class CheckpointBranchMissingError extends Error {
    readonly branch: string;
    constructor(branch: string);
}
export declare class CheckpointBranchDivergedError extends Error {
    readonly branch: string;
    constructor(branch: string);
}
export declare class WorkspaceManager {
    private readonly run;
    private readonly workspacePath;
    private readonly remoteUrl;
    constructor(run: CommandRunner, workspacePath: string, remoteUrl?: string);
    ensure(): Promise<void>;
    git(): GitClient;
    get path(): string;
    sync(defaultBranch: string): Promise<void>;
    runSetup(config: KaizenConfig, runDeadlineAt?: number): Promise<WorkspaceCommandResult | undefined>;
    runVerify(config: KaizenConfig, runDeadlineAt?: number): Promise<WorkspaceCommandResult[]>;
    private runVerifyCommand;
    private runDependencyRepair;
    createIssueBranch(config: KaizenConfig, issue: {
        number: number;
        title: string;
    }): Promise<string>;
    createIssueWorktree(config: KaizenConfig, issue: {
        number: number;
        title: string;
    }, runId: string, options?: {
        branch?: string;
        resume?: boolean;
    }): Promise<{
        branch: string;
        path: string;
        resumed: boolean;
    }>;
    discardIssueChanges(branch: string, defaultBranch: string): Promise<{
        restoredCheckpoint: boolean;
    }>;
    removeIssueWorktree(worktreePath: string): Promise<void>;
    collectDiffStats(config: KaizenConfig): Promise<DiffStats>;
    collectCheckpointDiffStats(config: KaizenConfig): Promise<DiffStats>;
    collectDiffText(config: KaizenConfig, maxChars?: number): Promise<string>;
    collectWorkingTreeDiffStats(config: KaizenConfig): Promise<DiffStats>;
    collectWorkingTreeDiffText(maxChars?: number): Promise<string>;
    private runShell;
    private removeWorktreesForBranch;
}
