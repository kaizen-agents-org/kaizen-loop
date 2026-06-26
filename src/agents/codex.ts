import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandRunner } from '../utils/command.js';
import { ensureKaizenTempDir } from '../utils/temp.js';
import { parseAgentResult } from './claude.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;

  constructor(private readonly runCommand: CommandRunner) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.runCommand('codex', ['login', 'status'], { rejectOnNonZero: true, timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const tempRoot = await ensureKaizenTempDir(req.workspaceDir);
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'kaizen-codex-'));
    const outputPath = path.join(tempDir, 'last-message.txt');
    const args = [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-C',
      req.workspaceDir,
      '--output-last-message',
      outputPath
    ];
    if (req.model) args.push('--model', req.model);
    args.push(req.prompt);

    try {
      const result = await this.runCommand('codex', args, {
        cwd: req.workspaceDir,
        timeoutMs: req.timeoutMs,
        rejectOnNonZero: false
      });
      const lastMessage = await fs.readFile(outputPath, 'utf8').catch(() => '');
      const raw = `${result.stdout}${result.stderr}\n${lastMessage}`;
      if (result.exitCode !== 0) {
        return {
          status: 'error',
          summary: `Codex exited with code ${result.exitCode}`,
          notes: '',
          discoveredIssues: [],
          raw,
          durationMs: result.durationMs
        };
      }
      return parseAgentResult(lastMessage || raw, result.durationMs);
    } catch (error) {
      return {
        status: 'error',
        summary: String(error),
        notes: '',
        discoveredIssues: [],
        raw: String(error),
        durationMs: req.timeoutMs
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
