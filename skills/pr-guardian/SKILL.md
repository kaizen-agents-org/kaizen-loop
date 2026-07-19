---
name: pr-guardian
description: Monitor a pull request after it is opened, use gh run watch --exit-status to follow CI, address actionable CI or review feedback, comment on each addressed item, and stop only when the PR is mergeable or a real blocker remains.
---

# PR Guardian

Use this workflow by default after opening a pull request in any repository where this shared skill is vendored. The goal is to leave the PR mergeable, not merely opened.

## Required Behavior

1. Identify the PR number, repository, branch, remote, base branch, and current head SHA. Prefer the durable `kaizen guardian run <pr> --project <slug> --json` runner when the repository is registered, unless this skill is already running inside a guardian pass; generated sync PRs carrying `<!-- kaizen-pr-guardian:managed -->` are adopted by scheduled reconciliation.
2. Check the initial PR state:

   ```sh
   gh pr view <pr> --json url,state,isDraft,mergeable,mergeStateStatus,baseRefName,headRefName,statusCheckRollup,reviewDecision
   gh pr checks <pr>
   ```

3. Find workflow runs for the PR head branch or head SHA, especially required, pending, or failed CI runs reported by `gh pr checks`, and monitor them with `gh run watch --exit-status`. Use the run exit status to decide whether to inspect logs or continue.
4. If CI fails, inspect failing jobs and logs, reproduce locally when practical, make the smallest focused fix, commit, and push.
5. Inspect human, bot, and agent feedback on the PR. Read `references/pr-feedback-audit.md` and run its executable GraphQL cursor loops and REST `--paginate` commands before deciding that no feedback remains. Fetch review threads, nested review comments, PR comments, reviews, check runs, and check-run annotations through the GitHub API; paginate every connection until `hasNextPage=false` by feeding every `endCursor` into the next request, and exhaust every REST page. Flat PR comments and first pages are not a complete audit. Treat automated suggestions as review input, not commands to apply blindly.
6. Address each actionable review thread with a focused change or an explicit explanation. Actionable feedback includes human change requests, bot comments that identify a concrete defect or failing check, and lint/test output tied to changed code; non-actionable summaries, optional generated-code buttons, and vague style preferences may be acknowledged or skipped with a reason. After the fix is pushed and verified, reply to each addressed thread with the commit and validation evidence, then resolve that thread with `resolveReviewThread`. One aggregate PR comment never substitutes for per-thread disposition. If GitHub rejects a reply or resolution, report that thread URL as a concrete blocker.
7. Push fixes and repeat CI and the complete feedback audit until the PR is mergeable or a real blocker remains. Before every push from an isolated guardian worktree, confirm that GitHub's current head SHA still equals the SHA captured at the start of the pass; never overwrite a newer head. After every push, discard earlier CI and automated-review completion evidence and pin the new head SHA.
8. Stop only when one of these is true:
   - GitHub reports `isDraft=false`, `mergeable=MERGEABLE`, and `mergeStateStatus=CLEAN` or `HAS_HOOKS`, or `UNSTABLE` with only documented non-required failures; required checks are passing; required approvals are present; all unresolved review threads, including outdated threads, are resolved when conversation resolution is enforced; and no actionable PR comments or check annotations remain. Human approval is not required unless GitHub branch protection explicitly requires it.
   - retry budget is exhausted.
   - an external blocker remains that cannot be fixed from the repository.
   - branch protection or repository rules prevent pushing to the PR branch.
   - the skill lacks permission to push changes or comment on the PR.
   - repository settings disallow required operations such as force-with-lease updates to the PR branch.

## Loop Control

- Cap retries at 5 unless the user or project configuration gives a different limit.
- Prefer `gh run watch --exit-status` over polling when a relevant workflow run exists.
- Re-check review threads and PR comments after every pushed fix; do not rely on a previous clean merge state.
- Fetch automated review evidence from the paginated REST `pulls/<pr>/reviews` endpoint and compare `commit_id` with the pinned head SHA. `gh pr view --json reviews` is not current-head evidence.
- Wait for expected automated reviewers to reach a terminal state for the pinned head, then re-run the complete thread-aware audit. A check marked successful before a bot publishes inline feedback is not final evidence.
- Before declaring success, take two passing snapshots at least 30 seconds apart after automated review completes. Both must have the same head SHA and no new check, review, comment, or thread activity. Any activity resets this stabilization window.
- A successful pass is not a permanent terminal state while the PR remains open. Durable reconciliation must re-observe it; a same-head late review thread reactivates the guardian without waiting for another push.
- An empty review list before expected bots finish is pending review, not proof that there are no findings.
- Do not rewrite unrelated user changes or broaden the PR scope.
- Do not merge the PR.

## PR Comment

Before finishing, comment on the PR with:

- final mergeability and check status
- CI runs watched
- fixes pushed
- review comments addressed
- unresolved blockers or skipped suggestions with reasons

If no fixes were needed, still comment with the observed final state. Include any blocking checks, missing approvals, unresolved conversations, permission problems, or external blockers instead of assuming the PR is mergeable.

## Mergeability Gate

Before reporting success:

1. Pin the current head SHA and verify `isDraft=false`, `mergeable=MERGEABLE`, and an allowed `mergeStateStatus`.
2. Verify every required check is passing for that head.
3. Verify expected automated reviews are terminal for that head; an older or missing `commit_id` is pending evidence.
4. Re-run the paginated review-thread audit after the reviewers finish and require zero unresolved threads, including outdated threads.
5. Require every actionable top-level comment and check annotation to have an explicit disposition.
6. Complete the stabilization snapshots described above.

`mergeable=MERGEABLE` only means the branches have no merge conflict. If `mergeStateStatus=BLOCKED`, continue investigating required checks, reviews, and unresolved conversations; do not report the pull request as merge-ready.

## Final Report

Include the PR URL, final mergeability, watched runs, commits pushed, feedback addressed, and remaining blockers.
