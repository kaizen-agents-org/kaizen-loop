import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { runSandboxSmoke } from '../src/commands/smoke.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runSandboxSmoke', () => {
  it('runs the instant issue-to-PR pipeline and persists a smoke artifact', async () => {
    const { repo, workspace, home } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/issues/14\n');
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(14, 'Sandbox smoke')));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify({
          number: 4,
          url: 'https://github.com/o/r/pull/4',
          baseRefName: 'main',
          isDraft: false,
          closingIssuesReferences: [{ number: 14, url: 'https://github.com/o/r/issues/14' }]
        }));
      }
      if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      }
      if (command === 'gh') return result(command, args, repo, '');
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: 'smoke updated', notes: '' });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'open_pr', summary: 'verified', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'docs/sandbox-smoke.md\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tdocs/sandbox-smoke.md\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const artifact = await runSandboxSmoke({
      cwd: repo,
      project: 'o-r',
      title: 'Sandbox smoke',
      body: 'Record a harmless smoke marker.',
      priority: 'P2',
      json: true,
      assumeYes: true,
      runCommand: runner
    });

    expect(artifact.kind).toBe('sandbox-e2e-smoke');
    expect(artifact.issue.number).toBe(14);
    expect(artifact.implementation.branch).toBe('kaizen/issue-14-sandbox-smoke');
    expect(artifact.verification.commands).toEqual(['npm test']);
    expect(artifact.verification.verifier.verdict).toBe('open_pr');
    expect(artifact.pullRequest).toMatchObject({
      number: 4,
      url: 'https://github.com/o/r/pull/4',
      baseRefName: 'main',
      defaultBranch: 'main',
      isDraft: false,
      issueLinkRecognized: true
    });
    expect(artifact.artifactPath).toContain(path.join(home, 'projects', 'o-r', 'smoke-runs'));
    const persisted = JSON.parse(await fs.readFile(artifact.artifactPath, 'utf8'));
    expect(persisted.pullRequest.issueLinkRecognized).toBe(true);
    expect(await fileExists(artifact.run.summaryPath)).toBe(true);
    const labelCreates = runner.mock.calls.filter(([, args]) => args[0] === 'label' && args[1] === 'create');
    expect(labelCreates.map(([, args]) => args[2])).toEqual(['kaizen', 'kaizen:ready', 'kaizen:pr-only', 'kaizen', 'kaizen:ready']);
    const issueCreate = runner.mock.calls.find(([, args]) => args[0] === 'issue' && args[1] === 'create');
    expect(issueCreate?.[1][issueCreate[1].indexOf('--label') + 1]).toBe('kaizen,kaizen:P2,kaizen:ready,kaizen:pr-only');
  });
});

async function setupProject() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const config = defaultConfigYaml({ agent: 'claude', setup: null, verify: ['npm test'] })
    .replace('guardian:\n  enabled: true', 'guardian:\n  enabled: false');
  await fs.writeFile(path.join(repo, '.kaizen', 'config.yml'), config);
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
  return { home, repo, workspace };
}

function issue(number: number, title: string) {
  return {
    number,
    title,
    body: '',
    labels: [{ name: 'kaizen' }],
    createdAt: '2026-06-12T00:00:00Z',
    comments: [],
    url: `https://github.com/o/r/issues/${number}`
  };
}

function result(command: string, args: string[], cwd: string | undefined, stdout: string) {
  return {
    command,
    args,
    cwd,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1
  };
}

async function writeJsonResult(filePath: unknown, payload: unknown) {
  if (typeof filePath !== 'string') throw new Error('missing result path');
  await fs.writeFile(filePath, JSON.stringify(payload));
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
