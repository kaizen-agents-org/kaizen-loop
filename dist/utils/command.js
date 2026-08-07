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
const SUPERVISOR_CREDENTIAL_ENV = new Set([...GITHUB_CLI_AUTH_ENV_ALLOWLIST, ...GIT_CLI_AUTH_ENV_ALLOWLIST]);
const TRUSTED_COMMAND_RUNNER = Symbol('trustedCommandRunner');
export const INITIAL_GIT_EXECUTABLE = resolveTrustedExecutable('git', process.env.PATH);
export const INITIAL_GITHUB_CLI_EXECUTABLE = resolveTrustedExecutable('gh', process.env.PATH);
const INITIAL_SSH_EXECUTABLE = resolveTrustedExecutable('ssh', process.env.PATH);
const INITIAL_GITHUB_AUTH_ENV = captureGitHubAuthEnv(process.argv);
const INITIAL_GITHUB_TOKEN = INITIAL_GITHUB_AUTH_ENV.GH_TOKEN || INITIAL_GITHUB_AUTH_ENV.GITHUB_TOKEN;
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
Object.defineProperty(runCommand, TRUSTED_COMMAND_RUNNER, { value: true });
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
export function buildUntrustedEnv(source, allowlist, extra = {}) {
    const env = buildAllowlistedEnv(source, allowlist, extra);
    for (const key of Object.keys(env)) {
        if (SUPERVISOR_CREDENTIAL_ENV.has(key.toUpperCase()))
            delete env[key];
    }
    return env;
}
export function githubCliEnv(source = process.env) {
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GITHUB_CLI_AUTH_ENV_ALLOWLIST]);
}
export function trustedGithubCliEnv(source = process.env) {
    if (!INITIAL_GITHUB_CLI_EXECUTABLE && process.env.NODE_ENV !== 'test') {
        throw new Error('Could not resolve a trusted GitHub CLI executable.');
    }
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GITHUB_CLI_AUTH_ENV_ALLOWLIST], {
        ...INITIAL_GITHUB_AUTH_ENV,
        ...(process.env.NODE_ENV !== 'test' && INITIAL_GITHUB_CLI_EXECUTABLE ? {
            PATH: [...new Set([
                    path.dirname(INITIAL_GITHUB_CLI_EXECUTABLE),
                    ...(INITIAL_GIT_EXECUTABLE ? [path.dirname(INITIAL_GIT_EXECUTABLE)] : [])
                ])].join(path.delimiter)
        } : {})
    });
}
export function hasSupervisorGitHubToken(source = process.env) {
    return Boolean(source.GH_TOKEN ||
        source.GITHUB_TOKEN ||
        INITIAL_GITHUB_AUTH_ENV.GH_TOKEN ||
        INITIAL_GITHUB_AUTH_ENV.GITHUB_TOKEN);
}
export function gitCliEnv(source = process.env) {
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GIT_CLI_AUTH_ENV_ALLOWLIST]);
}
export function isolatedGitEnv(source = process.env) {
    return buildAllowlistedEnv(source, DEFAULT_ENV_ALLOWLIST, {
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1'
    });
}
export function gitPublicationEnv(source = process.env, initialToken = INITIAL_GITHUB_TOKEN) {
    const token = source.GH_TOKEN || source.GITHUB_TOKEN || initialToken;
    if (!token && !(process.env.NODE_ENV === 'test' && source === process.env)) {
        throw new Error('HTTPS Git publication requires GH_TOKEN or GITHUB_TOKEN in the supervisor environment.');
    }
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GIT_CLI_AUTH_ENV_ALLOWLIST], {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '!f() { test "$1" = get || exit 0; printf "%s\\n" username=x-access-token "password=$KAIZEN_GIT_PASSWORD"; }; f',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        KAIZEN_GIT_PASSWORD: token
    });
}
export function publicationGitExecutable(command) {
    if (process.env.NODE_ENV === 'test')
        return 'git';
    return command[TRUSTED_COMMAND_RUNNER]
        ? INITIAL_GIT_EXECUTABLE
        : undefined;
}
export function githubCliExecutable(command) {
    if (process.env.NODE_ENV === 'test')
        return 'gh';
    return command[TRUSTED_COMMAND_RUNNER]
        ? INITIAL_GITHUB_CLI_EXECUTABLE
        : undefined;
}
export function executableNames(command, platform = process.platform, pathExt = process.env.PATHEXT) {
    if (platform !== 'win32' || path.extname(command))
        return [command];
    const extensions = (pathExt || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extension) => extension.trim())
        .filter(Boolean)
        .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
    return [command, ...extensions.map((extension) => `${command}${extension}`)];
}
function resolveTrustedExecutable(command, searchPath) {
    return resolveExecutable(command, searchPath, isTrustedExecutablePath);
}
function resolveExecutable(command, searchPath, accept) {
    for (const directory of searchPath?.split(path.delimiter) ?? []) {
        if (!directory)
            continue;
        for (const name of executableNames(command)) {
            const candidate = path.join(directory, name);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                const resolved = fs.realpathSync(candidate);
                if (accept(resolved))
                    return resolved;
            }
            catch {
                // Try the next executable candidate.
            }
        }
    }
    return undefined;
}
export function isTrustedExecutablePath(executable) {
    if (process.platform === 'win32') {
        if (!fs.statSync(executable).isFile())
            return false;
        const trustedRoots = ['ProgramFiles', 'ProgramW6432', 'SystemRoot']
            .map((key) => process.env[key])
            .filter((value) => Boolean(value));
        return isWindowsExecutablePathTrusted(executable, trustedRoots);
    }
    const uid = process.getuid?.();
    if (uid === undefined || uid === 0)
        return false;
    const groups = new Set([process.getgid?.(), ...(process.getgroups?.() ?? [])]);
    let current = executable;
    while (true) {
        const stat = fs.statSync(current);
        if (current === executable && !stat.isFile())
            return false;
        const writable = process.env.NODE_ENV === 'test'
            ? (stat.mode & 0o002) !== 0 || ((stat.mode & 0o020) !== 0 && groups.has(stat.gid))
            : canCurrentUserWrite(current);
        if (stat.uid !== 0 || writable) {
            return false;
        }
        const parent = path.dirname(current);
        if (parent === current)
            return true;
        current = parent;
    }
}
export function isWindowsExecutablePathTrusted(executable, trustedRoots, canWrite = canCurrentUserWrite) {
    const resolved = path.win32.resolve(executable);
    const normalized = `${resolved.toLowerCase()}${path.win32.sep}`;
    if (!trustedRoots.some((root) => normalized.startsWith(`${path.win32.resolve(root).toLowerCase()}${path.win32.sep}`))) {
        return false;
    }
    let current = resolved;
    while (true) {
        if (canWrite(current))
            return false;
        const parent = path.win32.dirname(current);
        if (parent === current)
            return true;
        current = parent;
    }
}
function canCurrentUserWrite(candidate) {
    try {
        fs.accessSync(candidate, fs.constants.W_OK);
        return true;
    }
    catch (error) {
        const code = error.code;
        return code !== 'EACCES' && code !== 'EPERM';
    }
}
function captureGitHubAuthEnv(argv) {
    const captured = buildAllowlistedEnv(process.env, GITHUB_CLI_AUTH_ENV_ALLOWLIST);
    const hasToken = Boolean(captured.GH_TOKEN || captured.GITHUB_TOKEN || captured.GH_ENTERPRISE_TOKEN || captured.GITHUB_ENTERPRISE_TOKEN);
    const credentialOnlyInvocation = argv.some((arg, index) => (arg === 'actions' && (argv[index + 1] === 'prepare' || argv[index + 1] === 'publish')) || arg === 'init');
    if (hasToken && !credentialOnlyInvocation) {
        throw new Error('Refusing to start a builder-capable Kaizen process with GitHub token environment variables. Use a credential-only `init`, `actions prepare`, or `actions publish` phase, or an external broker.');
    }
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
        delete process.env[key];
    }
    return captured;
}
export function gitSshPublicationEnv(source = process.env, sshExecutable = INITIAL_SSH_EXECUTABLE) {
    if (!sshExecutable)
        throw new Error('Could not resolve a trusted SSH executable before publication.');
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GIT_CLI_AUTH_ENV_ALLOWLIST], {
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_SSH_COMMAND: `'${sshExecutable.replaceAll("'", "'\\''")}' -F '${process.platform === 'win32' ? 'NUL' : '/dev/null'}'`
    });
}
export function withRunDeadline(runCommand, deadlineAt) {
    const deadlineCommand = async (command, args, options = {}) => {
        return runCommand(command, args, {
            ...options,
            timeoutMs: timeoutWithinDeadline(options.timeoutMs, deadlineAt)
        });
    };
    if (runCommand[TRUSTED_COMMAND_RUNNER]) {
        Object.defineProperty(deadlineCommand, TRUSTED_COMMAND_RUNNER, { value: true });
    }
    return deadlineCommand;
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