import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildUntrustedEnv } from '../utils/command.js';
import { extractLastJsonObject } from '../utils/json.js';
import { envWithKaizenTemp } from '../utils/temp.js';
const PLACEHOLDER_ISSUE_TEXT = [
    'short github issue title',
    'issue body with goal context and the exact iteration scope',
    'issue body for the next iteration',
    'replace this sentence with the actual'
];
const nextIssueSchema = z
    .object({
    title: z.string().trim().min(12),
    body: z.string().trim().min(80),
    priority: z.enum(['P0', 'P1', 'P2']).default('P2')
})
    .strict()
    .superRefine((issue, context) => {
    const normalized = `${issue.title}\n${issue.body}`.toLowerCase().replace(/\s+/g, ' ').trim();
    if (PLACEHOLDER_ISSUE_TEXT.some((placeholder) => normalized.includes(placeholder))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal issue contains placeholder text.' });
    }
    if (/<[^>\n]+>/.test(`${issue.title}\n${issue.body}`)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal issue contains unresolved template text.' });
    }
    if (!/(acceptance criteria|受入条件|受け入れ条件)/i.test(issue.body)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['body'],
            message: 'Goal issue body must include explicit acceptance criteria.'
        });
    }
});
const planSchema = z
    .object({
    status: z.enum(['issue', 'succeeded', 'blocked']),
    reason: z.string().default(''),
    nextIssue: nextIssueSchema.nullish()
})
    .strict();
const evaluationSchema = z
    .object({
    status: z.enum(['succeeded', 'continue', 'blocked', 'failed']),
    confidence: z.number().min(0).max(1).default(0),
    reason: z.string().default(''),
    satisfiedCriteria: z.array(z.string()).default([]),
    missingCriteria: z.array(z.string()).default([]),
    nextIssue: nextIssueSchema.nullish()
})
    .strict();
export class GoalAgentAdapter {
    runCommand;
    options;
    constructor(runCommand, options) {
        this.runCommand = runCommand;
        this.options = options;
    }
    async plan(req) {
        let payload;
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                payload = await this.run(attempt === 1 ? req : {
                    ...req,
                    prompt: `${req.prompt}\n\nThe previous response failed validation:\n${validationFeedback(lastError)}\nReturn only valid JSON with a repository-specific title and a body of at least 80 characters containing an explicit Acceptance Criteria section. Replace every example and template token with actual content; do not emit angle brackets or text beginning with "Replace this sentence".`
                }, planSchema, 'planner');
                break;
            }
            catch (error) {
                lastError = error;
            }
        }
        if (!payload)
            throw lastError;
        if (payload.status === 'issue' && !payload.nextIssue) {
            return { status: 'blocked', reason: 'Goal planner returned status "issue" without nextIssue.' };
        }
        return { ...payload, nextIssue: payload.nextIssue ?? undefined };
    }
    async evaluate(req) {
        const payload = await this.run(req, evaluationSchema, 'evaluator');
        return { ...payload, nextIssue: payload.nextIssue ?? undefined };
    }
    async run(req, schema, mode) {
        const resultPath = path.isAbsolute(this.options.resultPath)
            ? this.options.resultPath
            : path.join(req.stateDir, this.options.resultPath);
        await fs.rm(resultPath, { force: true });
        await fs.mkdir(path.dirname(resultPath), { recursive: true });
        const schemaPath = path.join(req.stateDir, `${mode}-output-schema.json`);
        const diagnosticPath = path.join(req.stateDir, `${mode}-diagnostic.json`);
        await fs.rm(diagnosticPath, { force: true });
        const structuredCodex = path.basename(this.options.command) === 'codex';
        if (structuredCodex) {
            await fs.writeFile(schemaPath, JSON.stringify(toOpenAIStrictSchema(z.toJSONSchema(schema)), null, 2), { mode: 0o600 });
        }
        const env = await envWithKaizenTemp(buildUntrustedEnv(process.env, this.options.envAllowlist, {
            KAIZEN_GOAL_RESULT_PATH: resultPath,
            KAIZEN_GOAL_MODE: mode
        }), req.cwd);
        const args = structuredCodex
            ? withCodexStructuredOutput(this.options.args, schemaPath, resultPath)
            : this.options.args;
        const result = await this.runCommand(this.options.command, args, {
            cwd: req.cwd,
            input: req.prompt,
            timeoutMs: this.options.timeoutMinutes * 60_000,
            rejectOnNonZero: false,
            env
        });
        const raw = `${result.stdout}${result.stderr}`;
        try {
            if (result.exitCode !== 0) {
                throw new Error(`Goal ${mode} agent exited with code ${result.exitCode}.`);
            }
            const payload = (await readPayload(resultPath, schema)) ?? parsePayload(raw, schema);
            if (!payload)
                throw new Error(`Goal ${mode} agent did not return a valid JSON payload.`);
            return payload;
        }
        catch (error) {
            await fs.writeFile(diagnosticPath, JSON.stringify({
                mode,
                exitCode: result.exitCode,
                classification: classifyAgentFailure(error, raw),
                validation: validationFeedback(error),
                stdoutBytes: Buffer.byteLength(result.stdout),
                stderrBytes: Buffer.byteLength(result.stderr),
                outputHash: createHash('sha256').update(raw).digest('hex')
            }, null, 2), { mode: 0o600 }).catch(() => undefined);
            throw error;
        }
        finally {
            await Promise.all([
                fs.rm(resultPath, { force: true }).catch(() => undefined),
                fs.rm(schemaPath, { force: true }).catch(() => undefined)
            ]);
        }
    }
}
function classifyAgentFailure(error, raw) {
    if (error instanceof z.ZodError)
        return 'agent_schema_invalid';
    if (String(error).includes('exited with code'))
        return 'agent_execution_failed';
    if (!raw.trim())
        return 'agent_no_output';
    return 'agent_no_json';
}
function withCodexStructuredOutput(args, schemaPath, resultPath) {
    const promptIndex = args.at(-1) === '-' ? args.length - 1 : -1;
    const options = ['--output-schema', schemaPath, '--output-last-message', resultPath];
    if (promptIndex < 0)
        return [...args, ...options];
    return [...args.slice(0, promptIndex), ...options, ...args.slice(promptIndex)];
}
function toOpenAIStrictSchema(schema) {
    if (Array.isArray(schema))
        return schema.map(toOpenAIStrictSchema);
    if (!schema || typeof schema !== 'object')
        return schema;
    const value = Object.fromEntries(Object.entries(schema)
        .filter(([key]) => key !== 'default')
        .map(([key, item]) => [key, toOpenAIStrictSchema(item)]));
    if (value.type !== 'object' || !value.properties || typeof value.properties !== 'object')
        return value;
    const properties = value.properties;
    const required = new Set(Array.isArray(value.required) ? value.required : []);
    for (const key of Object.keys(properties)) {
        if (!required.has(key))
            properties[key] = { anyOf: [properties[key], { type: 'null' }] };
    }
    return { ...value, properties, required: Object.keys(properties), additionalProperties: false };
}
async function readPayload(resultPath, schema) {
    try {
        const raw = await fs.readFile(resultPath, 'utf8');
        return schema.parse(JSON.parse(raw));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function parsePayload(raw, schema) {
    let extracted;
    try {
        extracted = extractLastJsonObject(raw);
    }
    catch {
        return undefined;
    }
    return schema.parse(extracted);
}
function validationFeedback(error) {
    if (!(error instanceof z.ZodError))
        return 'No parseable JSON payload was returned.';
    return JSON.stringify(error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
        message: issue.message
    })));
}
//# sourceMappingURL=agent.js.map