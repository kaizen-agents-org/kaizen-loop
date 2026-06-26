import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRegistry, resolveProject } from '../config/registry.js';
import { loadConfig } from '../config/config.js';
import { GitHubClient } from '../github/client.js';
import type { CommandRunner } from '../utils/command.js';
import { projectStateDir } from '../utils/paths.js';
import { GitClient } from '../workspace/git.js';

interface UnreviewedRemoteBranch {
  branch: string;
  remoteRef: string;
  headSha: string;
  ahead: number;
  behind: number;
}

interface OpenPullRequestHead {
  branch: string;
  repositoryOwner?: string;
}

export async function statusProject(options: { cwd: string; project?: string; metrics?: boolean; runCommand: CommandRunner }) {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  const github = new GitHubClient(options.runCommand, resolved.project.localPath);
  const issues = await github.listIssues(config.issues.label);
  const openPullRequests = await github.listOpenPullRequests();
  const stateDir = projectStateDir(resolved.slug);
  const lastSummary = await readLatestSummary(stateDir);
  return {
    slug: resolved.slug,
    repo: resolved.project.repo,
    enabled: resolved.project.enabled,
    schedule: resolved.project.schedule,
    lastRun: resolved.project.lastRun ?? lastSummary,
    issues: {
      open: issues.length,
      selectionMode: config.issues.selection.mode,
      queued: countLabel(issues, config.issues.selection.includeLabel),
      p0: countLabel(issues, 'kaizen:P0'),
      p1: countLabel(issues, 'kaizen:P1'),
      p2: countLabel(issues, 'kaizen:P2'),
      needsHuman: countLabel(issues, 'kaizen:needs-human')
    },
    pullRequests: {
      open: openPullRequests.length
    },
    branchHygiene: await collectBranchHygiene({
      runCommand: options.runCommand,
      workspacePath: resolved.project.workspacePath,
      defaultBranch: config.git.defaultBranch,
      repoOwner: resolved.project.repo.split('/')[0],
      openPullRequestHeads: openPullRequests
        .filter((pr) => Boolean(pr.headRefName))
        .map((pr) => ({
          branch: pr.headRefName as string,
          repositoryOwner: pr.headRepositoryOwner?.login
        }))
    }),
    metrics: options.metrics ? await collectMetrics(stateDir) : undefined
  };
}

export async function listProjects() {
  return loadRegistry();
}

async function readLatestSummary(stateDir: string) {
  try {
    const runsDir = path.join(stateDir, 'runs');
    const runs = (await fs.readdir(runsDir)).sort();
    const latest = runs.at(-1);
    if (!latest) return undefined;
    return JSON.parse(await fs.readFile(path.join(runsDir, latest, 'summary.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function collectMetrics(stateDir: string) {
  try {
    const runsDir = path.join(stateDir, 'runs');
    const runs = await fs.readdir(runsDir);
    const summaries = await Promise.all(
      runs.map(async (run) => JSON.parse(await fs.readFile(path.join(runsDir, run, 'summary.json'), 'utf8')))
    );
    return {
      runs: summaries.length,
      processed: summaries.reduce((sum, item) => sum + item.issues.length, 0),
      prCreated: summaries.reduce((sum, item) => sum + item.issues.filter((issue: { outcome: string }) => issue.outcome === 'pr-created').length, 0),
      directCommit: summaries.reduce((sum, item) => sum + item.issues.filter((issue: { outcome: string }) => issue.outcome === 'direct-commit').length, 0),
      failed: summaries.reduce((sum, item) => sum + item.issues.filter((issue: { outcome: string }) => issue.outcome === 'failed').length, 0)
    };
  } catch {
    return { runs: 0, processed: 0, prCreated: 0, directCommit: 0, failed: 0 };
  }
}

function countLabel(issues: Array<{ labels: Array<{ name: string }> }>, label: string): number {
  return issues.filter((issue) => issue.labels.some((item) => item.name === label)).length;
}

async function collectBranchHygiene(options: {
  runCommand: CommandRunner;
  workspacePath: string;
  defaultBranch: string;
  repoOwner: string;
  openPullRequestHeads: OpenPullRequestHead[];
}): Promise<{ checked: boolean; unreviewedRemoteBranches: UnreviewedRemoteBranch[]; error?: string }> {
  try {
    const git = new GitClient(options.runCommand, options.workspacePath);
    await git.fetchPrune();
    const openPullRequestBranches = new Set(
      options.openPullRequestHeads
        .filter((head) => head.repositoryOwner === options.repoOwner)
        .map((head) => head.branch)
    );
    const defaultRemoteRef = `origin/${options.defaultBranch}`;
    const unreviewedRemoteBranches: UnreviewedRemoteBranch[] = [];

    for (const branch of await git.remoteBranches('origin')) {
      if (branch.ref === 'origin/HEAD' || branch.ref === defaultRemoteRef || branch.name === options.defaultBranch) continue;
      if (openPullRequestBranches.has(branch.name)) continue;

      const divergence = await git.divergence(defaultRemoteRef, branch.ref);
      if (divergence.ahead === 0) continue;

      unreviewedRemoteBranches.push({
        branch: branch.name,
        remoteRef: branch.ref,
        headSha: branch.sha,
        ahead: divergence.ahead,
        behind: divergence.behind
      });
    }

    return { checked: true, unreviewedRemoteBranches };
  } catch (error) {
    return {
      checked: false,
      unreviewedRemoteBranches: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
