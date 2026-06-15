import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportIssue, reportIssueNow } from '../src/commands/report.js';
import { defaultConfigYaml } from '../src/config/config.js';
import { saveRegistry } from '../src/config/registry.js';
import type { CommandRunner } from '../src/utils/command.js';

const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('kaizen report CLI', () => {
  it('creates a report-only issue as JSON', async () => {
    const { repo } = await setupProject();
    const { binDir, logPath } = await setupFakeBins();

    const { stdout } = await runCli({
      cwd: repo,
      binDir,
      args: ['report', 'CLI report', '--project', 'o-r', '--body', 'Steps', '--priority', 'P1', '--json']
    });

    const output = JSON.parse(stdout) as { number: number };
    expect(output.number).toBe(14);
    const calls = await readCalls(logPath);
    const issueCreate = calls.find((call) => call.command === 'gh' && call.args.join(' ').startsWith('issue create'));
    expect(issueCreate?.args[issueCreate.args.indexOf('--label') + 1]).toBe('kaizen,kaizen:P1');
    expect(calls.some((call) => call.command === 'builder-agent')).toBe(false);
  });

  it('creates an issue and produces a PR with report --now --json', async () => {
    const { repo } = await setupProject({ verify: ['npm test'], guardianEnabled: false });
    const { binDir, logPath } = await setupFakeBins();

    const { stdout } = await runCli({
      cwd: repo,
      binDir,
      args: ['report', 'CLI now', '--project', 'o-r', '--body', 'Dogfooding failure', '--now', '--json']
    });

    const output = JSON.parse(stdout) as { issue: { number: number }; fix: { trigger: string; issues: Array<{ outcome: string; prUrl?: string }> } };
    expect(output.issue.number).toBe(14);
    expect(output.fix.trigger).toBe('instant');
    expect(output.fix.issues[0].outcome).toBe('pr-created');
    expect(output.fix.issues[0].prUrl).toBe('https://github.com/o/r/pull/4');
    const calls = await readCalls(logPath);
    expect(calls.some((call) => call.command === 'builder-agent' && call.args.length === 0)).toBe(true);
    const prCreate = calls.find((call) => call.command === 'gh' && call.args.join(' ').startsWith('pr create'));
    expect(prCreate).toBeDefined();
    expect(prCreate?.args).not.toContain('--draft');
  });

  it('creates an issue and produces a PR with report --now --yes --json', async () => {
    const { repo } = await setupProject({ verify: ['npm test'], guardianEnabled: false });
    const { binDir, logPath } = await setupFakeBins();

    const { stdout } = await runCli({
      cwd: repo,
      binDir,
      args: ['report', 'CLI yes', '--project', 'o-r', '--body', 'Dogfooding failure', '--now', '--yes', '--json']
    });

    const output = JSON.parse(stdout) as { issue: { number: number }; fix: { trigger: string; issues: Array<{ outcome: string; prUrl?: string }> } };
    expect(output.issue.number).toBe(14);
    expect(output.fix.trigger).toBe('instant');
    expect(output.fix.issues[0].outcome).toBe('pr-created');
    expect(output.fix.issues[0].prUrl).toBe('https://github.com/o/r/pull/4');
    const calls = await readCalls(logPath);
    const issueCreate = calls.find((call) => call.command === 'gh' && call.args.join(' ').startsWith('issue create'));
    expect(issueCreate?.args[issueCreate.args.indexOf('--label') + 1]).toBe('kaizen,kaizen:P2,kaizen:ready');
    expect(calls.some((call) => call.command === 'builder-agent' && call.args.length === 0)).toBe(true);
    const prCreate = calls.find((call) => call.command === 'gh' && call.args.join(' ').startsWith('pr create'));
    expect(prCreate).toBeDefined();
    expect(prCreate?.args).not.toContain('--draft');
  });

  it('keeps report --now unqueued when --no-queue is provided', async () => {
    const { repo } = await setupProject({ verify: ['npm test'], guardianEnabled: false });
    const { binDir, logPath } = await setupFakeBins();

    await runCli({
      cwd: repo,
      binDir,
      args: ['report', 'CLI no queue', '--project', 'o-r', '--body', 'Dogfooding failure', '--now', '--no-queue', '--json']
    });

    const calls = await readCalls(logPath);
    const issueCreate = calls.find((call) => call.command === 'gh' && call.args.join(' ').startsWith('issue create'));
    expect(issueCreate?.args[issueCreate.args.indexOf('--label') + 1]).toBe('kaizen,kaizen:P2');
    expect(calls.some((call) => call.command === 'builder-agent' && call.args.length === 0)).toBe(true);
  });

  it('rejects --yes without --now', async () => {
    const { repo } = await setupProject();
    const { binDir } = await setupFakeBins();

    await expect(runCli({
      cwd: repo,
      binDir,
      args: ['report', 'CLI report', '--project', 'o-r', '--yes']
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('--yes can only be used with --now')
    });
  });
});

describe('reportIssue', () => {
  it('creates a kaizen issue without running the fixer', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/issues/14\n');
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(14, 'Bug report')));
      }
      return result(command, args, options?.cwd, '');
    });

    const created = await reportIssue({
      cwd: repo,
      project: 'o-r',
      title: 'Bug report',
      body: 'Steps to reproduce',
      priority: 'P1',
      direct: true,
      prOnly: false,
      agent: 'codex',
      extraLabels: ['customer-impact'],
      runCommand: runner
    });

    expect(created.number).toBe(14);
    const createArgs = runner.mock.calls.find(([, args]) => args.join(' ').startsWith('issue create'))?.[1];
    expect(createArgs).toContain('--label');
    expect(createArgs?.[createArgs.indexOf('--label') + 1]).toBe('kaizen,kaizen:P1,customer-impact,kaizen:direct,kaizen:agent:codex');
    expect(runner.mock.calls.some(([command]) => command === 'builder-agent')).toBe(false);
  });

  it('adds the configured queue label when requested', async () => {
    const { repo } = await setupProject();
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/issues/14\n');
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(14, 'Queued report')));
      }
      return result(command, args, options?.cwd, '');
    });

    await reportIssue({
      cwd: repo,
      project: 'o-r',
      title: 'Queued report',
      body: 'Ready for loop',
      priority: 'P2',
      direct: false,
      prOnly: false,
      queue: true,
      extraLabels: [],
      runCommand: runner
    });

    const labelCreates = runner.mock.calls.filter(([, args]) => args.join(' ').startsWith('label create'));
    expect(labelCreates.map(([, args]) => args[2])).toEqual(['kaizen', 'kaizen:ready']);
    const createArgs = runner.mock.calls.find(([, args]) => args.join(' ').startsWith('issue create'))?.[1];
    expect(createArgs?.[createArgs.indexOf('--label') + 1]).toBe('kaizen,kaizen:P2,kaizen:ready');
  });
});

