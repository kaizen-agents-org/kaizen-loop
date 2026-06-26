import type { KaizenConfig } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';

export interface PrGuardianSkillRequest {
  config: KaizenConfig;
  workspaceDir: string;
  repo: string;
  prUrl: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
}

export interface PrGuardianSkillResult {
  status: 'success' | 'failed' | 'skipped';
  summary: string;
  raw: string;
  durationMs: number;
}

export async function runPrGuardianSkill(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<PrGuardianSkillResult> {
  if (!req.config.guardian.enabled) {
    return { status: 'skipped', summary: 'PR guardian skill is disabled.', raw: '', durationMs: 0 };
  }

  const startMs = Date.now();
  const maxAttempts = req.config.guardian.maxAttempts;
  const rawOutputs: string[] = [];
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runCommand(
        req.config.guardian.command,
        [
          'exec',
          '--cd',
          req.workspaceDir,
          '--dangerously-bypass-approvals-and-sandbox',
          buildPrompt(req, attempt)
        ],
        {
          cwd: req.workspaceDir,
          timeoutMs: req.config.guardian.timeoutMinutes * 60_000,
          rejectOnNonZero: false
        }
      );
      rawOutputs.push(`${result.stdout}${result.stderr}`);
      if (result.exitCode !== 0) {
        return {
          status: 'failed',
          summary: `PR guardian skill exited with code ${result.exitCode}.`,
          raw: rawOutputs.join('\n'),
          durationMs: Date.now() - startMs
        };
      }

      const unresolvedReviewThreads = await listUnresolvedReviewThreads(runCommand, req);
      if (unresolvedReviewThreads.length === 0) {
        return {
          status: 'success',
          summary: 'PR guardian skill completed; no unresolved review threads remain.',
          raw: rawOutputs.join('\n'),
          durationMs: Date.now() - startMs
        };
      }
      rawOutputs.push(`Unresolved review feedback after guardian pass ${attempt}:\n${summarizeReviewThreads(unresolvedReviewThreads)}`);
    }

    return {
      status: 'failed',
      summary: `PR guardian stopped with unresolved review feedback after ${maxAttempts} attempt(s).`,
      raw: rawOutputs.join('\n'),
      durationMs: Date.now() - startMs
    };
  } catch (error) {
    return {
      status: 'failed',
      summary: String(error),
      raw: String(error),
      durationMs: Date.now() - startMs
    };
  }
}

export async function isPrGuardianSkillRunnerAvailable(config: KaizenConfig, runCommand: CommandRunner): Promise<boolean> {
  try {
    await runCommand(config.guardian.command, ['--version'], { rejectOnNonZero: true, timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

interface ReviewThreadSummary {
  path: string;
  line?: number | null;
  author?: string;
  body?: string;
}

interface ReviewThreadsResponse {
  errors?: Array<{ message?: string }>;
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
          };
          nodes?: Array<{
            isResolved?: boolean;
            isOutdated?: boolean;
            path?: string;
            line?: number | null;
            comments?: {
              nodes?: Array<{
                body?: string;
                author?: {
                  login?: string;
                } | null;
              }>;
            };
          }>;
        };
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes {
              body
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}`;

async function listUnresolvedReviewThreads(
  runCommand: CommandRunner,
  req: PrGuardianSkillRequest
): Promise<ReviewThreadSummary[]> {
  const [owner, name] = req.repo.split('/');
  if (!owner || !name) throw new Error(`Cannot inspect PR review threads for invalid repo: ${req.repo}`);

  const unresolved: ReviewThreadSummary[] = [];
  let cursor: string | undefined;
  let hasNextPage = true;
  while (hasNextPage) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${req.prNumber}`
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const result = await runCommand('gh', args, {
      cwd: req.workspaceDir,
      timeoutMs: 60_000,
      rejectOnNonZero: false
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not inspect PR review threads: ${result.stderr || result.stdout}`);
    }
    const response = JSON.parse(result.stdout || '{}') as ReviewThreadsResponse;
    if (response.errors?.length) {
      throw new Error(`Could not inspect PR review threads: ${response.errors.map((error) => error.message).join('; ')}`);
    }
    const reviewThreads = response.data?.repository?.pullRequest?.reviewThreads;
    if (!reviewThreads) throw new Error('Could not inspect PR review threads: response did not include reviewThreads.');
    for (const thread of reviewThreads?.nodes ?? []) {
      if (thread.isResolved || thread.isOutdated) continue;
      const firstComment = thread.comments?.nodes?.[0];
      unresolved.push({
        path: thread.path ?? '(unknown path)',
        line: thread.line,
        author: firstComment?.author?.login,
        body: firstComment?.body
      });
    }
    hasNextPage = Boolean(reviewThreads?.pageInfo?.hasNextPage);
    cursor = reviewThreads?.pageInfo?.endCursor ?? undefined;
  }
  return unresolved;
}

function summarizeReviewThreads(threads: ReviewThreadSummary[]): string {
  return threads
    .map((thread) => {
      const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
      const author = thread.author ? ` by ${thread.author}` : '';
      const body = thread.body?.trim().split('\n')[0];
      return `- ${location}${author}${body ? ` - ${body}` : ''}`;
    })
    .join('\n');
}

function buildPrompt(req: PrGuardianSkillRequest, attempt: number): string {
  return `Use the vendored PR Guardian skill at skills/pr-guardian/SKILL.md.

Monitor this pull request until it is mergeable or a real blocker remains:
- Repository: ${req.repo}
- PR: ${req.prUrl}
- PR number: ${req.prNumber}
- Branch: ${req.branch}
- Base branch: ${req.baseBranch}
- Retry budget: ${req.config.guardian.maxAttempts}
- Guardian pass: ${attempt}/${req.config.guardian.maxAttempts}

Requirements:
- Read and follow skills/pr-guardian/SKILL.md.
- Check the PR with gh pr view and gh pr checks.
- Watch relevant workflow runs with gh run watch --exit-status when a run exists.
- Always inspect PR review feedback before declaring the PR mergeable, even when mergeStateStatus is CLEAN.
- Fetch inline review threads and PR comments with resolution state using paginated GraphQL/API reads, iterating until hasNextPage=false, for example via PullRequest.reviewThreads, so unresolved actionable feedback cannot be missed.
- Address every unresolved actionable review thread, PR comment, and check annotation with focused commits or an explicit disposition, then push any fixes. If you can resolve an addressed review thread, resolve it after replying with the disposition.
- Reply or comment on each addressed review item with the action taken.
- Stop only when mergeStateStatus is CLEAN, required checks are passing, and no non-outdated unresolved review threads or actionable PR comments remain. CLEAN/checks passing alone is not enough; inspect comments again after every pushed fix.
- Do not merge the PR.
- Before finishing, comment on the PR with final mergeability, watched runs, fixes pushed, feedback addressed, unresolved/skipped feedback with reasons, and remaining blockers.`;
}
