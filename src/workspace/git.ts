import type { CommandRunner } from '../utils/command.js';

export class GitClient {
  constructor(
    private readonly run: CommandRunner,
    private readonly cwd: string
  ) {}

  async root(): Promise<string> {
    const result = await this.git(['rev-parse', '--show-toplevel']);
    return result.stdout.trim();
  }

  async remoteUrl(name = 'origin'): Promise<string> {
    const result = await this.git(['remote', 'get-url', name]);
    return result.stdout.trim();
  }

  async currentBranch(): Promise<string> {
    const result = await this.git(['branch', '--show-current']);
    return result.stdout.trim();
  }

  async revParse(ref: string): Promise<string> {
    const result = await this.git(['rev-parse', ref]);
    return result.stdout.trim();
  }

  async clone(remote: string, target: string): Promise<void> {
    await this.run('git', ['clone', remote, target], { cwd: this.cwd });
  }

  async fetch(): Promise<void> {
    await this.git(['fetch', 'origin']);
  }

  async fetchPrune(): Promise<void> {
    await this.git(['fetch', '--prune', 'origin']);
  }

  async checkout(branch: string, options: { ignoreOtherWorktrees?: boolean } = {}): Promise<void> {
    await this.git(['checkout', ...(options.ignoreOtherWorktrees ? ['--ignore-other-worktrees'] : []), branch]);
  }

  async resetHard(ref: string): Promise<void> {
    await this.git(['reset', '--hard', ref]);
  }

  async rebase(ref: string): Promise<void> {
    await this.git(['rebase', ref]);
  }

  async abortRebase(): Promise<void> {
    await this.git(['rebase', '--abort'], { rejectOnNonZero: false });
  }

  async mergeFfOnly(ref: string): Promise<void> {
    await this.git(['merge', '--ff-only', ref]);
  }

  async clean(): Promise<void> {
    await this.git(['clean', '-fdx']);
  }

  async worktreeAdd(target: string, branch: string, ref: string): Promise<void> {
    await this.git(['worktree', 'add', '-B', branch, target, ref]);
  }

  async worktreeAddExisting(target: string, branch: string): Promise<void> {
    await this.git(['worktree', 'add', target, branch]);
  }

  async localBranchExists(branch: string): Promise<boolean> {
    const result = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { rejectOnNonZero: false });
    return result.exitCode === 0;
  }

  async remoteBranchExists(branch: string, remote = 'origin'): Promise<boolean> {
    const result = await this.git(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { rejectOnNonZero: false });
    return result.exitCode === 0;
  }

  async worktreeList(): Promise<Array<{ path: string; branch?: string }>> {
    const result = await this.git(['worktree', 'list', '--porcelain'], { rejectOnNonZero: false });
    return parseWorktreeList(result.stdout);
  }

  async worktreeRemove(target: string): Promise<void> {
    await this.git(['worktree', 'remove', '--force', target], { rejectOnNonZero: false });
  }

  async worktreePrune(): Promise<void> {
    await this.git(['worktree', 'prune'], { rejectOnNonZero: false });
  }

  async switchNew(branch: string): Promise<void> {
    await this.git(['switch', '-c', branch]);
  }

  async deleteLocalBranch(branch: string): Promise<void> {
    await this.git(['branch', '-D', branch], { rejectOnNonZero: false });
  }

  async forceBranch(branch: string, ref: string): Promise<void> {
    await this.git(['branch', '-f', branch, ref]);
  }

  async addAll(): Promise<void> {
    await this.git(['add', '-A']);
  }

  async commit(message: string): Promise<void> {
    await this.git(['commit', '-m', message]);
  }

  async statusPorcelain(): Promise<string> {
    const result = await this.git(['status', '--porcelain']);
    return result.stdout;
  }

  async remoteBranches(remote = 'origin'): Promise<Array<{ ref: string; name: string; sha: string }>> {
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

  async divergence(base: string, head: string): Promise<{ behind: number; ahead: number }> {
    const result = await this.git(['rev-list', '--left-right', '--count', `${base}...${head}`]);
    const [behind, ahead] = result.stdout.trim().split(/\s+/).map((value) => Number(value) || 0);
    return { behind, ahead };
  }

  async diffNameOnly(base: string): Promise<string[]> {
    const result = await this.git(['diff', '--name-only', `${base}...HEAD`], { rejectOnNonZero: false });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async diffNumstat(base: string): Promise<Array<{ file: string; added: number; deleted: number }>> {
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

  async diff(base: string): Promise<string> {
    const result = await this.git(['diff', '--no-ext-diff', `${base}...HEAD`], { rejectOnNonZero: false });
    return result.stdout;
  }

  async push(ref: string, options: { forceWithLease?: boolean } = {}): Promise<void> {
    await this.git(['push', '-u', ...(options.forceWithLease ? ['--force-with-lease'] : []), 'origin', ref]);
  }

  private git(args: string[], options?: { rejectOnNonZero?: boolean }) {
    return this.run('git', args, { cwd: this.cwd, rejectOnNonZero: options?.rejectOnNonZero });
  }
}

function parseWorktreeList(output: string): Array<{ path: string; branch?: string }> {
  const worktrees: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;

  for (const line of output.split('\n')) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = undefined;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (line.startsWith('branch ') && current) {
      const branch = line.slice('branch '.length);
      current.branch = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
    }
  }

  if (current) worktrees.push(current);
  return worktrees;
}
