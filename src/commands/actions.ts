import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseAgentResult } from '../agents/claude.js';
import { buildFixPrompt, buildVerifierPrompt } from '../agents/prompt.js';
import type { AgentResult } from '../agents/types.js';
import { VerifierAgentAdapter } from '../agents/verifier.js';
import { loadConfig } from '../config/config.js';
import type { KaizenConfig } from '../config/schema.js';
import { GitHubClient } from '../github/client.js';
import type { GitHubIssue } from '../github/types.js';
import { runCommand, type CommandRunner } from '../utils/command.js';
import { slugify } from '../utils/slug.js';
import { GitClient } from '../workspace/git.js';
import { WorkspaceManager } from '../workspace/manager.js';

const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const PROVIDER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'partial', 'blocked'] },
    summary: { type: 'string' },
    notes: { type: 'string' },
    blockedReason: { type: 'string' },
    discoveredIssues: { type: 'array' }
  },
  required: ['status', 'summary', 'notes', 'discoveredIssues'],
  additionalProperties: true
} as const;

const providerResultSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  finalMessage: z.string().min(1),
  attempts: z.array(z.object({
    provider: z.enum(['codex', 'claude']),
    status: z.enum(['selected', 'failed']),
    failureClass: z.enum(['none', 'external_action_failure'])
  }).strict()).default([])
}).strict();

const verifiedArtifactSchema = z.object({
  version: z.literal(1),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  issue: z.object({ number: z.number().int().positive(), title: z.string() }).strict(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  provider: z.enum(['codex', 'claude']),
  providerAttempts: z.array(z.object({
    provider: z.enum(['codex', 'claude']),
    status: z.enum(['selected', 'failed']),
    failureClass: z.enum(['none', 'external_action_failure'])
  }).strict()),
  builder: z.object({ summary: z.string(), notes: z.string() }).strict(),
  verification: z.array(z.object({ command: z.string(), ok: z.boolean(), output: z.string() }).strict()),
  verifier: z.object({
    status: z.enum(['open_pr', 'open_pr_with_warning']),
    summary: z.string(),
    notes: z.string(),
    reason: z.string().optional()
  }).strict(),
  files: z.array(z.string()),
  createdAt: z.string()
}).strict();

export interface PrepareActionsFixOptions {
  cwd: string;
  issue: number;
  outputDir: string;
  runCommand?: CommandRunner;
}

export async function prepareActionsFix(options: PrepareActionsFixOptions) {
  const command = options.runCommand ?? runCommand;
  const context = await loadActionsContext(options.cwd, options.issue, command);
  await assertAuthorized(context.github, context.repo, context.issue, context.config);
  const git = new GitClient(command, options.cwd);
  const baseSha = await git.revParse('HEAD');
  const prompt = buildFixPrompt({ repo: context.repo, issue: context.issue, config: context.config, attempt: 1 });
  await fs.rm(options.outputDir, { recursive: true, force: true });
  await fs.mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(options.outputDir, 'prompt.md'), prompt);
  await fs.writeFile(path.join(options.outputDir, 'provider-output.schema.json'), `${JSON.stringify(PROVIDER_OUTPUT_SCHEMA, null, 2)}\n`);
  await fs.writeFile(path.join(options.outputDir, 'context.json'), `${JSON.stringify({
    version: 1,
    repo: context.repo,
    issue: context.issue.number,
    baseSha
  }, null, 2)}\n`);
  return { repo: context.repo, issue: context.issue.number, baseSha, promptPath: path.join(options.outputDir, 'prompt.md') };
}

export interface VerifyActionsFixOptions {
  cwd: string;
  issue: number;
  patchPath: string;
  providerResultPath: string;
  outputDir: string;
  runCommand?: CommandRunner;
}

