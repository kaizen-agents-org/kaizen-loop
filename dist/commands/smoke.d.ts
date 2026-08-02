import type { RunSummary } from '../orchestrator/summary.js';
import type { CommandRunner } from '../utils/command.js';
import type { RunLock } from '../orchestrator/lock.js';
export interface SandboxSmokeOptions {
    cwd: string;
    project?: string;
    title?: string;
    body?: string;
    priority?: 'P0' | 'P1' | 'P2';
    agent?: 'claude' | 'codex';
    json: boolean;
    assumeYes?: boolean;
    schedulerJob?: string;
    existingLock?: RunLock;
    runCommand: CommandRunner;
}
export interface SandboxSmokeArtifact {
    version: 1;
    kind: 'sandbox-e2e-smoke';
    project: {
        slug: string;
        repo: string;
    };
    startedAt: string;
    finishedAt: string;
    result: RunSummary['result'];
    issue: {
        number: number;
        title: string;
        url?: string;
    };
    run: {
        id: string;
        trigger: string;
        summaryPath: string;
        issueLogDir: string;
    };
    implementation: {
        outcome?: string;
        branch?: string;
        changedFiles?: number;
        changedLines?: number;
    };
    verification: {
        commands: string[];
        verifyLogPath: string;
        verifier: {
            enabled: boolean;
            verdict?: string;
            logPath: string;
        };
    };
    pullRequest?: {
        number?: number;
        url?: string;
        baseRefName?: string;
        defaultBranch?: string;
        isDraft?: boolean;
        closingIssuesReferences?: Array<{
            number: number;
            url?: string;
        }>;
        issueLinkRecognized: boolean;
    };
    guardian?: {
        mode: 'sync' | 'async';
        status: string;
        summary: string;
        jobId?: string;
        jobPath?: string;
    };
    artifactPath: string;
}
export declare function runSandboxSmoke(options: SandboxSmokeOptions): Promise<SandboxSmokeArtifact>;