describe('reportIssueNow', () => {
  it('creates an issue and immediately produces a PR through the instant pipeline', async () => {
    const { repo, workspace } = await setupProject({ verify: ['npm test'], guardianEnabled: false });
    const runner = vi.fn<CommandRunner>(async (command, args, options) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/issues/14\n');
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return result(command, args, repo, JSON.stringify(issue(14, 'Report now bug')));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return result(command, args, repo, 'https://github.com/o/r/pull/4\n');
      }
      if (command === 'gh') return result(command, args, repo, '');
      if (command === 'builder-agent' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'builder-agent') {
        await writeJsonResult(options?.env?.KAIZEN_BUILD_RESULT_PATH, { status: 'fixed', summary: '直した', notes: '' });
        return result(command, args, workspace, 'built');
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, workspace, 'ok');
      if (command === 'verifier') {
        await writeJsonResult(options?.env?.KAIZEN_VERIFIER_RESULT_PATH, { status: 'open_pr', summary: '確認した', notes: '' });
        return result(command, args, workspace, 'verified');
      }
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return result(command, args, repo, 'https://github.com/o/r.git\n');
      if (command === 'git' && args.join(' ') === 'status --porcelain') return result(command, args, workspace, '');
      if (command === 'git' && args.join(' ') === 'diff --name-only origin/main...HEAD') return result(command, args, workspace, 'src/file.ts\n');
      if (command === 'git' && args.join(' ') === 'diff --numstat origin/main...HEAD') return result(command, args, workspace, '1\t0\tsrc/file.ts\n');
      if (command === 'sh' && args.join(' ') === '-lc npm test') return result(command, args, workspace, 'ok');
      return result(command, args, options?.cwd, '');
    });

    const output = await reportIssueNow({
      cwd: repo,
      project: 'o-r',
      title: 'Report now bug',
      body: 'Found by dogfooding',
      priority: 'P2',
      direct: false,
      prOnly: false,
      extraLabels: [],
      json: true,
      runCommand: runner
    });

    expect(output.issue.number).toBe(14);
    expect('issues' in output.fix && output.fix.trigger).toBe('instant');
    expect('issues' in output.fix && output.fix.issues[0].number).toBe(14);
    expect('issues' in output.fix && output.fix.issues[0].outcome).toBe('pr-created');
    expect('issues' in output.fix && output.fix.issues[0].prUrl).toBe('https://github.com/o/r/pull/4');
    const createArgs = runner.mock.calls.find(([, args]) => args.join(' ').startsWith('issue create'))?.[1];
    expect(createArgs?.[createArgs.indexOf('--label') + 1]).toBe('kaizen,kaizen:P2');
    const prCreateArgs = runner.mock.calls.find(([, args]) => args.join(' ').startsWith('pr create'))?.[1];
    expect(prCreateArgs).toBeDefined();
    expect(prCreateArgs).not.toContain('--draft');
  });
});

