# Bundled Skills

Kaizen Agents repositories can vendor shared skills under `skills/`. These skills are part of the operating model and should be reviewed when issue routing, PR linking, or mergeability policy changes.

## Current bundled skills

| Skill | Responsibility |
|---|---|
| `kaizen-bug-router` | Investigate a Kaizen Agents bug, choose the owning repository, and file one GitHub issue with evidence and routing rationale |
| `kaizen-goal` | Decide when to use Goal mode and operate `kaizen goal` without manually creating iteration issues |
| `gh-link-issue-pr` | Ensure implementation PRs link their source issue with GitHub closing keywords |
| `pr-guardian` | Monitor an opened PR, address CI/review feedback, and leave it merge-ready or report a blocker |

## Issue registration and execution authorization

Issue creation and loop execution are separate decisions.

- `kaizen` means the issue is managed by Kaizen tooling.
- `kaizen:ready` means the issue is approved for queued Kaizen Loop execution when `issues.selection.mode: opt-in`.
- Creating an issue must not imply execution authorization unless the user explicitly asks to queue, run, approve, or execute it.

For bundled issue-filing skills such as `kaizen-bug-router`:

| User intent | Labels |
|---|---|
| File or record a bug | `kaizen` plus priority/bug labels when available |
| Queue for the next loop | `kaizen`, `kaizen:ready` |
| Run immediately | `kaizen`, `kaizen:ready`, then an explicit immediate command such as `kaizen fix <issue>` |
| Needs human input first | `kaizen`, `kaizen:needs-human` |

When `issues.selection.mode: auto`, the base `kaizen` label remains enough for automatic selection. When `issues.selection.mode: manual-only`, scheduled selection does not pick any issue; explicit commands are required.