export async function verifyActionsFix(options: VerifyActionsFixOptions) {
  const command = options.runCommand ?? runCommand;
  const context = await loadActionsContext(options.cwd, options.issue, command);
  await assertAuthorized(context.github, context.repo, context.issue, context.config);
  const patch = await readBoundedPatch(options.patchPath);
  const provider = providerResultSchema.parse(JSON.parse(await fs.readFile(options.providerResultPath, 'utf8')));
  const builder = parseAgentResult(provider.finalMessage);
  if (builder.status === 'blocked') throw new Error(`Provider reported blocked: ${builder.blockedReason ?? builder.summary}`);
  if (builder.status === 'error') throw new Error(`Provider failed: ${builder.summary}`);

  const git = new GitClient(command, options.cwd);
  const baseSha = await git.revParse('HEAD');
  await applyPatch(command, options.cwd, options.patchPath);
  await assertWorkingTreeMatchesPatch(command, options.cwd, sha256(patch));
  const workspace = new WorkspaceManager(command, options.cwd);
  const setup = await workspace.runSetup(context.config);
  if (setup && !setup.ok) throw new Error(`Setup failed: ${setup.command}\n${setup.output}`);
  const verification = await workspace.runVerify(context.config);
  const failed = verification.find((result) => !result.ok);
  if (failed) throw new Error(`Verification failed: ${failed.command}\n${failed.output}`);
  await assertWorkingTreeMatchesPatch(command, options.cwd, sha256(patch));

  const diff = await workspace.collectWorkingTreeDiffStats(context.config);
  if (diff.changedFiles === 0) throw new Error('Provider produced no file changes.');
  if (diff.forbiddenFiles.length) throw new Error(`Patch changes forbidden paths: ${diff.forbiddenFiles.join(', ')}`);
  const diffText = await workspace.collectWorkingTreeDiffText();
  const verifier = new VerifierAgentAdapter(command, {
    ...context.config.verifier,
    envAllowlist: context.config.safety.envAllowlist
  });
  if (!(await verifier.isAvailable())) throw new Error(`Trusted verifier is unavailable: ${context.config.verifier.command}`);
  const verdict = await verifier.run({
    workspaceDir: options.cwd,
    prompt: buildVerifierPrompt({ repo: context.repo, issue: context.issue, agentResult: builder, verifyResults: verification, diff, diffText })
  });
  if (verdict.status !== 'open_pr' && verdict.status !== 'open_pr_with_warning') {
    throw new Error(`Verifier rejected patch (${verdict.status}): ${verdict.reason ?? verdict.summary}`);
  }
  await assertWorkingTreeMatchesPatch(command, options.cwd, sha256(patch));

  const artifact = verifiedArtifactSchema.parse({
    version: 1,
    repo: context.repo,
    issue: { number: context.issue.number, title: context.issue.title },
    baseSha,
    patchSha256: sha256(patch),
    provider: provider.provider,
    providerAttempts: provider.attempts.length
      ? provider.attempts
      : [{ provider: provider.provider, status: 'selected', failureClass: 'none' }],
    builder: { summary: builder.summary, notes: builder.notes },
    verification,
    verifier: {
      status: verdict.status,
      summary: verdict.summary,
      notes: verdict.notes,
      ...(verdict.reason ? { reason: verdict.reason } : {})
    },
    files: diff.files,
    createdAt: new Date().toISOString()
  });
  await fs.rm(options.outputDir, { recursive: true, force: true });
  await fs.mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(options.outputDir, 'change.patch'), patch, { mode: 0o600 });
  await fs.writeFile(path.join(options.outputDir, 'manifest.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

export interface PublishActionsFixOptions {
  cwd: string;
  artifactDir: string;
  runCommand?: CommandRunner;
}

export async function publishActionsFix(options: PublishActionsFixOptions) {
  const command = options.runCommand ?? runCommand;
  const artifact = verifiedArtifactSchema.parse(JSON.parse(await fs.readFile(path.join(options.artifactDir, 'manifest.json'), 'utf8')));
  const patchPath = path.join(options.artifactDir, 'change.patch');
  const patch = await readBoundedPatch(patchPath);
  if (sha256(patch) !== artifact.patchSha256) throw new Error('Verified patch hash does not match the publish artifact.');
  const context = await loadActionsContext(options.cwd, artifact.issue.number, command);
  if (context.repo !== artifact.repo || context.issue.title !== artifact.issue.title) throw new Error('Issue metadata changed after verification.');
  await assertAuthorized(context.github, context.repo, context.issue, context.config);

  const git = new GitClient(command, options.cwd);
  const head = await git.revParse('HEAD');
  if (head !== artifact.baseSha) throw new Error(`Publish checkout ${head} does not match verified base ${artifact.baseSha}.`);
  await applyPatch(command, options.cwd, patchPath);
  const workspace = new WorkspaceManager(command, options.cwd);
  const diff = await workspace.collectWorkingTreeDiffStats(context.config);
  if (diff.forbiddenFiles.length) throw new Error(`Patch changes forbidden paths: ${diff.forbiddenFiles.join(', ')}`);
  if (JSON.stringify([...diff.files].sort()) !== JSON.stringify([...artifact.files].sort())) {
    throw new Error('Publish patch file set does not match the verified artifact.');
  }

  const branch = `${context.config.git.branchPrefix}issue-${artifact.issue.number}-${slugify(artifact.issue.title, 32)}-${artifact.patchSha256.slice(0, 8)}`;
  const summary = firstLine(artifact.builder.summary, 100);
  await command('git', ['switch', '-c', branch], { cwd: options.cwd });
  await command('git', ['add', '-A', '--', ...artifact.files], { cwd: options.cwd });
  await command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `kaizen: ${summary} (#${artifact.issue.number})`], { cwd: options.cwd });
  await git.push(branch);
  const body = buildPullRequestBody(artifact);
  const pr = await context.github.createPullRequest({
    base: context.config.git.defaultBranch,
    head: branch,
    title: `kaizen: ${summary} (#${artifact.issue.number})`,
    body,
    expectedClosingIssueNumber: artifact.issue.number
  });
  return { ...pr, branch, body };
}

