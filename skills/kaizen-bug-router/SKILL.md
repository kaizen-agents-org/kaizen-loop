---
name: kaizen-bug-router
description: Investigate bugs in kaizen-agents-org, identify which project owns the failing behavior, and file a GitHub issue in the correct repository. Use when a user reports a Kaizen Agents bug, regression, broken workflow, unexpected issue-to-PR behavior, agent orchestration failure, verifier failure, builder failure, or org-level skill/documentation bug; if ownership is unclear after investigation, file the bug in kaizen-loop by default.
---

# Kaizen Bug Router

## Rule

When a Kaizen Agents bug is reported, investigate where the bug originates before filing an issue. File exactly one primary issue in the owning repository. If the owner cannot be determined with reasonable evidence, file the issue in `kaizen-agents-org/kaizen-loop`.

## Repository Routing

- `kaizen-agents-org/builder-agent`: builder execution, build request/result contracts, Codex/Claude backend invocation, self-review, implementation output, builder artifacts, or generated change quality before verifier review.
- `kaizen-agents-org/verifier`: verifier execution, verdict schemas, MVP verdict statuses (`open_pr`, `open_pr_with_warning`, `block_pr`, `needs_context`), `must_fix`/`should_fix` semantics, approval/rejection logic, verification prompts, risk evaluation, or verifier result artifacts.
- `kaizen-agents-org/kaizen-loop`: issue selection, labels, scheduling, registry/config loading, orchestration, retry loops, workspace/git handling, GitHub issue/PR operations, reflection policy, protected path handling, comments, or cross-agent handoff.
- `kaizen-agents-org/coderabbit`: CodeRabbit configuration, review policy, automated review rules, or review feedback behavior owned by the shared CodeRabbit setup.
- `kaizen-agents-org/renovate-config`: Renovate presets, dependency update policy, package rule behavior, or shared dependency automation configuration.
- `kaizen-agents-org/.github`: org-level shared docs, issue templates, reusable skills, PR/issue linking guidance, or org configuration.

Use `kaizen-loop` as the fallback when symptoms span multiple projects or the available evidence does not isolate a clearer owner.

## Workflow

1. Gather evidence from the user's report, local logs, failing commands, linked issues/PRs, and relevant code.
2. Reproduce or narrow the failure when practical. Keep the investigation focused on ownership; do not implement the fix in this workflow unless the user asks.
3. Check for an existing issue before creating a new one:

   ```sh
   gh issue list --repo kaizen-agents-org/<repo> --search "<short error or behavior>"
   ```

4. Choose the target repository using the routing rules above. If uncertain, choose `kaizen-agents-org/kaizen-loop` and say why ownership is unclear.
5. Create the issue with a clear title, evidence, and routing rationale. Prefer labels that exist in the target repository:

   ```sh
   gh label list --repo kaizen-agents-org/<repo> --limit 200
   gh issue create --repo kaizen-agents-org/<repo> --title "<title>" --body-file <body-file>
   ```

Only pass `--label` values that exist. Prefer `bug` for ordinary bug reports and add the base `kaizen` label by default when it exists. Treat `kaizen` as a visibility/routing label, not execution authorization. If no useful labels exist, create the issue without labels rather than blocking.

Issue creation and execution authorization are separate:

- Add `kaizen` by default when the label exists, but do not add `kaizen:ready` or any other execution-selection label by default.
- Add the execution authorization label only when the user asks to queue, approve, run, execute, or put the issue on the Kaizen Loop.
- In opt-in selection mode, prefer `kaizen:ready` as the execution authorization label when it exists.
- If the user asks for immediate execution, file the issue, add the execution authorization label when available, then report the explicit command that should run next, such as `kaizen fix <issue>`.
- If the issue needs human clarification before automation, prefer `kaizen:needs-human` instead of `kaizen:ready`.

## Issue Body

Use this structure:

```markdown
## Bug
<What failed or behaved unexpectedly.>

## Evidence
- <Exact command, log excerpt, PR/issue link, file path, or observed behavior.>

## Expected
<What should happen instead.>

## Routing
Filed in `<repo>` because <short ownership rationale>.

## Notes
- If ownership is uncertain, state what was checked and why this issue falls back to `kaizen-loop`.
```

## Output

After filing, report:

- created issue URL
- selected repository
- labels applied
- one-sentence routing rationale

If a duplicate issue exists, do not create another issue. Return the existing issue URL and the reason it matches.
