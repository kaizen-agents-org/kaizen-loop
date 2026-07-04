import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BuilderAgentAdapter } from '../src/agents/builder.js';
import { VerifierAgentAdapter } from '../src/agents/verifier.js';
import { parseAgentResult } from '../src/agents/claude.js';
import { buildFixPrompt, buildVerifierPrompt } from '../src/agents/prompt.js';
import { configSchema } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('parseAgentResult', () => {
  it('extracts final json from claude json result', () => {
    const parsed = parseAgentResult(
      JSON.stringify({
        result:
          'done\n```json\n{"status":"fixed","summary":"直した","notes":"","discoveredIssues":[{"title":"Verifier false positive","repo":"verifier","evidence":"verifier.log"}]}\n```'
      }),
      123
    );

    expect(parsed.status).toBe('fixed');
    expect(parsed.summary).toBe('直した');
    expect(parsed.discoveredIssues).toEqual([
      {
        title: 'Verifier false positive',
        repo: 'verifier',
        evidence: 'verifier.log'
      }
    ]);
    expect(parsed.durationMs).toBe(123);
  });
});

describe('BuilderAgentAdapter', () => {
  it('reads the build result file produced by builder-agent', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-builder-'));
    const runner: CommandRunner = async (command, args, options) => {
      expect(command).toBe('builder-agent');
      expect(args).toEqual([]);
      if (typeof options?.env?.KAIZEN_BUILD_RESULT_PATH !== 'string') throw new Error('missing result path');
      expect(options.env.SECRET_TOKEN).toBeUndefined();
      await fs.writeFile(
        options.env.KAIZEN_BUILD_RESULT_PATH,
        JSON.stringify({
          status: 'fixed',
          summary: '直した',
          notes: 'なし',
          discoveredIssues: [{ title: '別バグ', repo: 'kaizen-loop', body: '見つけた' }]
        })
      );
      return { command, args, cwd: options?.cwd, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 123 };
    };

    const adapter = new BuilderAgentAdapter(runner, {
      command: 'builder-agent',
      resultPath: '.kaizen/builder/build-result.json',
      envAllowlist: ['PATH']
    });
    const previousSecretToken = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = 'do-not-pass';
    let result: Awaited<ReturnType<BuilderAgentAdapter['run']>>;
    try {
      result = await adapter.run({ workspaceDir: workspace, prompt: 'fix it', timeoutMs: 1000 });
    } finally {
      if (previousSecretToken === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = previousSecretToken;
    }

    expect(result.status).toBe('fixed');
    expect(result.summary).toBe('直した');
    expect(result.discoveredIssues).toEqual([{ title: '別バグ', repo: 'kaizen-loop', body: '見つけた' }]);
    await expect(fs.access(path.join(workspace, '.kaizen', 'builder', 'build-result.json'))).rejects.toThrow();
  });
});

describe('VerifierAgentAdapter', () => {
  async function runVerifier(payload: Record<string, unknown>) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-verifier-'));
    const previousSecretToken = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = 'do-not-pass';
    const runner: CommandRunner = async (command, args, options) => {
      if (typeof options?.env?.KAIZEN_VERIFIER_RESULT_PATH !== 'string') throw new Error('missing result path');
      expect(options.env.SECRET_TOKEN).toBeUndefined();
      await fs.writeFile(options.env.KAIZEN_VERIFIER_RESULT_PATH, JSON.stringify(payload));
      return { command, args, cwd: options?.cwd, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 };
    };
    const adapter = new VerifierAgentAdapter(runner, {
      command: 'verifier',
      resultPath: '.kaizen/verifier/verify-result.json',
      timeoutMinutes: 1,
      envAllowlist: ['PATH']
    });
    try {
      return await adapter.run({ workspaceDir: workspace, prompt: 'review' });
    } finally {
      if (previousSecretToken === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = previousSecretToken;
    }
  }

  it.each([
    ['open_pr', 'open_pr'],
    ['open_pr_with_warning', 'open_pr_with_warning'],
    ['block_pr', 'block_pr'],
    ['needs_context', 'needs_context']
  ])('passes through gate status %s', async (status, expected) => {
    const result = await runVerifier({ status, summary: 's', notes: '' });
    expect(result.status).toBe(expected);
  });

  it.each([
    ['approved', 'open_pr'],
    ['pr_only', 'open_pr_with_warning'],
    ['rejected', 'block_pr']
  ])('maps legacy status %s to %s', async (legacy, expected) => {
    const result = await runVerifier({ status: legacy, summary: 's', notes: '' });
    expect(result.status).toBe(expected);
  });

  it('treats unknown status as an error', async () => {
    const result = await runVerifier({ status: 'nonsense', summary: 's', notes: '' });
    expect(result.status).toBe('error');
  });
});

