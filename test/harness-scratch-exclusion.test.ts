import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../src/workspace/git.js';
import { runCommand } from '../src/utils/command.js';

// Runs against real git rather than a mocked runner: the defect was in the
// pathspec semantics of `git add`, which a stubbed runner would have asserted
// as a string without proving git honours it.

const run = promisify(execFile);
const repositories: string[] = [];

afterEach(async () => {
  for (const directory of repositories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function repositoryWithScratch(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-scratch-'));
  repositories.push(directory);
  await run('git', ['init', '-q', '.'], { cwd: directory });

  // What the change under review should contain.
  await fs.writeFile(path.join(directory, 'README.md'), '# project\n');
  await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  await fs.writeFile(path.join(directory, 'src/lib.rs'), 'pub fn f() {}\n');

  // What the verifier leaves behind, next to its result file inside the
  // checkout. `intent.txt` holds the full builder prompt.
  const artifacts = path.join(directory, '.kaizen/verifier/.verifier-artifacts-1NILWD');
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'intent.txt'), 'builder prompt\n'.repeat(50));
  await fs.writeFile(path.join(artifacts, 'verdict.json'), '{"verdict":"open_pr"}\n');
  await fs.writeFile(path.join(directory, '.kaizen/verifier/verify-result.json'), '{}\n');
  return directory;
}

async function stagedPaths(directory: string): Promise<string[]> {
  const { stdout } = await run('git', ['diff', '--cached', '--name-only'], { cwd: directory });
  return stdout.split('\n').filter(Boolean).sort();
}

describe('harness scratch is kept out of the work branch', () => {
  it('stages the change but not the verifier artifacts', async () => {
    const directory = await repositoryWithScratch();
    const git = new GitClient(runCommand, directory);

    await git.addAll(['.kaizen/verifier']);

    expect(await stagedPaths(directory)).toEqual(['README.md', 'src/lib.rs']);
  });

  it('does not ask git to add an ignored verifier directory', async () => {
    const directory = await repositoryWithScratch();
    await fs.writeFile(path.join(directory, '.gitignore'), '.kaizen/*\n');
    const git = new GitClient(runCommand, directory);

    await expect(git.addAll(['.kaizen/verifier'])).resolves.toBe(true);
    expect(await stagedPaths(directory)).toEqual(['.gitignore', 'README.md', 'src/lib.rs']);
  });

  it('does not run clean filters for excluded verifier artifacts', async () => {
    const directory = await repositoryWithScratch();
    await fs.writeFile(path.join(directory, '.gitattributes'), '.kaizen/verifier/** filter=reject\n');
    await run('git', ['config', 'filter.reject.clean', 'false'], { cwd: directory });
    await run('git', ['config', 'filter.reject.required', 'true'], { cwd: directory });
    const git = new GitClient(runCommand, directory);

    await expect(git.addAll(['.kaizen/verifier'])).resolves.toBe(true);

    expect(await stagedPaths(directory)).toEqual(['.gitattributes', 'README.md', 'src/lib.rs']);
  });

  it('stages everything when no exclusion is configured', async () => {
    const directory = await repositoryWithScratch();
    const git = new GitClient(runCommand, directory);

    await git.addAll();

    // Documents the previous behaviour, which is still correct for a caller
    // that has no harness paths to exclude.
    expect(await stagedPaths(directory)).toContain('.kaizen/verifier/verify-result.json');
  });

  it('stages deletions inside the tracked tree', async () => {
    const directory = await repositoryWithScratch();
    const git = new GitClient(runCommand, directory);
    await git.addAll(['.kaizen/verifier']);
    await run('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: directory });

    await fs.rm(path.join(directory, 'src/lib.rs'));
    await git.addAll(['.kaizen/verifier']);

    // `add -A -- .` must still record removals; an `add .` would not.
    const { stdout } = await run('git', ['diff', '--cached', '--name-status'], { cwd: directory });
    expect(stdout.trim()).toBe('D\tsrc/lib.rs');
  });

  it.each([
    ['a trailing slash', '.kaizen/verifier/'],
    ['a leading ./', './.kaizen/verifier']
  ])('normalises %s', async (_label, configured) => {
    const directory = await repositoryWithScratch();
    const git = new GitClient(runCommand, directory);

    await git.addAll([configured]);

    expect(await stagedPaths(directory)).toEqual(['README.md', 'src/lib.rs']);
  });

  it.each([
    ['an absolute path', '/etc'],
    ['a parent escape', '../outside'],
    // Does not start with '..' yet still leaves the repository; git rejects the
    // pathspec outright, so a prefix check would abort the commit.
    ['an embedded parent escape', 'scratch/../../outside'],
    ['a path resolving to the root itself', '.'],
    ['an empty entry', '   ']
  ])('ignores %s rather than passing it to git', async (_label, configured) => {
    const directory = await repositoryWithScratch();
    const git = new GitClient(runCommand, directory);

    // Must not throw: git fails the whole `add` on a pathspec outside the repo.
    // The `false` return also tells the caller no exclusion was applied, so it
    // can skip the staged-changes check.
    await expect(git.addAll([configured])).resolves.toBe(false);
    expect(await stagedPaths(directory)).toContain('.kaizen/verifier/verify-result.json');
  });

  it('reports whether an exclusion was applied', async () => {
    const directory = await repositoryWithScratch();
    const git = new GitClient(runCommand, directory);

    expect(await git.addAll(['.kaizen/verifier'])).toBe(true);
    expect(await git.addAll()).toBe(false);
  });

  // `git status` still reports the tree as dirty, so the caller would proceed
  // to commit an empty index and fail, taking the run down with it.
  it('reports no staged changes when only excluded scratch is dirty', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-scratch-only-'));
    repositories.push(directory);
    await run('git', ['init', '-q', '.'], { cwd: directory });
    await fs.mkdir(path.join(directory, '.kaizen/verifier'), { recursive: true });
    await fs.writeFile(path.join(directory, '.kaizen/verifier/verify-result.json'), '{}\n');

    const git = new GitClient(runCommand, directory);
    await git.addAll(['.kaizen/verifier']);

    expect((await git.statusPorcelain()).trim()).not.toBe('');
    expect(await git.hasStagedChanges()).toBe(false);
  });

  it('reports staged changes when the review change is present', async () => {
    const directory = await repositoryWithScratch();
    const git = new GitClient(runCommand, directory);

    await git.addAll(['.kaizen/verifier']);

    expect(await git.hasStagedChanges()).toBe(true);
  });
});
