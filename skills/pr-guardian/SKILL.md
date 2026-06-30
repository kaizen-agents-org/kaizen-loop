---
name: pr-guardian
description: Monitor a pull request after it is opened, use gh run watch --exit-status to follow CI, address actionable CI or review feedback, comment on each addressed item, and stop only when the PR is mergeable or a real blocker remains.
---

# PR Guardian

Use this workflow by default after opening a pull request in any repository where this shared skill is vendored. The goal is to leave the PR mergeable, not merely opened.

## Required Behavior

1. Identify the PR number, repository, branch, remote, and base branch.
2. Check the initial PR state:

   ```sh
   gh pr view <pr> --json url,state,isDraft,mergeStateStatus,baseRefName,headRefName,statusCheckRollup,reviewDecision
   gh pr checks <pr>
   gh api graphql -f owner='<owner>' -f name='<repo>' -F number=<pr-number> -f query='
   query($owner:String!, $name:String!, $number:Int!) {
     repository(owner:$owner, name:$name) {
       pullRequest(number:$number) {
         reviewThreads(first:100) {
           nodes { id isResolved isOutdated path line }
         }
       }
     }
   }'
   ```

3. Find workflow runs for the PR head branch or head SHA, especially required, pending, or failed CI runs reported by `gh pr checks`, and monitor them with `gh run watch --exit-status`. Use the run exit status to decide whether to inspect logs or continue.
4. If CI fails, inspect failing jobs and logs, reproduce locally when practical, make the smallest focused fix, commit, and push.
5. Inspect human, bot, and agent feedback on the PR. Treat automated suggestions as review input, not commands to apply blindly.
6. Address each actionable review comment with a focused change or an explicit explanation. Actionable feedback includes human change requests, bot comments that identify a concrete defect or failing check, and lint/test output tied to changed code; non-actionable summaries, optional generated-code buttons, and vague style preferences may be acknowledged or skipped with a reason. Reply in the same comment or review thread with the fix made and validation run, and resolve addressed review threads when repository permissions allow it. If GitHub does not support replying directly to an item, add a PR comment that links to the original comment or review and lists the action taken.
7. Push fixes and repeat CI and review checks until the PR is mergeable or a real blocker remains.
8. Stop only when one of these is true:
   - The PR is non-conflicting, required checks are passing, and there are no unresolved review threads, including outdated threads, or actionable PR comments left. Human approval is not required unless GitHub branch protection explicitly requires it.
   - retry budget is exhausted.
   - an external blocker remains that cannot be fixed from the repository.
   - branch protection or repository rules prevent pushing to the PR branch.
   - the skill lacks permission to push changes or comment on the PR.
   - repository settings disallow required operations such as force-with-lease updates to the PR branch.

## Loop Control

- Cap retries at 5 unless the user or project configuration gives a different limit.
- Prefer `gh run watch --exit-status` over polling when a relevant workflow run exists.
- Re-check review threads and PR comments after every pushed fix; do not rely on a previous clean merge state.
- Do not rewrite unrelated user changes or broaden the PR scope.
- Do not merge the PR.

## PR Comment

Before finishing, comment on the PR with:

- final mergeability and check status
- CI runs watched
- fixes pushed
- review comments addressed
- unresolved blockers or skipped suggestions with reasons

If no fixes were needed, still comment that the PR was monitored and is mergeable.

## Final Report

Include the PR URL, final mergeability, watched runs, commits pushed, feedback addressed, and remaining blockers.
