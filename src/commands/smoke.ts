import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import type { GitHubPullRequestLinkage } from '../github/types.js';
import type { RunSummary } from '../orchestrator/summary.js';
import { extractLastJsonObject } from '../utils/json.js';
import { projectStateDir } from '../utils/paths.js';
import type { CommandRunner } from '../utils/command.js';
import { reportIssueNow } from './report.js';

export interface SandboxSmokeOptions {
  cwd: string;
  project?: string;
  title?: string;
  body?: string;
  priority?: 'P0' | 'P1' | 'P2';
  agent?: 'claude' | 'codex';
  json: boolean;
  assumeYes?: boolean;
  runCommand: CommandRunner;
}

export interface SandboxSmokeArtifact {
  version: 1;
  kind: 'sandbox-e2e-smoke';
  project: {
    slug: string;
    repo: string;
  };
  startedAt: string;
  finishedAt: string;
  result: RunSummary['result'];
  issue: {
    number: number;
    title: string;
    url?: string;
  };
  run: {
    id: string;
    trigger: string;
    summaryPath: string;
    issueLogDir: string;
  };
  implementation: {
    outcome?: string;
    branch?: string;
    changedFiles?: number;
    changedLines?: number;
  };
  verification: {
    commands: string[];
    verifyLogPath: string;
    verifier: {
      enabled: boolean;
      verdict?: string;
      logPath: string;
    };
  };
  pullRequest?: {
    number?: number;
    url?: string;
    baseRefName?: string;
    defaultBranch?: string;
    isDraft?: boolean;
    closingIssuesReferences?: Array<{ number: number; url?: string }>;
    issueLinkRecognized: boolean;
  };
  guardian?: {
    status: string;
    summary: string;
    jobId?: string;
  };
  artifactPath: string;
}

export async function runSandboxSmoke(options: SandboxSmokeOptions): Promise<SandboxSmokeArtifact> {
  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  const startedAt = new Date().toISOString();
  const title = options.title ?? defaultSmokeTitle(startedAt);
  const body = options.body ?? defaultSmokeBody(startedAt);
  const result = await reportIssueNow({
    cwd: options.cwd,
    project: resolved.slug,
    title,
    body,
    priority: options.priority ?? 'P2',
    direct: false,
    prOnly: true,
    agent: options.agent,
    queue: true,
    extraLabels: [],
    json: options.json,
    assumeYes: options.assumeYes,
    runCommand: options.runCommand
  });

  const run = result.fix;
  if (!('issues' in run)) {
    throw new Error('Smoke run unexpectedly returned a dry-run selection.');
  }
  const issueSummary = run.issues.find((issue) => issue.number === result.issue.number) ?? run.issues[0];
  const runId = toRunId(new Date(run.startedAt));
  const stateDir = projectStateDir(resolved.slug);
  const runDir = path.join(stateDir, 'runs', runId);
  const issueLogDir = path.join(runDir, `issue-${result.issue.number}`);
  const verifierLogPath = path.join(issueLogDir, 'verifier.log');
  const artifactDir = path.join(stateDir, 'smoke-runs');
  const artifactPath = path.join(artifactDir, `${runId}-issue-${result.issue.number}.json`);
  const github = new GitHubClient(options.runCommand, resolved.project.localPath);
  const prLinkage = issueSummary?.pr ? await maybeGetPullRequestLinkage(github, issueSummary.pr) : undefined;
  const defaultBranch = issueSummary?.pr ? await maybeGetDefaultBranch(github) : undefined;

  const artifact: SandboxSmokeArtifact = {
    version: 1,
    kind: 'sandbox-e2e-smoke',
    project: {
      slug: resolved.slug,
      repo: resolved.project.repo
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    result: run.result,
    issue: {
      number: result.issue.number,
      title: result.issue.title,
      url: result.issue.url
    },
    run: {
      id: runId,
      trigger: run.trigger,
      summaryPath: path.join(runDir, 'summary.json'),
      issueLogDir
    },
    implementation: {
      outcome: issueSummary?.outcome,
      branch: issueSummary?.branch,
      changedFiles: issueSummary?.changedFiles,
      changedLines: issueSummary?.changedLines
    },
    verification: {
      commands: config.commands.verify,
      verifyLogPath: path.join(issueLogDir, 'verify.log'),
      verifier: {
        enabled: config.verifier.enabled,
        verdict: await verifierVerdict(verifierLogPath, issueSummary?.reason),
        logPath: verifierLogPath
      }
    },
    pullRequest: issueSummary?.prUrl || prLinkage
      ? {
        number: issueSummary?.pr ?? prLinkage?.number,
        url: issueSummary?.prUrl ?? prLinkage?.url,
        baseRefName: prLinkage?.baseRefName,
        defaultBranch,
        isDraft: prLinkage?.isDraft,
        closingIssuesReferences: prLinkage?.closingIssuesReferences,
        issueLinkRecognized: Boolean(
          prLinkage?.closingIssuesReferences.some((issue) => issue.number === result.issue.number)
        )
      }
      : undefined,
    guardian: issueSummary?.guardian,
    artifactPath
  };

  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function defaultSmokeTitle(startedAt: string): string {
  return `[sandbox-smoke] Verify Kaizen issue-to-PR path ${startedAt}`;
}

function defaultSmokeBody(startedAt: string): string {
  return `## Sandbox smoke objective

This controlled smoke issue verifies the real Kaizen issue-to-PR path for a sandbox repository.

## Requested harmless change

Make the smallest reviewable repository change that records this smoke run, for example by adding or updating \`docs/sandbox-smoke.md\` with the run timestamp \`${startedAt}\`.

## Required evidence

- The PR must be ready for review, not draft.
- The PR body must include a closing keyword for this issue.
- Mechanical verification, verifier, issue-link recognition, and PR guardian status must be visible in the smoke artifact.
`;
}

async function verifierVerdict(logPath: string, reason: string | undefined): Promise<string | undefined> {
  try {
    const payload = extractLastJsonObject(await fs.readFile(logPath, 'utf8')) as { status?: unknown };
    if (typeof payload.status === 'string') return payload.status;
  } catch {
    // Fall back to older reason strings below.
  }
  return reason?.match(/\bverifier:\s*([a-z_]+)/i)?.[1];
}

async function maybeGetPullRequestLinkage(
  github: GitHubClient,
  pr: number
): Promise<GitHubPullRequestLinkage | undefined> {
  try {
    return await github.getPullRequestLinkage(pr);
  } catch {
    return undefined;
  }
}

async function maybeGetDefaultBranch(github: GitHubClient): Promise<string | undefined> {
  try {
    return await github.getRepositoryDefaultBranch();
  } catch {
    return undefined;
  }
}

function toRunId(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}
