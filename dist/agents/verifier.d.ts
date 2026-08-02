import { z } from 'zod';
import { type CommandRunner } from '../utils/command.js';
/**
 * Conservative PR-creation gate statuses. The verifier decides whether opening a
 * PR is acceptable, it does not imply merge approval.
 * - `open_pr`: change is acceptable, open a ready-for-review PR.
 * - `open_pr_with_warning`: open a PR but surface a caveat for the human reviewer.
 * - `block_pr`: do not open a PR yet; return the reason to the builder to revise.
 * - `needs_context`: verifier lacks information to decide; return to the builder.
 */
export type VerifierGateStatus = 'open_pr' | 'open_pr_with_warning' | 'block_pr' | 'needs_context';
export type VerifierEvidenceGrade = 'executed' | 'reported';
export type VerifierRisk = 'low' | 'medium' | 'high';
export interface VerifierFinding {
    source: 'task' | 'diff' | 'verify_logs' | 'builder_report' | 'system';
    message: string;
    evidence?: string;
}
declare const verifierVersionSchema: z.ZodObject<{
    name: z.ZodLiteral<"verifier">;
    version: z.ZodString;
    status: z.ZodEnum<{
        current: "current";
        stale: "stale";
        unverifiable: "unverifiable";
    }>;
    stale: z.ZodNullable<z.ZodBoolean>;
    build: z.ZodObject<{
        commit: z.ZodNullable<z.ZodString>;
        builtAt: z.ZodNullable<z.ZodString>;
        dirty: z.ZodNullable<z.ZodBoolean>;
    }, z.core.$strip>;
    runtime: z.ZodObject<{
        commit: z.ZodNullable<z.ZodString>;
        dirty: z.ZodNullable<z.ZodBoolean>;
        packageRoot: z.ZodString;
    }, z.core.$strip>;
}, z.core.$loose>;
export type VerifierRuntimeInfo = ({
    protocol: 'structured';
    command: string;
    raw: string;
} & z.infer<typeof verifierVersionSchema>) | {
    protocol: 'legacy';
    command: string;
    status: 'legacy';
    stale: null;
    raw: string;
    structuredError?: string;
};
export interface VerifierAgentOptions {
    command: string;
    resultPath: string;
    timeoutMinutes: number;
    envAllowlist: string[];
}
export interface VerifierRequest {
    workspaceDir: string;
    prompt: string;
    timeoutMs?: number;
}
export interface VerifierResult {
    status: VerifierGateStatus | 'error' | 'timeout';
    summary: string;
    notes: string;
    reason?: string;
    mustFix?: VerifierFinding[];
    shouldFix?: VerifierFinding[];
    confidence?: number;
    risk?: VerifierRisk;
    evidenceGrade?: VerifierEvidenceGrade;
    raw: string;
    durationMs: number;
}
export declare class VerifierAgentAdapter {
    private readonly runCommand;
    private readonly options;
    readonly name: "verifier";
    constructor(runCommand: CommandRunner, options: VerifierAgentOptions);
    isAvailable(): Promise<boolean>;
    inspectRuntime(): Promise<VerifierRuntimeInfo>;
    run(req: VerifierRequest): Promise<VerifierResult>;
}
export {};
