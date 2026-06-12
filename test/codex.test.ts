import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/agents/codex.js';
import type { CommandRunner } from '../src/utils/command.js';

describe('CodexAdapter', () => {
  it('runs codex exec with workspace-write sandbox and parses last message', async () => {
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      const outputIndex = args.indexOf('--output-last-message');
      if (outputIndex >= 0) {
        await fs.mkdir(path.dirname(String(args[outputIndex + 1])), { recursive: true });
        await fs.writeFile(String(args[outputIndex + 1]), '```json\n{"status":"fixed","summary":"done","notes":""}\n```');
      }
      return { command, args, exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    });
    const adapter = new CodexAdapter(runner);

    const result = await adapter.run({
      workspaceDir: '/workspace',
      prompt: 'fix it',
      timeoutMs: 1000
    });

    expect(result.status).toBe('fixed');
    expect(runner.mock.calls[0][0]).toBe('codex');
    expect(runner.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['exec', '--json', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-C', '/workspace'])
    );
  });
});
