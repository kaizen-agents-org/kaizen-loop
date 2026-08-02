import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildAllowlistedEnv } from '../utils/command.js';
import { envWithKaizenTemp } from '../utils/temp.js';
const discoveredIssueSchema = z
    .object({
    title: z.string().min(1),
    body: z.string().optional(),
    expected: z.string().optional(),
    evidence: z.string().optional(),
    repo: z.string().optional(),
    severity: z.string().optional(),
    labels: z.array(z.string()).optional()
})
    .strict();
const builderPayloadSchema = z
    .object({
    status: z.enum(['fixed', 'partial', 'blocked']),
    summary: z.string(),
    notes: z.string(),
    blockedReason: z.string().optional(),
    humanRequest: z.object({
        reasonCode: z.enum([
            'missing_information',
            'credentials',
            'billing',
            'destructive_action',
            'production_change',
            'policy_exception',
            'external_repository_action',
            'other_approval'
        ]),
        requestKey: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
        question: z.string().min(1)
    }).strict().optional(),
    discoveredIssues: z.array(discoveredIssueSchema).default([])
})
    .strict()
    .superRefine((payload, context) => {
    if (payload.humanRequest && payload.status !== 'blocked') {
        context.addIssue({
            code: 'custom',
            path: ['humanRequest'],
            message: 'humanRequest is only valid when status is blocked'
        });
    }
});
export class BuilderAgentAdapter {
    runCommand;
    options;
    name = 'builder';
    constructor(runCommand, options) {
        this.runCommand = runCommand;
        this.options = options;
    }
    async isAvailable() {
        try {
            await this.runCommand(this.options.command, ['--version'], {
                rejectOnNonZero: true,
                timeoutMs: 30_000,
                env: buildAllowlistedEnv(process.env, this.options.envAllowlist)
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async run(req) {
        const resultPath = path.resolve(req.workspaceDir, this.options.resultPath);
        const discoveredIssuesPath = path.resolve(req.workspaceDir, '.kaizen/builder/discovered-issues.json');
        await Promise.all([
            fs.rm(resultPath, { force: true }),
            fs.rm(discoveredIssuesPath, { force: true })
        ]);
        await fs.mkdir(path.dirname(resultPath), { recursive: true });
        try {
            const env = await envWithKaizenTemp(buildAllowlistedEnv(process.env, this.options.envAllowlist, {
                KAIZEN_BUILD_RESULT_PATH: resultPath,
                KAIZEN_WORKSPACE_DIR: req.workspaceDir,
                ...(req.preferredBackends?.length ? { KAIZEN_PREFERRED_AGENT: req.preferredBackends.join(',') } : {}),
                ...(req.model ? { KAIZEN_AGENT_MODEL: req.model } : {})
            }), req.workspaceDir);
            const result = await this.runCommand(this.options.command, [], {
                cwd: req.workspaceDir,
                input: req.prompt,
                timeoutMs: req.timeoutMs,
                rejectOnNonZero: false,
                env
            });
            const raw = `${result.stdout}${result.stderr}`;
            let payload;
            try {
                payload = await readBuilderPayload(resultPath);
            }
            catch (error) {
                return {
                    status: 'error',
                    summary: String(error),
                    notes: '',
                    discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
                    raw: String(error),
                    durationMs: req.timeoutMs
                };
            }
            if (result.exitCode !== 0 && !payload) {
                return {
                    status: 'error',
                    summary: `Builder agent exited with code ${result.exitCode}`,
                    notes: '',
                    discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
                    raw,
                    durationMs: result.durationMs
                };
            }
            if (!payload) {
                return {
                    status: 'error',
                    summary: `Builder agent did not write ${this.options.resultPath}`,
                    notes: '',
                    discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
                    raw,
                    durationMs: result.durationMs
                };
            }
            return {
                status: payload.status,
                summary: payload.summary,
                notes: payload.notes,
                blockedReason: payload.blockedReason,
                humanRequest: payload.humanRequest,
                discoveredIssues: payload.discoveredIssues,
                raw: `${raw}\n${JSON.stringify(payload)}`,
                durationMs: result.durationMs
            };
        }
        catch (error) {
            return {
                status: 'error',
                summary: String(error),
                notes: '',
                discoveredIssues: await readDiscoveredIssues(discoveredIssuesPath),
                raw: String(error),
                durationMs: req.timeoutMs
            };
        }
        finally {
            await Promise.allSettled([
                fs.rm(resultPath, { force: true }),
                fs.rm(discoveredIssuesPath, { force: true })
            ]);
        }
    }
}
async function readBuilderPayload(resultPath) {
    try {
        const raw = await fs.readFile(resultPath, 'utf8');
        return builderPayloadSchema.parse(JSON.parse(raw));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function readDiscoveredIssues(discoveredIssuesPath) {
    try {
        const parsed = JSON.parse(await fs.readFile(discoveredIssuesPath, 'utf8'));
        if (!Array.isArray(parsed))
            return [];
        return parsed.flatMap((candidate) => {
            const result = discoveredIssueSchema.safeParse(candidate);
            return result.success ? [result.data] : [];
        });
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=builder.js.map