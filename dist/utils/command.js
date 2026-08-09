import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
const SUPERVISOR_CREDENTIAL_ENV = new Set([
    ...GITHUB_CLI_AUTH_ENV_ALLOWLIST,
    ...GIT_CLI_AUTH_ENV_ALLOWLIST,
    'KAIZEN_GITHUB_TOKEN_SOCKET',
    'KAIZEN_GITHUB_BROKER_CAPABILITY'
]);
const TRUSTED_COMMAND_RUNNER = Symbol('trustedCommandRunner');
export class TrustedGitHubCliUnavailableError extends Error {
    reasonCode = 'trusted_github_cli_unavailable';
    constructor(message = trustedGitHubCliRemediation()) {
        super(message);
        this.name = 'TrustedGitHubCliUnavailableError';
    }
}
export const INITIAL_GIT_EXECUTABLE = resolveTrustedExecutable('git', process.env.PATH);
export const INITIAL_GITHUB_CLI_EXECUTABLE = resolveTrustedExecutable('gh', process.env.PATH);
const INITIAL_SSH_EXECUTABLE = resolveTrustedExecutable('ssh', process.env.PATH);
const INITIAL_GITHUB_AUTH_ENV = captureGitHubAuthEnv(process.argv.slice(2));
const INITIAL_GITHUB_TOKEN = INITIAL_GITHUB_AUTH_ENV.GH_TOKEN || INITIAL_GITHUB_AUTH_ENV.GITHUB_TOKEN;
const INITIAL_GITHUB_TOKEN_SOCKET = resolveConfiguredBrokerSocket(process.env.KAIZEN_GITHUB_TOKEN_SOCKET);
const INITIAL_GITHUB_BROKER_CAPABILITY = resolveBrokerCapability(process.env.KAIZEN_GITHUB_BROKER_CAPABILITY);
const INITIAL_GITHUB_PUBLICATION_TIMEOUT_MS = publicationTimeoutMs(process.env.KAIZEN_GITHUB_PUBLICATION_TIMEOUT_MS);
const activeChildren = new Set();
const activePublicationSockets = new Set();
const PROCESS_TERMINATION_GRACE_MS = 250;
let shutdownHooksInstalled = false;
let requestedShutdownSignal;
export const COMMAND_RUNNER_INJECTION = Symbol.for('kaizen.commandRunnerInjection');
export function processCommandRunner(defaultRunner, executables = initialTrustedExecutables()) {
    return globalThis[COMMAND_RUNNER_INJECTION]
        ?? withTrustedExecutables(defaultRunner, executables);
}
const executeCommand = async (command, args, options = {}) => {
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
export const runCommand = withTrustedExecutables(executeCommand, initialTrustedExecutables());
function initialTrustedExecutables() {
    return {
        git: INITIAL_GIT_EXECUTABLE,
        githubCli: INITIAL_GITHUB_CLI_EXECUTABLE,
        ssh: INITIAL_SSH_EXECUTABLE,
        githubToken: INITIAL_GITHUB_TOKEN,
        githubPublisher: INITIAL_GITHUB_TOKEN_SOCKET
            ? (request, timeoutMs) => requestGithubPublication(INITIAL_GITHUB_TOKEN_SOCKET, INITIAL_GITHUB_BROKER_CAPABILITY, request, Math.min(INITIAL_GITHUB_PUBLICATION_TIMEOUT_MS, timeoutMs ?? INITIAL_GITHUB_PUBLICATION_TIMEOUT_MS))
            : undefined,
        githubPublicationPreflight: INITIAL_GITHUB_TOKEN_SOCKET
            ? (request, timeoutMs) => requestGithubPublicationPreflight(INITIAL_GITHUB_TOKEN_SOCKET, INITIAL_GITHUB_BROKER_CAPABILITY, request, Math.min(INITIAL_GITHUB_PUBLICATION_TIMEOUT_MS, timeoutMs ?? INITIAL_GITHUB_PUBLICATION_TIMEOUT_MS))
            : undefined
    };
}
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
export function trustedGithubCliEnv(source = process.env, githubCliExecutable = INITIAL_GITHUB_CLI_EXECUTABLE, gitExecutable = INITIAL_GIT_EXECUTABLE) {
    if (!githubCliExecutable) {
        throw new Error('Could not resolve a trusted GitHub CLI executable.');
    }
    return buildAllowlistedEnv(source, [...DEFAULT_ENV_ALLOWLIST, ...GITHUB_CLI_AUTH_ENV_ALLOWLIST], {
        ...INITIAL_GITHUB_AUTH_ENV,
        PATH: [...new Set([
                path.dirname(githubCliExecutable),
                ...(gitExecutable ? [path.dirname(gitExecutable)] : [])
            ])].join(path.delimiter)
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
    if (!token) {
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
    return command[TRUSTED_COMMAND_RUNNER]?.git;
}
export function githubCliExecutable(command) {
    return command[TRUSTED_COMMAND_RUNNER]?.githubCli;
}
export function requireTrustedGitHubCliExecutable(command) {
    const executable = githubCliExecutable(command);
    if (!executable)
        throw new TrustedGitHubCliUnavailableError();
    return executable;
}
function trustedGitHubCliRemediation() {
    return 'Trusted GitHub CLI executable was not found before untrusted work. Install gh in an immutable root-owned path reachable on PATH before starting Kaizen, then reinstall managed scheduler jobs.';
}
export function publicationSshExecutable(command) {
    return command[TRUSTED_COMMAND_RUNNER]?.ssh;
}
export function publicationGithubToken(command) {
    return command[TRUSTED_COMMAND_RUNNER]?.githubToken;
}
export function publicationGithubPublisher(command) {
    return command[TRUSTED_COMMAND_RUNNER]?.githubPublisher;
}
export function publicationGithubPreflight(command) {
    return command[TRUSTED_COMMAND_RUNNER]
        ?.githubPublicationPreflight;
}
export function withTrustedExecutables(command, executables) {
    const trustedCommand = (executable, args, options) => command(executable, args, options);
    Object.defineProperty(trustedCommand, TRUSTED_COMMAND_RUNNER, { value: Object.freeze({ ...executables }) });
    return trustedCommand;
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
function resolveConfiguredBrokerSocket(socketPath) {
    if (!socketPath)
        return undefined;
    if (process.platform === 'win32')
        throw new Error('KAIZEN_GITHUB_TOKEN_SOCKET requires a Unix platform.');
    if (!path.isAbsolute(socketPath))
        throw new Error('KAIZEN_GITHUB_TOKEN_SOCKET must be an absolute path.');
    let resolved;
    try {
        resolved = fs.realpathSync(socketPath);
        const stat = fs.statSync(resolved);
        if (!stat.isSocket() || stat.uid !== 0) {
            throw new Error('untrusted socket owner');
        }
        let current = path.dirname(resolved);
        while (true) {
            const directory = fs.statSync(current);
            if (directory.uid !== 0 || (directory.mode & 0o022) !== 0 || canCurrentUserWrite(current)) {
                throw new Error('untrusted socket directory');
            }
            const parent = path.dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    catch {
        throw new Error('KAIZEN_GITHUB_TOKEN_SOCKET must resolve to a root-owned broker socket in immutable root-owned directories.');
    }
    return resolved;
}
function resolveBrokerCapability(value) {
    if (value === undefined)
        return undefined;
    if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error('KAIZEN_GITHUB_BROKER_CAPABILITY must be a 64-character lowercase hexadecimal value.');
    }
    delete process.env.KAIZEN_GITHUB_BROKER_CAPABILITY;
    return value;
}
function requestGithubPublication(socketPath, capability, request, timeoutMs) {
    return requestBroker(socketPath, { operation: 'git-push', capability, ...request }, timeoutMs);
}
function requestGithubPublicationPreflight(socketPath, capability, request, timeoutMs) {
    return requestBroker(socketPath, { operation: 'preflight', capability, ...request }, timeoutMs);
}
function requestBroker(socketPath, request, timeoutMs) {
    installShutdownHooks();
    throwIfShutdownRequested();
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        activePublicationSockets.add(socket);
        let output = '';
        let settled = false;
        let absoluteTimeout;
        const fail = () => {
            if (settled)
                return;
            settled = true;
            if (absoluteTimeout)
                clearTimeout(absoluteTimeout);
            activePublicationSockets.delete(socket);
            socket.destroy();
            reject(new Error('GitHub credential broker failed to acknowledge publication.'));
        };
        absoluteTimeout = setTimeout(fail, timeoutMs);
        absoluteTimeout.unref();
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write(`${JSON.stringify({
            version: 1,
            ...request
        })}\n`));
        socket.on('data', (chunk) => {
            output += chunk;
            if (output.length > 4_096)
                fail();
        });
        socket.on('error', fail);
        socket.on('close', fail);
        socket.on('end', () => {
            if (settled)
                return;
            const lines = output.replace(/\r\n/g, '\n').split('\n');
            if (lines.length > 2 || (lines.length === 2 && lines[1] !== '')) {
                fail();
                return;
            }
            try {
                const response = JSON.parse(lines[0] || '{}');
                if (response.ok !== true)
                    throw new Error('broker rejected publication');
                settled = true;
                if (absoluteTimeout)
                    clearTimeout(absoluteTimeout);
                activePublicationSockets.delete(socket);
                resolve();
            }
            catch {
                fail();
            }
        });
    });
}
function publicationTimeoutMs(value) {
    if (!value)
        return 30 * 60_000;
    const timeout = Number(value);
    if (!Number.isSafeInteger(timeout) || timeout < 10_000 || timeout > 60 * 60_000) {
        throw new Error('KAIZEN_GITHUB_PUBLICATION_TIMEOUT_MS must be an integer from 10000 to 3600000.');
    }
    return timeout;
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
export function isTrustedExecutablePath(executable, canWrite = canCurrentUserWrite, statPath = fs.statSync, effectiveUid = process.getuid?.()) {
    let executableStat;
    try {
        executableStat = statPath(executable);
    }
    catch {
        return false;
    }
    if (process.platform === 'win32') {
        if (!executableStat.isFile())
            return false;
        const trustedRoots = ['ProgramFiles', 'ProgramW6432', 'SystemRoot']
            .map((key) => process.env[key])
            .filter((value) => Boolean(value));
        return isWindowsExecutablePathTrusted(executable, trustedRoots, canWrite);
    }
    if (effectiveUid === undefined || effectiveUid === 0)
        return false;
    let current = executable;
    while (true) {
        let stat;
        try {
            stat = current === executable ? executableStat : statPath(current);
        }
        catch {
            return false;
        }
        if (current === executable && !stat.isFile())
            return false;
        const stickyRootOwnedDirectory = stat.uid === 0 && stat.isDirectory() && (stat.mode & 0o1000) !== 0;
        const writable = (stat.mode & 0o022) !== 0 || canWrite(current);
        if (stat.uid !== 0 || (writable && !stickyRootOwnedDirectory)) {
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
        return code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS';
    }
}
function captureGitHubAuthEnv(argv) {
    const captured = buildAllowlistedEnv(process.env, GITHUB_CLI_AUTH_ENV_ALLOWLIST);
    const hasToken = Boolean(captured.GH_TOKEN || captured.GITHUB_TOKEN || captured.GH_ENTERPRISE_TOKEN || captured.GITHUB_ENTERPRISE_TOKEN);
    const commands = commandArguments(argv);
    const command = commands[0];
    const subcommand = commands[1];
    const credentialOnlyInvocation = command === 'init' ||
        (command === 'actions' && (subcommand === 'prepare' || subcommand === 'publish'));
    if (hasToken && !credentialOnlyInvocation) {
        throw new Error('Refusing to start a builder-capable Kaizen process with GitHub token environment variables. Use a credential-only `init`, `actions prepare`, or `actions publish` phase, or an external broker.');
    }
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
        delete process.env[key];
    }
    return captured;
}
function commandArguments(argv) {
    const commands = [];
    for (let index = 0; index < argv.length;) {
        const arg = argv[index];
        if (arg === '--json') {
            index += 1;
            continue;
        }
        if (arg === '--project') {
            if (argv[index + 1] === undefined)
                return [];
            index += 2;
            continue;
        }
        if (arg.startsWith('--project=')) {
            index += 1;
            continue;
        }
        commands.push(arg);
        index += 1;
    }
    return commands;
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
    const trustedExecutables = runCommand[TRUSTED_COMMAND_RUNNER];
    if (trustedExecutables) {
        const githubPublisher = trustedExecutables.githubPublisher;
        const githubPublicationPreflight = trustedExecutables.githubPublicationPreflight;
        Object.defineProperty(deadlineCommand, TRUSTED_COMMAND_RUNNER, {
            value: Object.freeze({
                ...trustedExecutables,
                githubPublisher: githubPublisher
                    ? (request, timeoutMs) => githubPublisher(request, timeoutWithinDeadline(timeoutMs, deadlineAt))
                    : undefined,
                githubPublicationPreflight: githubPublicationPreflight
                    ? (request, timeoutMs) => githubPublicationPreflight(request, timeoutWithinDeadline(timeoutMs, deadlineAt))
                    : undefined
            })
        });
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
            for (const socket of activePublicationSockets)
                socket.destroy();
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