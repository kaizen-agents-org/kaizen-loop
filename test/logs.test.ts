import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followLogs, readLogs } from '../src/commands/logs.js';
import { saveRegistry } from '../src/config/registry.js';

describe('readLogs', () => {
  it('reads the latest run summary by default', async () => {
    const { home, repo } = await setupProject();
    const runDir = path.join(home, 'projects', 'o-r', 'runs', '2026-06-17T01-00-00Z');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'summary.json'), '{"result":"success"}\n');

    await expect(readLogs({ cwd: repo, project: 'o-r' })).resolves.toBe('{"result":"success"}\n');
  });

  it('combines agent and verify logs for an issue', async () => {
    const { home, repo } = await setupProject();
    const issueDir = path.join(home, 'projects', 'o-r', 'runs', '2026-06-17T01-00-00Z', 'issue-12');
    await fs.mkdir(issueDir, { recursive: true });
    await fs.writeFile(path.join(issueDir, 'agent.log'), 'agent output\n');
    await fs.writeFile(path.join(issueDir, 'verify.log'), 'verify output\n');

    await expect(readLogs({ cwd: repo, project: 'o-r', issue: 12 })).resolves.toBe('agent output\n\n\nverify output\n');
  });
});

describe('followLogs', () => {
  it('emits existing log content before waiting for new output', async () => {
    const { home, repo } = await setupProject();
    const runDir = path.join(home, 'projects', 'o-r', 'runs', '2026-06-17T01-00-00Z');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'summary.json'), 'initial summary\n');
    const controller = new AbortController();
    const chunks: string[] = [];

    await followLogs({
      cwd: repo,
      project: 'o-r',
      intervalMs: 1,
      signal: controller.signal,
      write: (chunk) => {
        chunks.push(chunk);
        controller.abort();
      }
    });

    expect(chunks.join('')).toBe('initial summary\n');
  });
});

async function setupProject(): Promise<{ home: string; repo: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await saveRegistry({
    version: 1,
    projects: {
      'o-r': {
        repo: 'o/r',
        localPath: repo,
        workspacePath: workspace,
        schedule: '02:00',
        enabled: false,
        createdAt: '2026-06-12T00:00:00Z'
      }
    }
  });
  return { home, repo };
}
