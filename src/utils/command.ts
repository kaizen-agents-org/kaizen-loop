import { spawn } from 'node:child_process';
import { envWithKaizenTemp } from './temp.js';

export interface CommandResult {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunCommandOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  rejectOnNonZero?: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: RunCommandOptions
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, options = {}) => {
  const started = Date.now();
  const baseEnv = options.env ?? process.env;
  const env = hasInjectedTempEnv(baseEnv) ? baseEnv : await envWithKaizenTemp(baseEnv, options.cwd);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (settled) return;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }, options.timeoutMs);
      timeout.unref();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const result: CommandResult = {
        command,
        args,
        cwd: options.cwd,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started
      };
      if (options.rejectOnNonZero !== false && result.exitCode !== 0) {
        const err = new Error(formatCommandFailure(result));
        Object.assign(err, { result });
        reject(err);
      } else {
        resolve(result);
      }
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
};

function hasInjectedTempEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TMPDIR && env.TMPDIR === env.TMP && env.TMPDIR === env.TEMP);
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}

export function formatCommandFailure(result: CommandResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return [
    `Command failed (${result.exitCode}): ${formatCommand(result.command, result.args)}`,
    stderr ? `stderr:\n${stderr}` : undefined,
    stdout ? `stdout:\n${stdout}` : undefined
  ]
    .filter(Boolean)
    .join('\n');
}
