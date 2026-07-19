import fs from 'node:fs/promises';
import path from 'node:path';
import { STACK_DETECTION_TABLE, type StackDetectionRule } from './stackDetection.js';

export async function detectCommands(repoDir: string): Promise<{ setup: string | null; verify: string[] }> {
  for (const rule of STACK_DETECTION_TABLE) {
    if (!(await manifestExists(repoDir, rule.manifest))) continue;

    const verify = rule.id === 'node'
      ? await detectNodeVerifyCommands(repoDir, rule)
      : rule.verify.map((proposal) => proposal.command);
    if (verify === null) continue;

    return { setup: rule.setup, verify };
  }

  return { setup: null, verify: [] };
}

async function manifestExists(repoDir: string, manifest: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(repoDir, manifest))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function detectNodeVerifyCommands(repoDir: string, rule: StackDetectionRule): Promise<string[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(repoDir, rule.manifest), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }

  if (!isRecord(parsed)) return null;
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};
  return rule.verify
    .filter((proposal) => {
      if (!proposal.packageScript) return true;
      const script = scripts[proposal.packageScript];
      return typeof script === 'string' && script.trim().length > 0;
    })
    .map((proposal) => proposal.command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
