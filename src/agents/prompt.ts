import type { KaizenConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/types.js';
import type { DiffStats } from '../workspace/manager.js';
import type { AgentResult } from './types.js';

export function buildFixPrompt(options: {
  repo: string;
  issue: GitHubIssue;
  config: KaizenConfig;
  attempt: number;
  previousFailure?: string;
}): string {
  const comments = options.issue.comments?.map((comment) => comment.body).join('\n\n---\n\n') || '(none)';
  const verify = options.config.commands.verify.length > 0 ? options.config.commands.verify.join(' && ') : '(not configured)';
  const constraints = [...options.config.policy.protectedPaths, ...options.config.policy.forbiddenPaths].join(', ');

  return `You are the nightly maintenance agent for "${options.repo}". Fix exactly this GitHub issue.

# Issue #${options.issue.number}: ${options.issue.title}

${options.issue.body || '(no body)'}

## Existing comments
${comments}

${options.previousFailure ? `## Previous failure for attempt ${options.attempt}\n${options.previousFailure}\n` : ''}

# Constraints

1. Fix only this issue. Do not do unrelated refactors, formatting, or dependency updates.
2. Do not modify these paths: ${constraints}
3. Do not run git push, gh commands, or create pull requests.
4. Verify with: ${verify}
5. Respect existing project instructions such as AGENTS.md or CLAUDE.md.
6. Commit your changes with message: kaizen: <summary> (#${options.issue.number})
7. Add regression tests when practical.

# Final response

After completing the work, make your final response only this JSON in a json code fence:

\`\`\`json
{
  "status": "fixed",
  "summary": "What changed, in Japanese, within 3 lines.",
  "notes": "",
  "blockedReason": ""
}
\`\`\`

Use status "blocked" if the issue lacks information or the requested change would require modifying a forbidden/protected path.`;
}

export function buildVerifierPrompt(options: {
  repo: string;
  issue: GitHubIssue;
  agentResult: AgentResult;
  verifyResults: Array<{ command: string; ok: boolean; output: string }>;
  diff: DiffStats;
}): string {
  const verify = options.verifyResults.length
    ? options.verifyResults.map((result) => `- ${result.ok ? '[x]' : '[ ]'} ${result.command}`).join('\n')
    : '- Verification commands are not configured';
  const files = options.diff.files.length ? options.diff.files.map((file) => `- ${file}`).join('\n') : '- (no files)';

  return `You are the verifier for the kaizen-loop run in "${options.repo}". Review the current workspace after the builder agent and mechanical verification have passed.

# Issue #${options.issue.number}: ${options.issue.title}

${options.issue.body || '(no body)'}

# Builder result

${options.agentResult.summary}

${options.agentResult.notes || ''}

# Mechanical verification

${verify}

# Changed files

${files}

# Decision rules

Return "approved" when the change is correct and can proceed to PR creation.
Return "pr_only" when the change is acceptable but should explicitly be reviewed as a PR.
Return "rejected" when the builder must revise the change before a PR is created.

# Final response

After completing the review, make your final response only this JSON in a json code fence:

\`\`\`json
{
  "status": "approved",
  "summary": "What you verified, in Japanese, within 3 lines.",
  "notes": "",
  "reason": ""
}
\`\`\``;
}
