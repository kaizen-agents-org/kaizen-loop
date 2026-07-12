import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GoalAgentAdapter } from '../src/goals/agent.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('GoalAgentAdapter', () => {
  it('enforces structured output for Codex and cleans temporary artifacts', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-agent-'));
    const run = vi.fn<CommandRunner>(async (command, args, options) => {
      const outputIndex = args.indexOf('--output-last-message');
      const schemaIndex = args.indexOf('--output-schema');
      expect(command).toBe('codex');
      expect(args.at(-1)).toBe('-');
      expect(JSON.parse(await fs.readFile(args[schemaIndex + 1], 'utf8'))).toMatchObject({ type: 'object' });
      const outputSchema = JSON.parse(await fs.readFile(args[schemaIndex + 1], 'utf8')) as { required: string[] };
      expect(outputSchema.required).toContain('nextIssue');
      await fs.writeFile(args[outputIndex + 1], JSON.stringify({ status: 'blocked', reason: 'No safe work.', nextIssue: null }));
      return { command, args, cwd: options?.cwd, exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    });
    const adapter = new GoalAgentAdapter(run, {
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only', '-'],
      resultPath: 'goal-result.json',
      timeoutMinutes: 1,
      envAllowlist: []
    });

    await expect(adapter.plan({ cwd: stateDir, stateDir, prompt: 'Plan.' })).resolves.toMatchObject({ status: 'blocked' });
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  });

  it('rejects non-zero agent exits even when a payload exists', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-agent-'));
    const run = vi.fn<CommandRunner>(async (command, args, options) => {
      const outputIndex = args.indexOf('--output-last-message');
      await fs.writeFile(args[outputIndex + 1], JSON.stringify({ status: 'blocked', reason: 'stale', nextIssue: null }));
      return { command, args, cwd: options?.cwd, exitCode: 1, stdout: '', stderr: '', durationMs: 1 };
    });
    const adapter = new GoalAgentAdapter(run, {
      command: 'codex', args: ['exec', '-'], resultPath: 'goal-result.json', timeoutMinutes: 1, envAllowlist: []
    });

    await expect(adapter.plan({ cwd: stateDir, stateDir, prompt: 'Plan.' })).rejects.toThrow(/exited with code 1/);
  });
});
