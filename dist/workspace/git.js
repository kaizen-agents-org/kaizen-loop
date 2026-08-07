import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitCliEnv, gitPublicationEnv, gitSshPublicationEnv, isolatedGitEnv, publicationGitExecutable as resolvePublicationGitExecutable } from '../utils/command.js';
import { repoFromRemote } from '../utils/slug.js';
export class GitClient {
    run;
    cwd;
    publicationGitExecutable;
    constructor(run, cwd, publicationGitExecutable = resolvePublicationGitExecutable(run)) {
        this.run = run;
        this.cwd = cwd;
        this.publicationGitExecutable = publicationGitExecutable;
    }
    async root() {
        const result = await this.git(['rev-parse', '--show-toplevel']);
        return result.stdout.trim();
    }
    async remoteUrl(name = 'origin') {
        const result = await this.git(['remote', 'get-url', name]);
        return result.stdout.trim();
    }
    async currentBranch() {
        const result = await this.git(['branch', '--show-current']);
        return result.stdout.trim();
    }
    async revParse(ref) {
        const result = await this.git(['rev-parse', ref]);
        return result.stdout.trim();
    }
    async clone(remote, target) {
        await this.git(['clone', remote, target]);
    }
    async fetch() {
        await this.git(['fetch', 'origin']);
    }
    async fetchPrune() {
        await this.git(['fetch', '--prune', 'origin']);
    }
    async checkout(branch, options = {}) {
        await this.git(['checkout', ...(options.ignoreOtherWorktrees ? ['--ignore-other-worktrees'] : []), branch]);
    }
    async resetHard(ref) {
        await this.git(['reset', '--hard', ref]);
    }
    async rebase(ref) {
        await this.git(['rebase', ref]);
    }
    async abortRebase() {
        await this.git(['rebase', '--abort'], { rejectOnNonZero: false });
    }
    async mergeFfOnly(ref) {
        await this.git(['merge', '--ff-only', ref]);
    }
    async clean() {
        await this.git(['clean', '-fdx']);
    }
    async worktreeAdd(target, branch, ref) {
        await this.git(['worktree', 'add', '-B', branch, target, ref]);
    }
    async worktreeAddExisting(target, branch) {
        await this.git(['worktree', 'add', target, branch]);
    }
    async localBranchExists(branch) {
        const result = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { rejectOnNonZero: false });
        return result.exitCode === 0;
    }
    async remoteBranchExists(branch, remote = 'origin') {
        const result = await this.git(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { rejectOnNonZero: false });
        return result.exitCode === 0;
    }
    async worktreeList() {
        const result = await this.git(['worktree', 'list', '--porcelain'], { rejectOnNonZero: false });
        return parseWorktreeList(result.stdout);
    }
    async worktreeRemove(target) {
        await this.git(['worktree', 'remove', '--force', target], { rejectOnNonZero: false });
    }
    async worktreePrune() {
        await this.git(['worktree', 'prune'], { rejectOnNonZero: false });
    }
    async switchNew(branch) {
        await this.git(['switch', '-c', branch]);
    }
    async deleteLocalBranch(branch) {
        await this.git(['branch', '-D', branch], { rejectOnNonZero: false });
    }
    async forceBranch(branch, ref) {
        await this.git(['branch', '-f', branch, ref]);
    }
    async addAll() {
        await this.git(['add', '-A']);
    }
    async commit(message) {
        await this.git(['commit', '-m', message]);
    }
    async statusPorcelain() {
        const result = await this.git(['status', '--porcelain']);
        return result.stdout;
    }
    async remoteBranches(remote = 'origin') {
        const result = await this.git(['for-each-ref', '--format=%(refname:short)%09%(objectname:short)', `refs/remotes/${remote}`]);
        return result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
            const [ref, sha] = line.split('\t');
            const prefix = `${remote}/`;
            return {
                ref,
                name: ref.startsWith(prefix) ? ref.slice(prefix.length) : ref,
                sha
            };
        });
    }
    async divergence(base, head) {
        const result = await this.git(['rev-list', '--left-right', '--count', `${base}...${head}`]);
        const [behind, ahead] = result.stdout.trim().split(/\s+/).map((value) => Number(value) || 0);
        return { behind, ahead };
    }
    async diffNameOnly(base) {
        const result = await this.git(['diff', '--name-only', `${base}...HEAD`], { rejectOnNonZero: false });
        return result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    }
    async diffNumstat(base) {
        const result = await this.git(['diff', '--numstat', `${base}...HEAD`], { rejectOnNonZero: false });
        return result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
            const [added, deleted, ...fileParts] = line.split(/\s+/);
            return {
                file: fileParts.join(' '),
                added: Number(added) || 0,
                deleted: Number(deleted) || 0
            };
        });
    }
    async diff(base) {
        const result = await this.git(['diff', '--no-ext-diff', `${base}...HEAD`], { rejectOnNonZero: false });
        return result.stdout;
    }
    async workingTreeDiffNameOnly() {
        const result = await this.git(['diff', '--name-only', 'HEAD'], { rejectOnNonZero: false });
        return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    }
    async workingTreeDiffNumstat() {
        const result = await this.git(['diff', '--numstat', 'HEAD'], { rejectOnNonZero: false });
        return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
            const [added, deleted, ...fileParts] = line.split(/\s+/);
            return { file: fileParts.join(' '), added: Number(added) || 0, deleted: Number(deleted) || 0 };
        });
    }
    async workingTreeDiff() {
        const result = await this.git(['diff', '--no-ext-diff', 'HEAD'], { rejectOnNonZero: false });
        return result.stdout;
    }
    async push(ref, options) {
        if (!this.publicationGitExecutable) {
            throw new Error('Could not resolve a trusted Git executable before publication.');
        }
        const publicationGitExecutable = this.publicationGitExecutable;
        const publicationLocalEnv = isolatedGitEnv();
        const pushUrlResult = await this.run(publicationGitExecutable, ['remote', 'get-url', '--push', '--all', 'origin'], {
            cwd: this.cwd,
            env: publicationLocalEnv
        });
        const pushUrls = pushUrlResult.stdout.split('\n').map((url) => url.trim()).filter(Boolean);
        if (pushUrls.length !== 1)
            throw new Error(`Refusing to publish through ${pushUrls.length} origin push URLs.`);
        const pushUrl = pushUrls[0];
        const pushRepo = repoFromRemote(pushUrl);
        if (!pushRepo || pushRepo.toLowerCase() !== options.expectedRepo.toLowerCase()) {
            throw new Error(`Refusing to publish ${options.expectedRepo} to origin ${pushUrl}`);
        }
        const expectedRemote = options.forceWithLease
            ? await this.run(publicationGitExecutable, ['rev-parse', '--verify', `refs/remotes/origin/${ref}`], {
                cwd: this.cwd,
                env: publicationLocalEnv,
                rejectOnNonZero: false
            })
            : undefined;
        const publicationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-publication-'));
        let publicationError;
        let cleanupError;
        try {
            await this.run(publicationGitExecutable, ['clone', '--bare', '--no-local', this.cwd, publicationDir], {
                env: publicationLocalEnv
            });
            const lfsPointers = await this.run(publicationGitExecutable, [
                'grep',
                '-I',
                '-l',
                '-e',
                '^version https://git-lfs.github.com/spec/v1$',
                ref,
                '--'
            ], {
                cwd: publicationDir,
                env: isolatedGitEnv(),
                rejectOnNonZero: false
            });
            if (lfsPointers.exitCode > 1) {
                throw new Error(`Could not inspect ${ref} for Git LFS pointers before publication.`);
            }
            const verifiedLfsPointers = [];
            for (const candidate of lfsPointers.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
                const pathPrefix = `${ref}:`;
                const candidatePath = candidate.startsWith(pathPrefix) ? candidate.slice(pathPrefix.length) : candidate;
                const pointer = await this.run(publicationGitExecutable, ['show', `${ref}:${candidatePath}`], {
                    cwd: publicationDir,
                    env: isolatedGitEnv(),
                    rejectOnNonZero: false
                });
                if (pointer.exitCode !== 0) {
                    throw new Error(`Could not inspect ${candidatePath} for Git LFS pointer metadata before publication.`);
                }
                if (isGitLfsPointer(pointer.stdout))
                    verifiedLfsPointers.push(candidatePath);
            }
            if (verifiedLfsPointers.length > 0) {
                throw new Error(`Refusing to publish Git LFS pointer files without a trusted object upload: ${verifiedLfsPointers.join(', ')}`);
            }
            const env = pushUrl.startsWith('https://') ? gitPublicationEnv() : gitSshPublicationEnv();
            const lease = options.forceWithLease
                ? [`--force-with-lease=refs/heads/${ref}:${expectedRemote?.exitCode === 0 ? expectedRemote.stdout.trim() : ''}`]
                : [];
            await this.run(publicationGitExecutable, ['push', '--no-verify', ...lease, pushUrl, `${ref}:refs/heads/${ref}`], {
                cwd: publicationDir,
                env
            });
            const publishedSha = await this.run(publicationGitExecutable, ['rev-parse', ref], {
                cwd: this.cwd,
                env: publicationLocalEnv
            });
            const disabledHooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
            await this.run(publicationGitExecutable, [
                '-c',
                `core.hooksPath=${disabledHooksPath}`,
                'update-ref',
                `refs/remotes/origin/${ref}`,
                publishedSha.stdout.trim()
            ], { cwd: this.cwd, env: publicationLocalEnv });
            await this.run(publicationGitExecutable, ['config', `branch.${ref}.remote`, 'origin'], {
                cwd: this.cwd,
                env: publicationLocalEnv
            });
            await this.run(publicationGitExecutable, ['config', `branch.${ref}.merge`, `refs/heads/${ref}`], {
                cwd: this.cwd,
                env: publicationLocalEnv
            });
        }
        catch (error) {
            publicationError = error;
        }
        finally {
            try {
                await fs.rm(publicationDir, { recursive: true, force: true });
            }
            catch (error) {
                cleanupError = error;
            }
        }
        if (publicationError !== undefined) {
            if (publicationError instanceof Error && publicationError.cause === undefined && cleanupError !== undefined) {
                publicationError.cause = cleanupError;
            }
            throw publicationError;
        }
        if (cleanupError !== undefined)
            throw cleanupError;
    }
    git(args, options) {
        return this.run('git', args, {
            cwd: this.cwd,
            env: options?.env ?? gitCliEnv(),
            rejectOnNonZero: options?.rejectOnNonZero
        });
    }
}
export function isGitLfsPointer(content) {
    const lines = content.replace(/\r\n/g, '\n').trimEnd().split('\n');
    if (lines.length < 3 || lines[0] !== 'version https://git-lfs.github.com/spec/v1')
        return false;
    const oidIndex = lines.length - 2;
    return lines.slice(1, oidIndex).every((line) => /^ext-[0-9]+-[A-Za-z0-9][A-Za-z0-9._-]* .+$/.test(line))
        && /^oid sha256:[0-9a-f]{64}$/.test(lines[oidIndex])
        && /^size [0-9]+$/.test(lines[oidIndex + 1]);
}
function parseWorktreeList(output) {
    const worktrees = [];
    let current;
    for (const line of output.split('\n')) {
        if (!line.trim()) {
            if (current)
                worktrees.push(current);
            current = undefined;
            continue;
        }
        if (line.startsWith('worktree ')) {
            if (current)
                worktrees.push(current);
            current = { path: line.slice('worktree '.length) };
            continue;
        }
        if (line.startsWith('branch ') && current) {
            const branch = line.slice('branch '.length);
            current.branch = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
        }
    }
    if (current)
        worktrees.push(current);
    return worktrees;
}
//# sourceMappingURL=git.js.map