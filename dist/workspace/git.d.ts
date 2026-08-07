import { type CommandRunner } from '../utils/command.js';
export declare class GitClient {
    private readonly run;
    private readonly cwd;
    private readonly publicationGitExecutable;
    private readonly publicationSshExecutable;
    private readonly publicationGithubToken;
    constructor(run: CommandRunner, cwd: string, publicationGitExecutable?: string | undefined, publicationSshExecutable?: string | undefined, publicationGithubToken?: string | undefined);
    root(): Promise<string>;
    remoteUrl(name?: string): Promise<string>;
    currentBranch(): Promise<string>;
    revParse(ref: string): Promise<string>;
    clone(remote: string, target: string): Promise<void>;
    fetch(): Promise<void>;
    fetchPrune(): Promise<void>;
    checkout(branch: string, options?: {
        ignoreOtherWorktrees?: boolean;
    }): Promise<void>;
    resetHard(ref: string): Promise<void>;
    rebase(ref: string): Promise<void>;
    abortRebase(): Promise<void>;
    mergeFfOnly(ref: string): Promise<void>;
    clean(): Promise<void>;
    worktreeAdd(target: string, branch: string, ref: string): Promise<void>;
    worktreeAddExisting(target: string, branch: string): Promise<void>;
    localBranchExists(branch: string): Promise<boolean>;
    remoteBranchExists(branch: string, remote?: string): Promise<boolean>;
    worktreeList(): Promise<Array<{
        path: string;
        branch?: string;
    }>>;
    worktreeRemove(target: string): Promise<void>;
    worktreePrune(): Promise<void>;
    switchNew(branch: string): Promise<void>;
    deleteLocalBranch(branch: string): Promise<void>;
    forceBranch(branch: string, ref: string): Promise<void>;
    addAll(): Promise<void>;
    commit(message: string): Promise<void>;
    statusPorcelain(): Promise<string>;
    remoteBranches(remote?: string): Promise<Array<{
        ref: string;
        name: string;
        sha: string;
    }>>;
    divergence(base: string, head: string): Promise<{
        behind: number;
        ahead: number;
    }>;
    diffNameOnly(base: string): Promise<string[]>;
    diffNumstat(base: string): Promise<Array<{
        file: string;
        added: number;
        deleted: number;
    }>>;
    diff(base: string): Promise<string>;
    workingTreeDiffNameOnly(): Promise<string[]>;
    workingTreeDiffNumstat(): Promise<Array<{
        file: string;
        added: number;
        deleted: number;
    }>>;
    workingTreeDiff(): Promise<string>;
    push(ref: string, options: {
        forceWithLease?: boolean;
        expectedRepo: string;
    }): Promise<void>;
    private git;
}
export declare function isGitLfsPointer(content: string): boolean;
