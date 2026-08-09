import { type Stats } from 'node:fs';
export declare const DEFAULT_ENV_ALLOWLIST: string[];
export interface TrustedExecutables {
    git?: string;
    githubCli?: string;
    ssh?: string;
    githubToken?: string;
    githubPublisher?: GitHubPublisher;
}
export declare class TrustedGitHubCliUnavailableError extends Error {
    readonly reasonCode: "trusted_github_cli_unavailable";
    constructor(message?: string);
}
export interface GitHubPublicationRequest {
    cwd: string;
    pushUrl: string;
    refspec: string;
    expectedRepo: string;
    expectedSha: string;
    forceWithLease?: string;
}
export type GitHubPublisher = (request: GitHubPublicationRequest, timeoutMs?: number) => Promise<void>;
export declare const INITIAL_GIT_EXECUTABLE: string | undefined;
export declare const INITIAL_GITHUB_CLI_EXECUTABLE: string | undefined;
export interface CommandResult {
    command: string;
    args: string[];
    cwd?: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
}
export interface RunCommandOptions {
    cwd?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    rejectOnNonZero?: boolean;
}
export type CommandRunner = (command: string, args: string[], options?: RunCommandOptions) => Promise<CommandResult>;
export declare const COMMAND_RUNNER_INJECTION: unique symbol;
export declare function processCommandRunner(defaultRunner: CommandRunner, executables?: TrustedExecutables): CommandRunner;
export declare const runCommand: CommandRunner;
export declare function buildAllowlistedEnv(source: NodeJS.ProcessEnv, allowlist: string[], extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function buildUntrustedEnv(source: NodeJS.ProcessEnv, allowlist: string[], extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function githubCliEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function trustedGithubCliEnv(source?: NodeJS.ProcessEnv, githubCliExecutable?: string | undefined, gitExecutable?: string | undefined): NodeJS.ProcessEnv;
export declare function hasSupervisorGitHubToken(source?: NodeJS.ProcessEnv): boolean;
export declare function gitCliEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function isolatedGitEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function gitPublicationEnv(source?: NodeJS.ProcessEnv, initialToken?: string | undefined): NodeJS.ProcessEnv;
export declare function publicationGitExecutable(command: CommandRunner): string | undefined;
export declare function githubCliExecutable(command: CommandRunner): string | undefined;
export declare function requireTrustedGitHubCliExecutable(command: CommandRunner): string;
export declare function publicationSshExecutable(command: CommandRunner): string | undefined;
export declare function publicationGithubToken(command: CommandRunner): string | undefined;
export declare function publicationGithubPublisher(command: CommandRunner): GitHubPublisher | undefined;
export declare function withTrustedExecutables(command: CommandRunner, executables: TrustedExecutables): CommandRunner;
export declare function executableNames(command: string, platform?: NodeJS.Platform, pathExt?: string | undefined): string[];
export declare function isTrustedExecutablePath(executable: string, canWrite?: (candidate: string) => boolean, statPath?: (candidate: string) => Stats, effectiveUid?: number | undefined): boolean;
export declare function isWindowsExecutablePathTrusted(executable: string, trustedRoots: string[], canWrite?: (candidate: string) => boolean): boolean;
export declare function gitSshPublicationEnv(source?: NodeJS.ProcessEnv, sshExecutable?: string | undefined): NodeJS.ProcessEnv;
export declare function withRunDeadline(runCommand: CommandRunner, deadlineAt: number): CommandRunner;
export declare function throwIfShutdownRequested(): void;
export declare function formatCommand(command: string, args: string[]): string;
export declare function formatCommandFailure(result: CommandResult): string;
