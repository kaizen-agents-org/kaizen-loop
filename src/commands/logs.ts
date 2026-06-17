import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProject } from '../config/registry.js';
import { projectStateDir } from '../utils/paths.js';

interface LogOptions {
  cwd: string;
  project?: string;
  run?: string;
  issue?: number;
}

export async function readLogs(options: LogOptions): Promise<string> {
  const files = await logFiles(options);
  const chunks = await Promise.all(files.map(readOptional));
  return chunks.filter((chunk) => chunk.length > 0).join('\n\n');
}

export async function followLogs(
  options: LogOptions & {
    intervalMs?: number;
    signal?: AbortSignal;
    write?: (chunk: string) => void;
  }
): Promise<void> {
  const files = await logFiles(options);
  if (files.length === 0) return;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const positions = new Map<string, number>();
  const intervalMs = options.intervalMs ?? 1000;

  while (!options.signal?.aborted) {
    for (const file of files) {
      const content = await readOptional(file);
      const previous = positions.get(file) ?? 0;
      const offset = content.length < previous ? 0 : previous;
      if (content.length > offset) {
        write(content.slice(offset));
        positions.set(file, content.length);
      }
    }
    await delay(intervalMs, options.signal);
  }
}

async function logFiles(options: LogOptions): Promise<string[]> {
  const resolved = await resolveProject(options.project, options.cwd);
  const runsDir = path.join(projectStateDir(resolved.slug), 'runs');
  const run = options.run ?? (await latestRun(runsDir));
  if (!run) return [];
  if (!options.issue) return [path.join(runsDir, run, 'summary.json')];
  const issueDir = path.join(runsDir, run, `issue-${options.issue}`);
  return [path.join(issueDir, 'agent.log'), path.join(issueDir, 'verify.log')];
}

async function readOptional(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function latestRun(runsDir: string): Promise<string | undefined> {
  try {
    return (await fs.readdir(runsDir)).sort().at(-1);
  } catch {
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let abort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (abort) signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    abort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
