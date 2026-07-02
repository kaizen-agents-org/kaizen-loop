import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { envWithKaizenTemp } from './temp.js';

export const DEFAULT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'KAIZEN_TMPDIR',
  'KAIZEN_HOME',
  'GH_CONFIG_DIR',
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND'
];

const GITHUB_CLI_AUTH_ENV_ALLOWLIST = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

const activeChildren = new Set<ChildProcessWithoutNullStreams>();
let shutdownHooksInstalled = false;
let requestedShutdownSignal: NodeJS.Signals | undefined;

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
  throwIfShutdownRequested();
  const started = Date.now();
  const env = await envWithKaizenTemp(options.env ?? buildAllowlistedEnv(process.env, DEFAULT_ENV_ALLOWLIST), options.cwd);
  installShutdownHooks();
  throwIfShutdownRequested();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const clearTimers = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminateProcessTree(child, 'SIGTERM');
        forceKillTimeout = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 10_000);
        forceKillTimeout.unref();
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
      clearTimers();
      activeChildren.delete(child);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      activeChildren.delete(child);
      const result: CommandResult = {
        command,
        args,
        cwd: options.cwd,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started
      };
      if (timedOut) {
        const err = new Error(`Command timed out after ${options.timeoutMs}ms: ${formatCommand(command, args)}`);
        Object.assign(err, { result });
        reject(err);
        return;
      }
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

export function buildAllowlistedEnv(
  source: NodeJS.ProcessEnv,
  allowlist: string[],
  extra: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function githubCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GITHUB_CLI_AUTH_ENV_ALLOWLIST]);
}

export function withRunDeadline(runCommand: CommandRunner, deadlineAt: number): CommandRunner {
  return async (command, args, options = {}) => {
    return runCommand(command, args, {
      ...options,
      timeoutMs: timeoutWithinDeadline(options.timeoutMs, deadlineAt)
    });
  };
}

export function throwIfShutdownRequested(): void {
  if (requestedShutdownSignal) {
    throw new Error(`Received ${requestedShutdownSignal}; shutting down.`);
  }
}

function timeoutWithinDeadline(configuredTimeoutMs: number | undefined, deadlineAt: number): number {
  throwIfShutdownRequested();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Kaizen run timeout exceeded.');
  return configuredTimeoutMs === undefined || configuredTimeoutMs <= 0
    ? remainingMs
    : Math.min(configuredTimeoutMs, remainingMs);
}

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      requestedShutdownSignal = signal;
      process.exitCode = 128 + (signal === 'SIGINT' ? 2 : 15);
      for (const child of activeChildren) {
        terminateProcessTree(child, 'SIGTERM');
        setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 10_000).unref();
      }
    });
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const taskkillArgs = ['/pid', String(child.pid), '/T'];
      if (signal === 'SIGKILL') taskkillArgs.push('/F');
      spawn('taskkill', taskkillArgs, { stdio: 'ignore', detached: true }).unref();
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
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
