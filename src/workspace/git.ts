import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  gitCliEnv,
  gitPublicationEnv,
  gitSshPublicationEnv,
  isolatedGitEnv,
  publicationGitExecutable as resolvePublicationGitExecutable,
  publicationSshExecutable as resolvePublicationSshExecutable,
  publicationGithubToken as resolvePublicationGithubToken,
  publicationGithubPublisher as resolvePublicationGithubPublisher,
  type CommandRunner
} from '../utils/command.js';
import { repoFromRemote } from '../utils/slug.js';

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

  async publicationPushUrls(): Promise<string[]> {
    const publicationGitExecutable = resolvePublicationGitExecutable(this.run);
    if (!publicationGitExecutable) {
      throw new Error('Could not resolve a trusted Git executable before publication.');
    }
    const result = await this.run(publicationGitExecutable, ['remote', 'get-url', '--push', '--all', 'origin'], {
      cwd: this.cwd,
      env: isolatedGitEnv()
    });
    return result.stdout.split('\n').map((url) => url.trim()).filter(Boolean);
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
    await this.git(['clone', remote, target]);
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

  // `excludePaths` keeps harness scratch out of the work branch. The verifier
  // writes its artifacts inside the checkout -- it is confined to
  // KAIZEN_WORKSPACE_DIR by design and cannot use a temporary directory -- so
  // an unfiltered `add -A` sweeps them into the commit. That put 6 files and
  // 917 lines of scratch, including a dump of the builder prompt, into a pull
  // request whose actual change was 8 lines.
  // Returns true when an exclusion was actually applied, so the caller knows
  // the index may be empty even though the tree was dirty.
  async addAll(excludePaths: string[] = []): Promise<boolean> {
    const exclusions = excludePaths
      .map((entry) => this.repositoryRelativePath(entry))
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => `:(exclude,glob)${entry}/**`);
    if (exclusions.length === 0) {
      await this.git(['add', '-A']);
      return false;
    }
    await this.git(['add', '-A', '--', '.', ...exclusions]);
    return true;
  }

  // Git rejects a pathspec that leaves the repository, which would abort the
  // commit rather than ignore a bad entry. A prefix check is not enough:
  // `scratch/../../outside` does not start with `..` yet still escapes, so the
  // path is resolved and compared against the workspace root.
  private repositoryRelativePath(candidate: string): string | undefined {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    const resolved = path.resolve(this.cwd, trimmed);
    const relativePath = path.relative(this.cwd, resolved);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
    return relativePath.split(path.sep).join('/');
  }

  // `git status` reports a dirty tree, but the index can still be empty once
  // exclusions are applied -- when only harness scratch changed. Committing
  // then fails and takes the run down with it.
  async hasStagedChanges(): Promise<boolean> {
    const result = await this.git(['diff', '--cached', '--quiet'], { rejectOnNonZero: false });
    return result.exitCode !== 0;
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

  async checkpointFiles(base: string): Promise<string[]> {
    const committed = await this.git(['diff', '--name-only', '-z', `${base}...HEAD`], { rejectOnNonZero: false });
    const working = await this.git(['ls-files', '--modified', '--others', '--exclude-standard', '-z'], { rejectOnNonZero: false });
    return [...new Set(`${committed.stdout}${working.stdout}`.split('\0').filter(Boolean))];
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

  async workingTreeDiffNameOnly(): Promise<string[]> {
    const result = await this.git(['diff', '--name-only', 'HEAD'], { rejectOnNonZero: false });
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async workingTreeDiffNumstat(): Promise<Array<{ file: string; added: number; deleted: number }>> {
    const result = await this.git(['diff', '--numstat', 'HEAD'], { rejectOnNonZero: false });
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [added, deleted, ...fileParts] = line.split(/\s+/);
      return { file: fileParts.join(' '), added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });
  }

  async workingTreeDiff(): Promise<string> {
    const result = await this.git(['diff', '--no-ext-diff', 'HEAD'], { rejectOnNonZero: false });
    return result.stdout;
  }

  async push(ref: string, options: { forceWithLease?: boolean; expectedRepo: string }): Promise<void> {
    const publicationGitExecutable = resolvePublicationGitExecutable(this.run);
    if (!publicationGitExecutable) {
      throw new Error('Could not resolve a trusted Git executable before publication.');
    }
    const publicationLocalEnv = isolatedGitEnv();
    const pushUrls = await this.publicationPushUrls();
    if (pushUrls.length !== 1) throw new Error(`Refusing to publish through ${pushUrls.length} origin push URLs.`);
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
    let publicationError: unknown;
    let cleanupError: unknown;
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
      const verifiedLfsPointers: string[] = [];
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
        if (isGitLfsPointer(pointer.stdout)) verifiedLfsPointers.push(candidatePath);
      }
      if (verifiedLfsPointers.length > 0) {
        throw new Error(`Refusing to publish Git LFS pointer files without a trusted object upload: ${verifiedLfsPointers.join(', ')}`);
      }
      const validatedSha = await this.run(publicationGitExecutable, ['rev-parse', ref], {
        cwd: publicationDir,
        env: isolatedGitEnv()
      });
      const lease = options.forceWithLease
        ? [`--force-with-lease=refs/heads/${ref}:${expectedRemote?.exitCode === 0 ? expectedRemote.stdout.trim() : ''}`]
        : [];
      const refspec = `${ref}:refs/heads/${ref}`;
      if (pushUrl.startsWith('https://') && !resolvePublicationGithubToken(this.run)) {
        const publisher = resolvePublicationGithubPublisher(this.run);
        if (!publisher) {
          throw new Error(
            'HTTPS Git publication requires a credential-only token or KAIZEN_GITHUB_TOKEN_SOCKET.'
          );
        }
        try {
          await publisher({
            cwd: publicationDir,
            pushUrl,
            refspec,
            expectedRepo: options.expectedRepo,
            expectedSha: validatedSha.stdout.trim(),
            forceWithLease: lease[0]
          });
        } catch (error) {
          // Discarding this error entirely left "failed to publish the
          // validated ref" as the only trace of a failure the broker had
          // already named. But the publisher is an injected callback whose
          // message is not under our control and may carry credentials, so only
          // the broker's own refusal vocabulary is allowed through.
          const reason = brokerRefusalReason(error);
          throw new Error(reason
            ? `GitHub credential broker failed to publish the validated ref: ${reason}.`
            : 'GitHub credential broker failed to publish the validated ref.');
        }
      } else {
        const env = pushUrl.startsWith('https://')
          ? gitPublicationEnv(process.env, resolvePublicationGithubToken(this.run))
          : gitSshPublicationEnv(process.env, resolvePublicationSshExecutable(this.run));
        await this.run(publicationGitExecutable, ['push', '--no-verify', ...lease, pushUrl, refspec], {
          cwd: publicationDir,
          env
        });
      }
      const disabledHooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
      await this.run(publicationGitExecutable, [
        '-c',
        `core.hooksPath=${disabledHooksPath}`,
        'update-ref',
        `refs/remotes/origin/${ref}`,
        validatedSha.stdout.trim()
      ], { cwd: this.cwd, env: publicationLocalEnv });
      await this.run(publicationGitExecutable, ['config', `branch.${ref}.remote`, 'origin'], {
        cwd: this.cwd,
        env: publicationLocalEnv
      });
      await this.run(publicationGitExecutable, ['config', `branch.${ref}.merge`, `refs/heads/${ref}`], {
        cwd: this.cwd,
        env: publicationLocalEnv
      });
    } catch (error) {
      publicationError = error;
    } finally {
      try {
        await fs.rm(publicationDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (publicationError !== undefined) {
      if (publicationError instanceof Error && publicationError.cause === undefined && cleanupError !== undefined) {
        publicationError.cause = cleanupError;
      }
      throw publicationError;
    }
    if (cleanupError !== undefined) throw cleanupError;
  }

  private git(args: string[], options?: { rejectOnNonZero?: boolean; env?: NodeJS.ProcessEnv }) {
    return this.run('git', args, {
      cwd: this.cwd,
      env: options?.env ?? gitCliEnv(),
      rejectOnNonZero: options?.rejectOnNonZero
    });
  }
}

export function isGitLfsPointer(content: string): boolean {
  const lines = content.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines.length < 3 || lines[0] !== 'version https://git-lfs.github.com/spec/v1') return false;
  const oidIndex = lines.length - 2;
  return lines.slice(1, oidIndex).every((line) => /^ext-[0-9]+-[A-Za-z0-9][A-Za-z0-9._-]* .+$/.test(line))
    && /^oid sha256:[0-9a-f]{64}$/.test(lines[oidIndex])
    && /^size [0-9]+$/.test(lines[oidIndex + 1]);
}

// The refusal codes the broker is documented to answer with. Matching against a
// fixed list rather than forwarding the error text keeps an injected publisher
// -- or a future broker that echoes a URL -- from leaking a credential into a
// message that reaches issue comments and logs.
const BROKER_REFUSAL_REASONS = [
  'repository-mismatch',
  'repository-not-allowed',
  'default-branch-refused',
  'invalid-refspec',
  'invalid-cwd',
  'invalid-expected-sha',
  'invalid-force-with-lease',
  'invalid-object-directory',
  'invalid-request',
  'invalid-request-fields',
  'invalid-framing',
  'unsupported-operation',
  'expected-sha-mismatch',
  'request-timeout',
  'request-too-large',
  'broker-busy',
  'git-timeout',
  'git-failed',
  'internal-error',
  'internal-response-error'
] as const;

function brokerRefusalReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  return BROKER_REFUSAL_REASONS.find((reason) => message.includes(reason));
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