describe('buildVerifierPrompt', () => {
  it('uses the conservative PR-creation gate vocabulary', () => {
    const prompt = buildVerifierPrompt({
      repo: 'o/r',
      issue: {
        number: 7,
        title: 'Fix bug',
        body: 'body',
        labels: [{ name: 'kaizen' }],
        createdAt: '2026-06-13T00:00:00Z',
        comments: []
      },
      agentResult: { status: 'fixed', summary: '直した', notes: '', raw: '', durationMs: 1 },
      verifyResults: [{ command: 'npm test', ok: true, output: '' }],
      diff: { changedFiles: 1, changedLines: 1, files: ['src/file.ts'], forbiddenFiles: [], protectedFiles: [] },
      diffText: 'diff --git a/src/file.ts b/src/file.ts'
    });

    expect(prompt).toContain('"open_pr"');
    expect(prompt).toContain('open_pr_with_warning');
    expect(prompt).toContain('block_pr');
    expect(prompt).toContain('needs_context');
    expect(prompt).not.toContain('"approved"');
    expect(prompt).toContain('NOT approving the change for merge');
  });

  it('includes diff text and verification log evidence', () => {
    const prompt = buildVerifierPrompt({
      repo: 'o/r',
      issue: {
        number: 7,
        title: 'Fix bug',
        body: 'body',
        labels: [{ name: 'kaizen' }],
        createdAt: '2026-06-13T00:00:00Z',
        comments: []
      },
      agentResult: { status: 'fixed', summary: '直した', notes: 'builder notes', raw: '', durationMs: 1 },
      verifyResults: [{ command: "python3 <<'PY'\nprint('ok')\nPY", ok: true, output: 'PASS verifier evidence\n' }],
      diff: { changedFiles: 1, changedLines: 2, files: ['src/file.ts'], forbiddenFiles: [], protectedFiles: [] },
      diffText: ['diff --git a/src/file.ts b/src/file.ts', '+const verified = true;'].join('\n')
    });

    expect(prompt).toContain('# Verification logs');
    expect(prompt).toContain("python3 <<'PY'\nprint('ok')\nPY");
    expect(prompt).toContain('PASS verifier evidence');
    expect(prompt).toContain('# Diff');
    expect(prompt).toContain('diff --git a/src/file.ts b/src/file.ts');
    expect(prompt).toContain('+const verified = true;');
    expect(prompt).toContain('builder notes');
  });
});

describe('buildFixPrompt', () => {
  it('distinguishes protected paths from forbidden paths', () => {
    const config = configSchema.parse({
      version: 1,
      policy: {
        protectedPaths: ['.github/**', '.kaizen/**'],
        forbiddenPaths: ['**/.git/**', '**/.env*']
      }
    });

    const prompt = buildFixPrompt({
      repo: 'o/r',
      config,
      attempt: 1,
      issue: {
        number: 42,
        title: 'Update workflow',
        body: 'Need a workflow update',
        labels: [{ name: 'kaizen' }],
        createdAt: '2026-06-13T00:00:00Z',
        comments: []
      }
    });

    expect(prompt).toContain('Do not modify forbidden paths: **/.git/**, **/.env*');
    expect(prompt).toContain('Protected path changes will be reviewed by PR: .github/**, .kaizen/**');
    expect(prompt).toContain('Add it to "discoveredIssues" in the final JSON');
    expect(prompt).not.toContain('forbidden/protected path');
  });

  it('keeps git commit ownership in the orchestrator', () => {
    const config = configSchema.parse({
      version: 1,
      commands: {
        verify: ['npm test']
      }
    });

    const prompt = buildFixPrompt({
      repo: 'o/r',
      config,
      attempt: 1,
      issue: {
        number: 139,
        title: 'Keep builder prompt scoped to file edits',
        body: 'Builder should leave changed files for kaizen-loop orchestration.',
        labels: [{ name: 'kaizen' }],
        createdAt: '2026-06-13T00:00:00Z',
        comments: []
      }
    });

    expect(prompt).toContain('Do not run git push, gh commands, or create pull requests.');
    expect(prompt).toContain('Leave your file changes uncommitted in the workspace.');
    expect(prompt).toContain('kaizen-loop will commit, push, and open a pull request after verification.');
    expect(prompt).not.toContain('Commit your changes');
    expect(prompt).not.toContain('git commit');
  });

  it('renders heredoc verification commands as runnable shell', () => {
    const heredoc = "python3 <<'PY'\nprint('ok')\nPY";
    const config = configSchema.parse({
      version: 1,
      commands: {
        verify: [heredoc, 'npm test']
      }
    });

    const prompt = buildFixPrompt({
      repo: 'o/r',
      config,
      attempt: 1,
      issue: {
        number: 50,
        title: 'Generated verification heredoc command is not shell-runnable',
        body: 'Heredoc verify commands must be runnable',
        labels: [{ name: 'kaizen' }],
        createdAt: '2026-06-13T00:00:00Z',
        comments: []
      }
    });

    expect(prompt).toContain("5. Verify with:\n```sh\nset -e\npython3 <<'PY'\nprint('ok')\nPY\nnpm test\n```");
    expect(prompt).not.toContain('PY && npm test');

    const match = prompt.match(/5\. Verify with:\n```sh\n([\s\S]*?)\n```/);
    if (!match) throw new Error('missing verification shell block');

    const syntaxCheck = spawnSync('sh', ['-n'], { input: match[1], encoding: 'utf8' });
    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });
});
