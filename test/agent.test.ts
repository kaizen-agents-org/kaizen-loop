import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuilderAgentAdapter } from '../src/agents/builder.js';
import { parseAgentResult } from '../src/agents/claude.js';
import { buildFixPrompt } from '../src/agents/prompt.js';
import { configSchema } from '../src/config/schema.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('parseAgentResult', () => {
  it('extracts final json from claude json result', () => {
    const parsed = parseAgentResult(
      JSON.stringify({
        result: 'done\n```json\n{"status":"fixed","summary":"直した","notes":""}\n```'
      }),
      123
    );

    expect(parsed.status).toBe('fixed');
    expect(parsed.summary).toBe('直した');
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
      await fs.writeFile(
        options.env.KAIZEN_BUILD_RESULT_PATH,
        JSON.stringify({ status: 'fixed', summary: '直した', notes: 'なし' })
      );
      return { command, args, cwd: options?.cwd, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 123 };
    };

    const adapter = new BuilderAgentAdapter(runner, {
      command: 'builder-agent',
      resultPath: '.kaizen/builder/build-result.json'
    });
    const result = await adapter.run({ workspaceDir: workspace, prompt: 'fix it', timeoutMs: 1000 });

    expect(result.status).toBe('fixed');
    expect(result.summary).toBe('直した');
    await expect(fs.access(path.join(workspace, '.kaizen', 'builder', 'build-result.json'))).rejects.toThrow();
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
    expect(prompt).not.toContain('forbidden/protected path');
  });
});
