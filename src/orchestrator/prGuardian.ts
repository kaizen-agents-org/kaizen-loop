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
- Inspect CI logs and review feedback if anything fails or blocks mergeability.
- Address actionable feedback with focused commits and push them.
- Reply or comment on each addressed review item with the action taken.
- Stop only when mergeStateStatus is CLEAN with required checks passing, retry budget is exhausted, or an external blocker remains.
- Do not merge the PR.
- Before finishing, comment on the PR with final mergeability, watched runs, fixes pushed, feedback addressed, and remaining blockers.`;
}
