import fs from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { buildUntrustedEnv } from '../utils/command.js';
import { worktreesDirForWorkspace } from '../utils/paths.js';
import { slugify } from '../utils/slug.js';
import { envWithKaizenTemp } from '../utils/temp.js';
import { ensurePrivateDirectory, ensurePrivateStructureDirectory } from '../utils/privateDirectory.js';
import { GitClient } from './git.js';
export class CheckpointBranchMissingError extends Error {
    branch;
    constructor(branch) {
        super(`Checkpoint branch is missing locally and on origin: ${branch}`);
        this.branch = branch;
        this.name = 'CheckpointBranchMissingError';
    }
}
export class CheckpointBranchDivergedError extends Error {
    branch;
    constructor(branch) {
        super(`Checkpoint branch diverged from origin and requires reconciliation: ${branch}`);
        this.branch = branch;
        this.name = 'CheckpointBranchDivergedError';
    }
}
const DEFAULT_DIFF_TEXT_MAX_CHARS = 30_000;
export class WorkspaceManager {
    run;
    workspacePath;
    remoteUrl;
    constructor(run, workspacePath, remoteUrl = '') {
        this.run = run;
        this.workspacePath = workspacePath;
        this.remoteUrl = remoteUrl;
    }
    async ensure() {
        try {
            await fs.lstat(this.workspacePath);
            await ensurePrivateDirectory(this.workspacePath);
        }
        catch (error) {
            if (!isMissingPath(error))
                throw error;
        }
        try {
            await fs.access(path.join(this.workspacePath, '.git'));
        }
        catch {
            await fs.rm(this.workspacePath, { recursive: true, force: true });
            await fs.mkdir(path.dirname(this.workspacePath), { recursive: true });
            await ensurePrivateDirectory(this.workspacePath);
            const parentGit = new GitClient(this.run, path.dirname(this.workspacePath));
            await parentGit.clone(this.remoteUrl, this.workspacePath);
        }
        await ensurePrivateDirectory(this.workspacePath);
    }
    git() {
        return new GitClient(this.run, this.workspacePath);
    }
    get path() {
        return this.workspacePath;
    }
    async sync(defaultBranch) {
        const git = this.git();
        await git.fetch();
        await git.checkout(defaultBranch);
        await git.resetHard(`origin/${defaultBranch}`);
        await git.clean();
    }
    async runSetup(config, runDeadlineAt) {
        if (!config.commands.setup)
            return undefined;
        const result = await this.runShell(config.commands.setup, undefined, config, runDeadlineAt);
        return {
            command: config.commands.setup,
            ok: result.exitCode === 0,
            output: `${result.stdout}${result.stderr}`
        };
    }
    async runVerify(config, runDeadlineAt) {
        const results = [];
        for (const command of config.commands.verify) {
            const result = await this.runVerifyCommand(command, config, runDeadlineAt);
            results.push({
                command,
                ok: result.exitCode === 0,
                output: `${result.stdout}${result.stderr}`
            });
            if (result.exitCode !== 0)
                break;
        }
        return results;
    }
    async runVerifyCommand(command, config, runDeadlineAt) {
        const timeoutMs = config.commands.verifyTimeoutMinutes * 60_000;
        const result = await this.runShell(command, timeoutMs, config, runDeadlineAt);
        const output = `${result.stdout}${result.stderr}`;
        if (result.exitCode === 0 || !config.commands.setup || !isTransientDependencyFailure(output)) {
            return result;
        }
        const setup = await this.runDependencyRepair(config.commands.setup, config, runDeadlineAt);
        const retried = setup.ok
            ? await this.runShell(command, timeoutMs, config, runDeadlineAt)
            : result;
        const retryOutput = retried === result ? '' : `${retried.stdout}${retried.stderr}`;
        return {
            ...retried,
            stdout: [
                output,
                '',
                `# kaizen-loop dependency repair: ${config.commands.setup}`,
                setup.output,
                setup.ok ? '# kaizen-loop dependency repair: retrying verification command' : '',
                retryOutput
            ].filter(Boolean).join('\n'),
            stderr: ''
        };
    }
    async runDependencyRepair(command, config, runDeadlineAt) {
        const result = await this.runShell(command, undefined, config, runDeadlineAt, { CI: 'true' });
        return {
            command,
            ok: result.exitCode === 0,
            output: `${result.stdout}${result.stderr}`
        };
    }
    async createIssueBranch(config, issue) {
        const branch = issueBranchName(config, issue);
        const git = this.git();
        await git.deleteLocalBranch(branch);
        await git.switchNew(branch);
        return branch;
    }
    async createIssueWorktree(config, issue, runId, options = {}) {
        const branch = options.branch ?? issueBranchName(config, issue);
        const worktreePath = issueWorktreePath(this.workspacePath, runId, issue.number);
        const git = this.git();
        await git.worktreePrune();
        await git.worktreeRemove(worktreePath);
        await fs.rm(worktreePath, { recursive: true, force: true });
        const worktreesRoot = path.dirname(path.dirname(worktreePath));
        const runRoot = path.dirname(worktreePath);
        await ensurePrivateStructureDirectory(worktreesRoot);
        await ensurePrivateStructureDirectory(runRoot);
        await ensurePrivateDirectory(worktreePath);
        await this.removeWorktreesForBranch(branch);
        if (!options.resume) {
            await git.deleteLocalBranch(branch);
            await git.worktreeAdd(worktreePath, branch, `origin/${config.git.defaultBranch}`);
            await ensurePrivateDirectory(worktreePath);
            return { branch, path: worktreePath, resumed: false };
        }
        const localBranchExists = await git.localBranchExists(branch);
        const remoteBranchExists = !localBranchExists && await git.remoteBranchExists(branch);
        if (!localBranchExists && !remoteBranchExists)
            throw new CheckpointBranchMissingError(branch);
        if (localBranchExists) {
            if (await git.remoteBranchExists(branch)) {
                const divergence = await git.divergence(`origin/${branch}`, branch);
                if (divergence.behind > 0 && divergence.ahead > 0)
                    throw new CheckpointBranchDivergedError(branch);
                if (divergence.behind > 0)
                    await git.forceBranch(branch, `origin/${branch}`);
            }
            await git.worktreeAddExisting(worktreePath, branch);
        }
        else {
            await git.worktreeAdd(worktreePath, branch, `origin/${branch}`);
        }
        await ensurePrivateDirectory(worktreePath);
        return { branch, path: worktreePath, resumed: true };
    }
    async discardIssueChanges(branch, defaultBranch) {
        const git = this.git();
        const restoredCheckpoint = await git.remoteBranchExists(branch);
        await git.resetHard(restoredCheckpoint ? `origin/${branch}` : `origin/${defaultBranch}`);
        await git.clean();
        return { restoredCheckpoint };
    }
    async removeIssueWorktree(worktreePath) {
        const git = this.git();
        await git.worktreeRemove(worktreePath);
        await fs.rm(worktreePath, { recursive: true, force: true });
        await git.worktreePrune();
    }
    async collectDiffStats(config) {
        const base = `origin/${config.git.defaultBranch}`;
        const git = this.git();
        const files = await git.diffNameOnly(base);
        const stats = await git.diffNumstat(base);
        const changedLines = stats.reduce((sum, item) => sum + item.added + item.deleted, 0);
        return {
            files,
            changedFiles: files.length,
            changedLines,
            forbiddenFiles: files.filter((file) => matchesAny(file, config.policy.forbiddenPaths)),
            protectedFiles: files.filter((file) => matchesAny(file, config.policy.protectedPaths))
        };
    }
    async collectCheckpointDiffStats(config) {
        const committed = await this.collectDiffStats(config);
        const files = [...new Set([...committed.files, ...parseStatusFiles(await this.git().statusPorcelain())])];
        return {
            ...committed,
            files,
            changedFiles: files.length,
            forbiddenFiles: files.filter((file) => matchesAny(file, config.policy.forbiddenPaths)),
            protectedFiles: files.filter((file) => matchesAny(file, config.policy.protectedPaths))
        };
    }
    async collectDiffText(config, maxChars = DEFAULT_DIFF_TEXT_MAX_CHARS) {
        const base = `origin/${config.git.defaultBranch}`;
        const diff = await this.git().diff(base);
        return truncateText(diff.trim(), maxChars);
    }
    async collectWorkingTreeDiffStats(config) {
        const git = this.git();
        const files = await git.workingTreeDiffNameOnly();
        const stats = await git.workingTreeDiffNumstat();
        const changedLines = stats.reduce((sum, item) => sum + item.added + item.deleted, 0);
        return {
            files,
            changedFiles: files.length,
            changedLines,
            forbiddenFiles: files.filter((file) => matchesAny(file, config.policy.forbiddenPaths)),
            protectedFiles: files.filter((file) => matchesAny(file, config.policy.protectedPaths))
        };
    }
    async collectWorkingTreeDiffText(maxChars = DEFAULT_DIFF_TEXT_MAX_CHARS) {
        const diff = await this.git().workingTreeDiff();
        return truncateText(diff.trim(), maxChars);
    }
    async runShell(command, timeoutMs, config, runDeadlineAt, extraEnv = {}) {
        const shell = process.platform === 'win32' ? 'cmd' : 'sh';
        const args = process.platform === 'win32' ? ['/c', command] : ['-lc', command];
        const startedAt = Date.now();
        try {
            return await this.run(shell, args, {
                cwd: this.workspacePath,
                env: await envWithKaizenTemp(buildUntrustedEnv(process.env, config.safety.envAllowlist, extraEnv), this.workspacePath),
                timeoutMs: boundedTimeoutMs(timeoutMs, runDeadlineAt),
                rejectOnNonZero: false
            });
        }
        catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            const result = failure.result;
            return {
                command: result?.command ?? shell,
                args: result?.args ?? args,
                cwd: result?.cwd ?? this.workspacePath,
                exitCode: result?.exitCode || 1,
                stdout: result?.stdout ?? '',
                stderr: [result?.stderr, failure.message].filter(Boolean).join('\n'),
                durationMs: result?.durationMs ?? Date.now() - startedAt
            };
        }
    }
    async removeWorktreesForBranch(branch) {
        const git = this.git();
        const worktrees = await git.worktreeList();
        for (const worktree of worktrees) {
            if (worktree.branch !== branch || worktree.path === this.workspacePath)
                continue;
            await git.worktreeRemove(worktree.path);
            await fs.rm(worktree.path, { recursive: true, force: true });
        }
    }
}
function isMissingPath(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
function boundedTimeoutMs(configuredTimeoutMs, runDeadlineAt) {
    if (!runDeadlineAt)
        return configuredTimeoutMs;
    const remainingMs = runDeadlineAt - Date.now();
    if (remainingMs <= 0)
        throw new Error('Kaizen run timeout exceeded.');
    return configuredTimeoutMs === undefined ? remainingMs : Math.min(configuredTimeoutMs, remainingMs);
}
function issueBranchName(config, issue) {
    return `${config.git.branchPrefix}issue-${issue.number}-${slugify(issue.title)}`;
}
function issueWorktreePath(workspacePath, runId, issueNumber) {
    return path.join(worktreesDirForWorkspace(workspacePath), runId, `issue-${issueNumber}`);
}
function matchesAny(file, patterns) {
    return patterns.some((pattern) => minimatch(file, pattern, { dot: true }));
}
function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}\n\n[truncated after ${maxChars} characters]`;
}
function isTransientDependencyFailure(output) {
    return (/Cannot find module ['"]?@rollup\/rollup-/i.test(output) ||
        /npm has a bug related to optional dependencies/i.test(output));
}
function parseStatusFiles(status) {
    return status
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => line.slice(3))
        .flatMap((file) => file.includes(' -> ') ? file.split(' -> ') : [file])
        .map((file) => file.replace(/^"|"$/g, ''));
}
//# sourceMappingURL=manager.js.map