async function loadActionsContext(cwd: string, issueNumber: number, command: CommandRunner) {
  const config = await loadConfig(cwd);
  if (config.safety.operationMode !== 'external') throw new Error('GitHub Actions execution requires safety.operationMode: external.');
  if (config.policy.mode !== 'pr-only') throw new Error('GitHub Actions execution requires policy.mode: pr-only.');
  const repoResult = await command('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
  const repo = repoResult.stdout.trim();
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`Could not resolve GitHub repository: ${repo}`);
  const github = new GitHubClient(command, cwd);
  const issue = await github.getIssue(issueNumber);
  return { config, repo, github, issue };
}

async function assertAuthorized(github: GitHubClient, repo: string, issue: GitHubIssue, config: KaizenConfig) {
  const eligible = issue.labels.some((label) => label.name.toLowerCase() === config.issues.label.toLowerCase());
  if (!eligible) throw new Error(`Missing Kaizen eligibility label: ${config.issues.label}`);
  const authorization = config.issues.executionAuthorization;
  const labelActive = issue.labels.some((label) => label.name.toLowerCase() === authorization.label.toLowerCase());
  if (!labelActive) throw new Error(`Missing execution authorization label: ${authorization.label}`);
  const decision = await github.checkExecutionAuthorization({
    repo,
    issue: issue.number,
    label: authorization.label,
    minimumPermission: authorization.minimumPermission
  });
  if (!decision.authorized) throw new Error(`Execution is not authorized: ${decision.reason}`);
}

async function readBoundedPatch(patchPath: string): Promise<Buffer> {
  const stats = await fs.stat(patchPath);
  if (stats.size === 0) throw new Error('Provider produced an empty patch.');
  if (stats.size > MAX_PATCH_BYTES) throw new Error(`Patch exceeds ${MAX_PATCH_BYTES} bytes.`);
  return fs.readFile(patchPath);
}

async function applyPatch(command: CommandRunner, cwd: string, patchPath: string) {
  await command('git', ['apply', '--check', '--binary', patchPath], { cwd });
  await command('git', ['apply', '--index', '--binary', patchPath], { cwd });
}

async function assertWorkingTreeMatchesPatch(command: CommandRunner, cwd: string, expectedHash: string) {
  const diff = await command('git', ['diff', '--binary', 'HEAD'], { cwd });
  if (sha256(Buffer.from(diff.stdout)) !== expectedHash) {
    throw new Error('Setup, verification, or verifier changed the provider patch.');
  }
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function firstLine(value: string, maxLength: number): string {
  return value.split(/\r?\n/, 1)[0].trim().slice(0, maxLength) || 'implement issue';
}

function buildPullRequestBody(artifact: z.infer<typeof verifiedArtifactSchema>): string {
  const verification = artifact.verification.map((result) => `- [x] \`${result.command}\``).join('\n') || '- Not configured';
  const attempts = artifact.providerAttempts.map((attempt) => `${attempt.provider}:${attempt.status}:${attempt.failureClass}`).join(', ');
  return `## Summary\n- ${artifact.builder.summary}\n\n## Actions workflow evidence\n- Provider: ${artifact.provider}\n- Provider attempts: ${attempts}\n- Base: \`${artifact.baseSha}\`\n- Patch SHA-256: \`${artifact.patchSha256}\`\n- Verifier: ${artifact.verifier.status} — ${artifact.verifier.summary}\n\n## Verification\n${verification}\n\n## Risk / known limitations\n${artifact.verifier.reason ?? (artifact.verifier.notes || 'None reported.')}\n\nCloses #${artifact.issue.number}`;
}

export function encodeProviderResult(provider: 'codex' | 'claude', finalMessage: string): string {
  const parsed = providerResultSchema.parse({ provider, finalMessage });
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