async function setupProject(options: { verify?: string[]; guardianEnabled?: boolean } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-repo-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-workspace-'));
  vi.stubEnv('KAIZEN_HOME', home);
  await fs.mkdir(path.join(repo, '.kaizen'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  let config = defaultConfigYaml({ agent: 'claude', setup: null, verify: options.verify ?? [] });
  if (options.guardianEnabled === false) {
    config = config.replace('guardian:\n  enabled: true', 'guardian:\n  enabled: false');
  }
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
  return { repo, workspace };
}

async function setupFakeBins() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-bin-'));
  const logPath = path.join(binDir, 'calls.jsonl');
  await writeExecutable(path.join(binDir, 'gh'), fakeGhScript(logPath));
  await writeExecutable(path.join(binDir, 'git'), fakeGitScript(logPath));
  await writeExecutable(path.join(binDir, 'sh'), fakeShScript(logPath));
  await writeExecutable(path.join(binDir, 'builder-agent'), fakeBuilderScript(logPath));
  await writeExecutable(path.join(binDir, 'verifier'), fakeVerifierScript(logPath));
  return { binDir, logPath };
}

async function runCli(options: { cwd: string; binDir: string; args: string[] }) {
  return execFileAsync(
    process.execPath,
    [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(process.cwd(), 'src', 'cli.ts'), ...options.args],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: `${options.binDir}${path.delimiter}${process.env.PATH ?? ''}`
      }
    }
  );
}

async function readCalls(logPath: string) {
  const raw = await fs.readFile(logPath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { command: string; args: string[]; cwd: string });
}

async function writeExecutable(filePath: string, contents: string) {
  await fs.writeFile(filePath, contents, { mode: 0o755 });
}

function fakeGhScript(logPath: string) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command: 'gh', args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'issue' && args[1] === 'create') {
  console.log('https://github.com/o/r/issues/14');
} else if (args[0] === 'issue' && args[1] === 'view') {
  console.log(JSON.stringify({
    number: 14,
    title: 'CLI now',
    body: '',
    labels: [{ name: 'kaizen' }],
    createdAt: '2026-06-12T00:00:00Z',
    comments: [],
    url: 'https://github.com/o/r/issues/14'
  }));
} else if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/o/r/pull/4');
}
`;
}

function fakeGitScript(logPath: string) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command: 'git', args, cwd: process.cwd() }) + '\\n');
const joined = args.join(' ');
if (joined === 'remote get-url origin') {
  console.log('https://github.com/o/r.git');
} else if (joined === 'diff --name-only origin/main...HEAD') {
  console.log('src/file.ts');
} else if (joined === 'diff --numstat origin/main...HEAD') {
  console.log('1\\t0\\tsrc/file.ts');
}
`;
}

function fakeBuilderScript(logPath: string) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command: 'builder-agent', args, cwd: process.cwd() }) + '\\n');
if (args[0] === '--version') {
  console.log('ok');
} else {
  fs.writeFileSync(process.env.KAIZEN_BUILD_RESULT_PATH, JSON.stringify({ status: 'fixed', summary: 'fixed', notes: '' }));
  console.log('built');
}
`;
}

function fakeShScript(logPath: string) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command: 'sh', args, cwd: process.cwd() }) + '\\n');
console.log('ok');
`;
}

function fakeVerifierScript(logPath: string) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command: 'verifier', args, cwd: process.cwd() }) + '\\n');
if (args[0] === '--version') {
  console.log('ok');
} else {
  fs.writeFileSync(process.env.KAIZEN_VERIFIER_RESULT_PATH, JSON.stringify({ status: 'open_pr', summary: 'verified', notes: '' }));
  console.log('verified');
}
`;
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
