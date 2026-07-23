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
- `issues.executionAuthorization.label` (default `kaizen:authorized`) means execution is authorized.
- `issues.selection.includeLabel` (default `kaizen:ready`) selects the issue for queued Kaizen Loop execution when `issues.selection.mode: opt-in`.
- Creating an issue must not imply execution authorization unless the user explicitly asks to queue, run, approve, or execute it.

For bundled issue-filing skills such as `kaizen-bug-router`, the table describes the labels stamped for each explicit user intent, not universal runtime prerequisites:

| User intent | Registration |
|---|---|
| File or record a bug | `kaizen` plus priority/bug labels when available |
| Queue for the next loop | `kaizen`, `issues.executionAuthorization.label` (default `kaizen:authorized`), `issues.selection.includeLabel` (default `kaizen:ready`) |
| Run immediately | `kaizen`, `issues.executionAuthorization.label` (default `kaizen:authorized`), `issues.selection.includeLabel` (default `kaizen:ready`), then an explicit immediate command such as `kaizen fix <issue>` |
| Needs human input first | `kaizen` を付け、オーケストレータへ構造化 `humanRequest` を返す。skill が `kaizen:needs-human` を直接付けてはならない |

`kaizen:needs-human` は具体的な未回答 request 専用であり、versioned marker と安定した request identity を保存するオーケストレータだけが付与する。単なる失敗・上流先行・試行上限を表す目的では指定しない。

Runtime selection depends on `issues.selection.mode`:

- `auto`: scheduled selection requires the base `kaizen` label; `issues.selection.includeLabel` is not required. Execution authorization remains a separate gate.
- `opt-in`: scheduled selection requires both the base `kaizen` label and `issues.selection.includeLabel`. Execution authorization remains a separate gate.
- `manual-only`: scheduled selection does not pick any issue. An explicit command such as `kaizen fix <issue>` is required and execution authorization still applies.

`kaizen queue` and the default `kaizen report --now` path stamp the base, execution-authorization, and selection labels regardless of selection mode, so the table above records command behavior even where `auto` does not require the selection label.
