import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProject } from '../config/registry.js';
import { projectStateDir } from '../utils/paths.js';

export async function readLogs(options: { cwd: string; project?: string; run?: string; issue?: number }) {
  const resolved = await resolveProject(options.project, options.cwd);
  const runsDir = path.join(projectStateDir(resolved.slug), 'runs');
  const run = options.run ?? (await latestRun(runsDir));
  if (!run) return '';
  const file = options.issue
    ? path.join(runsDir, run, `issue-${options.issue}`, 'agent.log')
    : path.join(runsDir, run, 'summary.json');
  return fs.readFile(file, 'utf8');
}

async function latestRun(runsDir: string): Promise<string | undefined> {
  try {
    return (await fs.readdir(runsDir)).sort().at(-1);
  } catch {
    return undefined;
  }
}
