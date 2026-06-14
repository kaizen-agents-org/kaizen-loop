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

  async checkout(branch: string): Promise<void> {
    await this.git(['checkout', branch]);
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

  async push(ref: string, options: { forceWithLease?: boolean } = {}): Promise<void> {
    await this.git(['push', '-u', ...(options.forceWithLease ? ['--force-with-lease'] : []), 'origin', ref]);
  }

  private git(args: string[], options?: { rejectOnNonZero?: boolean }) {
    return this.run('git', args, { cwd: this.cwd, rejectOnNonZero: options?.rejectOnNonZero });
  }
}
