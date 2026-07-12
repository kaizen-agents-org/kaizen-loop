import type { RunSummary } from '../orchestrator/summary.js';
import type { GoalMechanicalEvaluation, GoalState } from './types.js';

export function buildGoalPlannerPrompt(goal: GoalState): string {
  return `You are the planner for kaizen-loop Goal execution. Break the goal into exactly one small GitHub Issue for the next iteration, or stop if the goal is already satisfied or blocked.

# Goal
${goal.title}

${goal.description || '(no description)'}

# Success criteria
${goal.successCriteria.map((item) => `- ${item}`).join('\n')}

# Constraints
${goal.constraints.length ? goal.constraints.map((item) => `- ${item}`).join('\n') : '- Follow the repository Kaizen safety policy.'}

# Previous iterations
${goal.iterations.length ? goal.iterations.map((iteration) => formatIteration(iteration)).join('\n\n') : '(none)'}

# Rules
1. Return one small, reviewable implementation issue when more work is needed.
2. Do not create broad issue batches. The goal runner will evaluate after each issue.
3. Use status "succeeded" only when all success criteria are satisfied by the previous iterations.
4. Use status "blocked" when progress requires human input or unsafe changes.
5. The generated issue must be scoped to one implementation/test/documentation step.
6. The title and body must name repository-specific behavior; never copy schema descriptions or example text.
7. The body must include sections named "Scope" and "Acceptance Criteria" with concrete, verifiable checks.

# Final response
Return only this JSON:

\`\`\`json
{
  "status": "issue",
  "reason": "Why this is the right next step.",
  "nextIssue": {
    "title": "Replace this sentence with the actual repository-specific action",
    "body": "## Scope\\nReplace this sentence with the actual files and behavior to change.\\n\\n## Acceptance Criteria\\n- Replace this sentence with an observable verification.",
    "priority": "P2"
  }
}
\`\`\`

Use status "succeeded" or "blocked" instead of "issue" when appropriate. Omit nextIssue unless status is "issue".`;
}

export function buildGoalEvaluatorPrompt(options: {
  goal: GoalState;
  runSummary: RunSummary;
  mechanicalEvaluation?: GoalMechanicalEvaluation;
}): string {
  return `You are the evaluator for kaizen-loop Goal execution. Decide whether the goal is complete after the latest iteration.

# Goal
${options.goal.title}

${options.goal.description || '(no description)'}

# Success criteria
${options.goal.successCriteria.map((item) => `- ${item}`).join('\n')}

# Constraints
${options.goal.constraints.length ? options.goal.constraints.map((item) => `- ${item}`).join('\n') : '- Follow the repository Kaizen safety policy.'}

# Previous iterations
${options.goal.iterations.length ? options.goal.iterations.map((iteration) => formatIteration(iteration)).join('\n\n') : '(none)'}

# Latest run summary
\`\`\`json
${JSON.stringify(options.runSummary, null, 2)}
\`\`\`

# Mechanical goal evaluation
${options.mechanicalEvaluation ? `Command: ${options.mechanicalEvaluation.command}
Status: ${options.mechanicalEvaluation.ok ? 'passed' : 'failed'}

\`\`\`
${tail(options.mechanicalEvaluation.output, 200)}
\`\`\`` : '(not configured)'}

# Decision rules
1. Return "succeeded" only when every success criterion is satisfied.
2. Return "continue" when progress was made but another small issue should be created.
3. Return "blocked" when human input is required or the max-iteration loop should not continue automatically.
4. Return "failed" when the latest run failed in a way that should stop the goal.
5. If status is "continue", you may include nextIssue, but the planner can also derive the next issue from your missing criteria.
6. When nextIssue is present, its title and body must name repository-specific behavior and its body must include "Scope" and "Acceptance Criteria" sections with verifiable checks.

# Final response
Return only this JSON:

\`\`\`json
{
  "status": "continue",
  "confidence": 0.75,
  "reason": "Why the goal is not finished yet.",
  "satisfiedCriteria": ["criterion already satisfied"],
  "missingCriteria": ["criterion still missing"],
  "nextIssue": {
    "title": "Replace this sentence with the actual repository-specific action",
    "body": "## Scope\\nReplace this sentence with the actual files and behavior to change.\\n\\n## Acceptance Criteria\\n- Replace this sentence with an observable verification.",
    "priority": "P2"
  }
}
\`\`\`

Omit nextIssue unless another iteration is needed.`;
}

function formatIteration(iteration: GoalState['iterations'][number]): string {
  return [
    `## Iteration ${iteration.number}`,
    `Outcome: ${iteration.outcome}`,
    iteration.issue ? `Issue: #${iteration.issue}` : undefined,
    iteration.summary ? `Summary: ${iteration.summary}` : undefined,
    iteration.evaluation ? `Evaluation: ${iteration.evaluation.status} - ${iteration.evaluation.reason}` : undefined,
    iteration.mechanicalEvaluation ? `Mechanical: ${iteration.mechanicalEvaluation.ok ? 'passed' : 'failed'} - ${iteration.mechanicalEvaluation.command}` : undefined,
    iteration.evaluation?.missingCriteria.length ? `Missing: ${iteration.evaluation.missingCriteria.join('; ')}` : undefined
  ].filter(Boolean).join('\n');
}

function tail(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}
