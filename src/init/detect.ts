import fs from 'node:fs/promises';
import path from 'node:path';

export async function detectCommands(repoDir: string): Promise<{ setup: string | null; verify: string[] }> {
  try {
    const raw = await fs.readFile(path.join(repoDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const verify = [];
    if (scripts.test) verify.push('npm test');
    if (scripts.lint) verify.push('npm run lint');
    if (scripts.build) verify.push('npm run build');
    return { setup: 'npm ci', verify };
  } catch {
    return { setup: null, verify: [] };
  }
}
