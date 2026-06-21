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

  const prompt = buildPrompt(req);
  const startMs = Date.now();
  try {
    const result = await runCommand(
      req.config.guardian.command,
      [
        'exec',
        '--cd',
        req.workspaceDir,
        '--dangerously-bypass-approvals-and-sandbox',
        prompt
      ],
      {
        cwd: req.workspaceDir,
        timeoutMs: req.config.guardian.timeoutMinutes * 60_000,
        rejectOnNonZero: false
      }
    );
    const raw = `${result.stdout}${result.stderr}`;
    return {
      status: result.exitCode === 0 ? 'success' : 'failed',
      summary:
        result.exitCode === 0
          ? 'PR guardian skill completed.'
          : `PR guardian skill exited with code ${result.exitCode}.`,
      raw,
      durationMs: result.durationMs
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

function buildPrompt(req: PrGuardianSkillRequest): string {
  return `Use the vendored PR Guardian skill at skills/pr-guardian/SKILL.md.

Monitor this pull request until it is mergeable or a real blocker remains:
- Repository: ${req.repo}
- PR: ${req.prUrl}
- PR number: ${req.prNumber}
- Branch: ${req.branch}
- Base branch: ${req.baseBranch}
- Retry budget: ${req.config.guardian.maxAttempts}

Requirements:
- Read and follow skills/pr-guardian/SKILL.md.
- Check the PR with gh pr view and gh pr checks.
- Watch relevant workflow runs with gh run watch --exit-status when a run exists.
- Always inspect PR review feedback before declaring the PR mergeable, even when mergeStateStatus is CLEAN.
- Fetch inline review threads and PR comments with resolution state using paginated GraphQL/API reads, iterating until hasNextPage=false, for example via PullRequest.reviewThreads, so unresolved actionable feedback cannot be missed.
- Address every unresolved actionable review thread, PR comment, and check annotation with focused commits or an explicit disposition, then push any fixes.
- Reply or comment on each addressed review item with the action taken.
- Stop only when mergeStateStatus is CLEAN, required checks are passing, and no unresolved actionable review feedback remains; otherwise continue until retry budget is exhausted or an external blocker remains.
- Do not merge the PR.
- Before finishing, comment on the PR with final mergeability, watched runs, fixes pushed, feedback addressed, unresolved/skipped feedback with reasons, and remaining blockers.`;
}
