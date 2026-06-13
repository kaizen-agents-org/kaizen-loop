import fs from 'node:fs/promises';
import { BuilderAgentAdapter } from '../agents/builder.js';
import { VerifierAgentAdapter } from '../agents/verifier.js';
import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import type { KaizenConfig } from '../config/schema.js';
import { GitHubClient } from '../github/client.js';
import type { CommandRunner } from '../utils/command.js';

export async function doctorProject(options: { cwd: string; project?: string; repair?: boolean; runCommand: CommandRunner }) {
  const checks: Array<{ name: string; ok: boolean; message?: string }> = [];
  const resolved = await resolveProject(options.project, options.cwd);
  let config: KaizenConfig | undefined;
  await check(checks, 'config', async () => {
    config = await loadConfig(resolved.project.localPath);
  });
  await check(checks, 'gh auth', async () => void (await new GitHubClient(options.runCommand, resolved.project.localPath).authStatus()));
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
  await check(checks, 'workspace', async () => void (await fs.access(resolved.project.workspacePath)));
  return { slug: resolved.slug, checks, ok: checks.every((item) => item.ok) };
}

async function check(checks: Array<{ name: string; ok: boolean; message?: string }>, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, message: String(error) });
  }
}
