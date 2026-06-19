---
name: kaizen-goal
description: Use Kaizen Goal mode whenever the user asks for a goal, target outcome, iterative improvement, "until done" work, quality/capability uplift, or any task likely to need multiple design, implementation, test, and evaluation cycles rather than one bounded issue.
---

# Kaizen Goal

Use `kaizen goal` readily when the user asks for an outcome that likely requires multiple design, implementation, test, and evaluation cycles.

Use `kaizen report --now` or `kaizen fix <issue>` for one bounded bug or improvement.

## Trigger Heuristics

Prefer `kaizen goal` when the request contains signals like:

- goal, target, objective, success criteria, reach, achieve, until done, keep improving
- 設計、実装、テスト、評価を回す
- カバレッジを上げる、品質を上げる、信頼性を上げる、ドキュメントを整備する
- multiple areas, unknown number of steps, repeated evaluation, or a broad outcome rather than a specific patch

When uncertain between a single issue and a Goal, choose Goal if success requires evaluating progress after one change.

## Workflow

1. Create a Goal with explicit success criteria:

   ```sh
   kaizen goal create "<goal title>" --success "<measurable criterion>" --json
   ```

2. Run it only with explicit approval in automation:

   ```sh
   kaizen goal run <goal-id> --yes --json
   ```

3. Treat status as the source of truth:

   ```sh
   kaizen goal status <goal-id> --json
   ```

4. Stop when status is `succeeded`, `blocked`, `failed`, or `stopped`.

5. Use `goal.evaluation.command` in `.kaizen/config.yml` when success can be mechanically checked, such as tests, coverage, lint, or docs validation. Mechanical evaluation prevents an AI evaluator from marking a Goal succeeded while the command still fails.

## Rules

- Do not manually create multiple GitHub issues for a Goal. The Goal runner creates iteration issues.
- Do not treat Goal as a replacement for Issue tracking. Every implementation iteration still goes through a normal Kaizen Issue.
- Do not continue running a blocked or stopped Goal.
- Goal still follows all Kaizen safety rules: no secrets, billing, destructive data changes, or production infrastructure changes without explicit human approval.
