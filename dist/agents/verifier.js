import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildUntrustedEnv } from '../utils/command.js';
import { extractLastJsonObject } from '../utils/json.js';
import { envWithKaizenTemp } from '../utils/temp.js';
/** Legacy statuses kept for temporary backward compatibility with older verifier payloads. */
const legacyStatusMap = {
    approved: 'open_pr',
    pr_only: 'open_pr_with_warning',
    rejected: 'block_pr'
};
const verifierFindingSchema = z.object({
    source: z.enum(['task', 'diff', 'verify_logs', 'builder_report', 'system']),
    message: z.string(),
    evidence: z.string().optional()
});
const verifierPayloadSchema = z
    .object({
    status: z
        .enum(['open_pr', 'open_pr_with_warning', 'block_pr', 'needs_context', 'approved', 'pr_only', 'rejected'])
        .transform((status) => legacyStatusMap[status] ?? status),
    summary: z.string().default(''),
    notes: z.string().default(''),
    reason: z.string().optional(),
    must_fix: z.array(verifierFindingSchema).optional(),
    should_fix: z.array(verifierFindingSchema).optional(),
    confidence: z.number().int().min(0).max(100).optional(),
    risk: z.enum(['low', 'medium', 'high']).optional(),
    evidence_grade: z.preprocess((value) => (value === 'executed' || value === 'reported' ? value : undefined), z.enum(['executed', 'reported']).optional())
})
    .passthrough();
const verifierVersionSchema = z.object({
    name: z.literal('verifier'),
    version: z.string(),
    status: z.enum(['current', 'stale', 'unverifiable']),
    stale: z.boolean().nullable(),
    build: z.object({
        commit: z.string().nullable(),
        builtAt: z.string().nullable(),
        dirty: z.boolean().nullable()
    }),
    runtime: z.object({
        commit: z.string().nullable(),
        dirty: z.boolean().nullable(),
        packageRoot: z.string()
    })
}).passthrough().superRefine((value, context) => {
    const expected = value.status === 'stale' ? true : value.status === 'current' ? false : null;
    if (value.stale !== expected) {
        context.addIssue({
            code: 'custom',
            path: ['stale'],
            message: `status ${value.status} requires stale=${String(expected)}`
        });
    }
});
export class VerifierAgentAdapter {
    runCommand;
    options;
    name = 'verifier';
    constructor(runCommand, options) {
        this.runCommand = runCommand;
        this.options = options;
    }
    async isAvailable() {
        try {
            await this.inspectRuntime();
            return true;
        }
        catch {
            return false;
        }
    }
    async inspectRuntime() {
        const commandOptions = {
            rejectOnNonZero: true,
            timeoutMs: 30_000,
            env: buildUntrustedEnv(process.env, this.options.envAllowlist)
        };
        let result;
        let structuredError;
        try {
            result = await this.runCommand(this.options.command, ['--version', '--json'], commandOptions);
        }
        catch (error) {
            structuredError = error instanceof Error ? error.message : String(error);
            result = await this.runCommand(this.options.command, ['--version'], commandOptions);
        }
        const raw = `${result.stdout}${result.stderr}`.trim();
        let parsed;
        try {
            parsed = extractLastJsonObject(raw);
        }
        catch {
            return {
                protocol: 'legacy',
                command: this.options.command,
                status: 'legacy',
                stale: null,
                raw,
                ...(structuredError ? { structuredError } : {})
            };
        }
        return {
            protocol: 'structured',
            command: this.options.command,
            raw,
            ...verifierVersionSchema.parse(parsed)
        };
    }
    async run(req) {
        const resultPath = path.resolve(req.workspaceDir, this.options.resultPath);
        await fs.rm(resultPath, { force: true });
        await fs.mkdir(path.dirname(resultPath), { recursive: true });
        try {
            const env = await envWithKaizenTemp(buildUntrustedEnv(process.env, this.options.envAllowlist, {
                KAIZEN_VERIFIER_RESULT_PATH: resultPath,
                KAIZEN_WORKSPACE_DIR: req.workspaceDir
            }), req.workspaceDir);
            const result = await this.runCommand(this.options.command, [], {
                cwd: req.workspaceDir,
                input: req.prompt,
                timeoutMs: req.timeoutMs ?? this.options.timeoutMinutes * 60_000,
                rejectOnNonZero: false,
                env
            });
            const raw = `${result.stdout}${result.stderr}`;
            const payload = (await readVerifierPayload(resultPath)) ?? parseVerifierPayload(raw);
            await fs.rm(resultPath, { force: true });
            if (result.exitCode !== 0 && !payload) {
                return {
                    status: 'error',
                    summary: `Verifier agent exited with code ${result.exitCode}`,
                    notes: '',
                    raw,
                    durationMs: result.durationMs
                };
            }
            if (!payload) {
                return {
                    status: 'error',
                    summary: `Verifier agent did not write ${this.options.resultPath}`,
                    notes: '',
                    raw,
                    durationMs: result.durationMs
                };
            }
            return {
                status: payload.status,
                summary: payload.summary,
                notes: payload.notes,
                reason: payload.reason,
                mustFix: payload.must_fix,
                shouldFix: payload.should_fix,
                confidence: payload.confidence,
                risk: payload.risk,
                evidenceGrade: payload.evidence_grade,
                raw: `${raw}\n${JSON.stringify(payload)}`,
                durationMs: result.durationMs
            };
        }
        catch (error) {
            return {
                status: 'error',
                summary: String(error),
                notes: '',
                raw: String(error),
                durationMs: req.timeoutMs ?? this.options.timeoutMinutes * 60_000
            };
        }
    }
}
async function readVerifierPayload(resultPath) {
    try {
        const raw = await fs.readFile(resultPath, 'utf8');
        return verifierPayloadSchema.parse(JSON.parse(raw));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function parseVerifierPayload(raw) {
    try {
        return verifierPayloadSchema.parse(extractLastJsonObject(raw));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=verifier.js.map