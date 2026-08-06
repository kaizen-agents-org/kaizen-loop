import { gitCliEnv, gitPublicationEnv, gitSshPublicationEnv } from '../utils/command.js';
import { repoFromRemote } from '../utils/slug.js';
export class GitClient {
    run;
    cwd;
    constructor(run, cwd) {
        this.run = run;
        this.cwd = cwd;
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
    async push(ref, options = {}) {
        const remote = await this.remoteUrl('origin');
        if (!repoFromRemote(remote))
            throw new Error(`Refusing to publish to unsupported origin: ${remote}`);
        const env = remote.startsWith('https://') ? gitPublicationEnv() : gitSshPublicationEnv();
        await this.git(['push', '--no-verify', '-u', ...(options.forceWithLease ? ['--force-with-lease'] : []), 'origin', ref], { env });
    }
    git(args, options) {
        return this.run('git', args, {
            cwd: this.cwd,
            env: options?.env ?? gitCliEnv(),
            rejectOnNonZero: options?.rejectOnNonZero
        });
    }
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