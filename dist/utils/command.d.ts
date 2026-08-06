export declare const DEFAULT_ENV_ALLOWLIST: string[];
export declare const INITIAL_GIT_EXECUTABLE: string | undefined;
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
export declare const runCommand: CommandRunner;
export declare function buildAllowlistedEnv(source: NodeJS.ProcessEnv, allowlist: string[], extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function githubCliEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function gitCliEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function isolatedGitEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function gitPublicationEnv(source?: NodeJS.ProcessEnv, initialToken?: string | undefined): NodeJS.ProcessEnv;
export declare function publicationGitExecutable(command: CommandRunner): string | undefined;
export declare function executableNames(command: string, platform?: NodeJS.Platform, pathExt?: string | undefined): string[];
export declare function isWindowsExecutablePathTrusted(executable: string, trustedRoots: string[], canWrite?: (candidate: string) => boolean): boolean;
export declare function gitSshPublicationEnv(source?: NodeJS.ProcessEnv, sshExecutable?: string | undefined): NodeJS.ProcessEnv;
export declare function withRunDeadline(runCommand: CommandRunner, deadlineAt: number): CommandRunner;
export declare function throwIfShutdownRequested(): void;
export declare function formatCommand(command: string, args: string[]): string;
export declare function formatCommandFailure(result: CommandResult): string;
