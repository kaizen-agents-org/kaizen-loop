import fs from 'node:fs/promises';
import { ClaudeCodeAdapter } from '../agents/claude.js';
import { CodexAdapter } from '../agents/codex.js';
import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import type { CommandRunner } from '../utils/command.js';

export async function doctorProject(options: { cwd: string; project?: string; repair?: boolean; runCommand: CommandRunner }) {
  const checks: Array<{ name: string; ok: boolean; message?: string }> = [];
  const resolved = await resolveProject(options.project, options.cwd);
  await check(checks, 'config', async () => void (await loadConfig(resolved.project.localPath)));
  await check(checks, 'gh auth', async () => void (await new GitHubClient(options.runCommand, resolved.project.localPath).authStatus()));
  await check(checks, 'claude agent', async () => {
    if (!(await new ClaudeCodeAdapter(options.runCommand).isAvailable())) throw new Error('unavailable');
  });
  await check(checks, 'codex agent', async () => {
    if (!(await new CodexAdapter(options.runCommand).isAvailable())) throw new Error('unavailable');
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
