import { type CommandRunner } from '../utils/command.js';
export interface PrepareActionsFixOptions {
    cwd: string;
    issue: number;
    outputDir: string;
    runCommand?: CommandRunner;
}
export declare function prepareActionsFix(options: PrepareActionsFixOptions): Promise<{
    repo: string;
    issue: number;
    baseSha: string;
    promptPath: string;
}>;
export interface VerifyActionsFixOptions {
    cwd: string;
    issue: number;
    patchPath: string;
    providerResultPath: string;
    contextPath: string;
    outputDir: string;
    runCommand?: CommandRunner;
}
export declare function verifyActionsFix(options: VerifyActionsFixOptions): Promise<{
    version: 1;
    repo: string;
    issue: {
        number: number;
        title: string;
    };
    baseSha: string;
    patchSha256: string;
    provider: "claude" | "codex";
    providerAttempts: {
        provider: "claude" | "codex";
        status: "failed" | "selected";
        failureClass: "none" | "external_action_failure";
    }[];
    builder: {
        summary: string;
        notes: string;
    };
    verification: {
        command: string;
        ok: boolean;
        output: string;
    }[];
    verifier: {
        status: "open_pr" | "open_pr_with_warning";
        summary: string;
        notes: string;
        reason?: string | undefined;
    };
    files: string[];
    createdAt: string;
}>;
export interface PublishActionsFixOptions {
    cwd: string;
    artifactDir: string;
    runCommand?: CommandRunner;
}
export declare function publishActionsFix(options: PublishActionsFixOptions): Promise<{
    branch: string;
    body: string;
    number?: number;
    url: string;
}>;
export declare function encodeProviderResult(provider: 'codex' | 'claude', finalMessage: string): string;
