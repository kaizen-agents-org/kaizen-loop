import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
    'KAIZEN_HOME'
];
const GITHUB_CLI_AUTH_ENV_ALLOWLIST = [
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN'
];
const GIT_CLI_AUTH_ENV_ALLOWLIST = ['SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'];
const INITIAL_GH_EXECUTABLE = resolveExecutable('gh', process.env.PATH);
const activeChildren = new Set();
const PROCESS_TERMINATION_GRACE_MS = 250;
let shutdownHooksInstalled = false;
let requestedShutdownSignal;
export const runCommand = async (command, args, options = {}) => {
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
        let timeout;
        let forceKillTimeout;
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
                if (settled)
                    return;
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
            if (settled)
                return;
            settled = true;
            clearTimers();
            activeChildren.delete(child);
            reject(error);
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            void terminateProcessTreeAndWait(child).then(() => {
                clearTimers();
                activeChildren.delete(child);
                const result = {
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
                }
                else {
                    resolve(result);
                }
            }, (error) => {
                clearTimers();
                activeChildren.delete(child);
                reject(error);
            });
        });
        if (options.input) {
            child.stdin.write(options.input);
        }
        child.stdin.end();
    });
};
export function buildAllowlistedEnv(source, allowlist, extra = {}) {
    const env = {};
    for (const key of allowlist) {
        const value = source[key];
        if (value !== undefined)
            env[key] = value;
    }
    for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined)
            env[key] = value;
    }
    return env;
}
export function githubCliEnv(source = process.env) {
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GITHUB_CLI_AUTH_ENV_ALLOWLIST]);
}
export function gitCliEnv(source = process.env) {
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GIT_CLI_AUTH_ENV_ALLOWLIST]);
}
export function gitPublicationEnv(source = process.env, ghExecutable = INITIAL_GH_EXECUTABLE) {
    if (!ghExecutable)
        throw new Error('Could not resolve the gh executable before publication.');
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GIT_CLI_AUTH_ENV_ALLOWLIST, ...GITHUB_CLI_AUTH_ENV_ALLOWLIST], {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '!"$KAIZEN_GH_EXECUTABLE" auth git-credential',
        KAIZEN_GH_EXECUTABLE: ghExecutable
    });
}
function resolveExecutable(command, searchPath) {
    for (const directory of searchPath?.split(path.delimiter) ?? []) {
        if (!directory)
            continue;
        const candidate = path.join(directory, command);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return fs.realpathSync(candidate);
        }
        catch {
            // Try the next PATH entry.
        }
    }
    return undefined;
}
export function gitSshPublicationEnv(source = process.env) {
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GIT_CLI_AUTH_ENV_ALLOWLIST], { GIT_SSH_COMMAND: source.GIT_SSH_COMMAND ?? 'ssh' });
}
export function withRunDeadline(runCommand, deadlineAt) {
    return async (command, args, options = {}) => {
        return runCommand(command, args, {
            ...options,
            timeoutMs: timeoutWithinDeadline(options.timeoutMs, deadlineAt)
        });
    };
}
export function throwIfShutdownRequested() {
    if (requestedShutdownSignal) {
        throw new Error(`Received ${requestedShutdownSignal}; shutting down.`);
    }
}
function timeoutWithinDeadline(configuredTimeoutMs, deadlineAt) {
    throwIfShutdownRequested();
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0)
        throw new Error('Kaizen run timeout exceeded.');
    return configuredTimeoutMs === undefined || configuredTimeoutMs <= 0
        ? remainingMs
        : Math.min(configuredTimeoutMs, remainingMs);
}
function installShutdownHooks() {
    if (shutdownHooksInstalled)
        return;
    shutdownHooksInstalled = true;
    for (const signal of ['SIGINT', 'SIGTERM']) {
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
function terminateProcessTree(child, signal) {
    if (child.pid === undefined)
        return;
    try {
        if (process.platform === 'win32') {
            const taskkillArgs = ['/pid', String(child.pid), '/T'];
            if (signal === 'SIGKILL')
                taskkillArgs.push('/F');
            spawn('taskkill', taskkillArgs, { stdio: 'ignore', detached: true }).unref();
            return;
        }
        process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch {
            // Process already exited.
        }
    }
}
async function terminateProcessTreeAndWait(child) {
    if (child.pid === undefined)
        return;
    if (process.platform === 'win32') {
        await runTaskkill(child.pid, false);
        await runTaskkill(child.pid, true);
        return;
    }
    terminateProcessTree(child, 'SIGTERM');
    if (await waitForProcessGroupExit(child.pid, PROCESS_TERMINATION_GRACE_MS))
        return;
    terminateProcessTree(child, 'SIGKILL');
    await waitForProcessGroupExit(child.pid);
}
async function waitForProcessGroupExit(pid, timeoutMs) {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (processGroupExists(pid)) {
        if (deadline !== undefined && Date.now() >= deadline)
            return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
}
function processGroupExists(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
function runTaskkill(pid, force) {
    return new Promise((resolve) => {
        const args = ['/pid', String(pid), '/T'];
        if (force)
            args.push('/F');
        const taskkill = spawn('taskkill', args, { stdio: 'ignore' });
        taskkill.on('error', () => resolve());
        taskkill.on('close', () => resolve());
    });
}
export function formatCommand(command, args) {
    return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}
export function formatCommandFailure(result) {
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
//# sourceMappingURL=command.js.map