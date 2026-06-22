import fs from 'node:fs/promises';
import { BuilderAgentAdapter } from '../agents/builder.js';
import { ClaudeCodeAdapter } from '../agents/claude.js';
import { CodexAdapter } from '../agents/codex.js';
import { VerifierAgentAdapter } from '../agents/verifier.js';
import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import type { KaizenConfig } from '../config/schema.js';
import { GitHubClient } from '../github/client.js';
import { isPrGuardianSkillRunnerAvailable } from '../orchestrator/prGuardian.js';
import type { CommandRunner } from '../utils/command.js';
import { ensureKaizenTempDir } from '../utils/temp.js';

export async function doctorProject(options: { cwd: string; project?: string; repair?: boolean; runCommand: CommandRunner }) {
  const checks: Array<{ name: string; ok: boolean; message?: string }> = [];
  const resolved = await resolveProject(options.project, options.cwd);
  let config: KaizenConfig | undefined;
  await check(checks, 'config', async () => {
    config = await loadConfig(resolved.project.localPath);
  });
  await check(checks, 'gh auth', async () => void (await new GitHubClient(options.runCommand, resolved.project.localPath).authStatus()));
  await check(checks, 'github labels', async () => {
    const loaded = config;
    if (!loaded) throw new Error('config unavailable');
    if (!options.repair) return;
    await new GitHubClient(options.runCommand, resolved.project.localPath).createLabels(requiredLabels(loaded));
  });
  await check(checks, 'temporary directory', async () => {
    await ensureKaizenTempDir(resolved.project.workspacePath);
  });
  for (const agent of configuredAgents(config)) {
    await check(checks, `${agent} auth`, async () => {
      const adapter = agent === 'codex' ? new CodexAdapter(options.runCommand) : new ClaudeCodeAdapter(options.runCommand);
      if (!(await adapter.isAvailable())) throw new Error('unavailable');
    });
  }
  await check(checks, 'builder agent', async () => {
    const loaded = config;
    if (!loaded) throw new Error('config unavailable');
    if (!(await new BuilderAgentAdapter(options.runCommand, loaded.builder).isAvailable())) throw new Error('unavailable');
  });
  await check(checks, 'verifier agent', async () => {
    const loaded = config;
    if (!loaded) throw new Error('config unavailable');
    if (!loaded.verifier.enabled) return;
    if (!(await new VerifierAgentAdapter(options.runCommand, loaded.verifier).isAvailable())) throw new Error('unavailable');
  });
  await check(checks, 'pr guardian skill runner', async () => {
    const loaded = config;
    if (!loaded) throw new Error('config unavailable');
    if (!loaded.guardian.enabled) return;
    if (!(await isPrGuardianSkillRunnerAvailable(loaded, options.runCommand))) throw new Error('unavailable');
  });
  await check(checks, 'workspace', async () => void (await fs.access(resolved.project.workspacePath)));
  return { slug: resolved.slug, checks, ok: checks.every((item) => item.ok) };
}

function configuredAgents(config: KaizenConfig | undefined): Array<'claude' | 'codex'> {
  if (!config) return [];
  const agents: Array<'claude' | 'codex'> = [config.agent.default];
  const fallback = config.agent.default === 'codex' ? 'claude' : 'codex';
  if (config.agent.fallback && !agents.includes(fallback)) agents.push(fallback);
  return agents;
}

function requiredLabels(config: KaizenConfig): string[] {
  return [...new Set([
    config.issues.label,
    ...config.issues.priorityOrder,
    config.issues.selection.includeLabel,
    ...config.issues.selection.excludeLabels,
    'kaizen:direct',
    'kaizen:pr-only',
    'kaizen:in-progress',
    'kaizen:needs-human',
    config.goal.issueLabel,
    'kaizen:agent:claude',
    'kaizen:agent:codex'
  ])];
}

async function check(checks: Array<{ name: string; ok: boolean; message?: string }>, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, message: String(error) });
  }
}
