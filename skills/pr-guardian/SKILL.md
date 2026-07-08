---
name: pr-guardian
description: Monitor or resume GitHub pull requests, fix CI failures and actionable CodeRabbit, Codex, bot, or human review feedback, push focused updates, and stop only when the PR is merge-ready or has a concrete external blocker.
---

# PR Guardian

Use this workflow by default after opening a pull request, and when an existing PR needs follow-up after CI, CodeRabbit, Codex, bot, or human review feedback. The goal is to leave the PR merge-ready or report a specific blocker, not to provide a partial status update.

## Workflow

1. Resolve the target PRs.
   - Use explicit repo or PR URLs when provided.
   - Otherwise identify the current branch PR, branch, remote, and expected base branch.
   - If the user asks for "each repo" or "all repos", scan the relevant workspace repositories, list open PRs, and process one repo at a time.
2. Load local repo context before edits.
   - Read local instructions such as `AGENTS.md`, package scripts, branch status, and PR metadata.
   - Preserve unrelated local changes.
3. Build a complete PR state and feedback inventory.
   - Read `mergeStateStatus`, `mergeable`, `reviewDecision`, `statusCheckRollup`, `reviews`, `latestReviews`, review requests, PR comments, and `gh pr checks`.
   - Always fetch thread-aware review data before claiming success. Flat PR comments are not enough because CodeRabbit, Codex, and human actionable feedback is often in inline review threads.
   - Use `references/pr-feedback-audit.md` for concrete `gh` and GraphQL commands when thread state, bot comments, CI logs, or cross-repo scanning matter.
4. Classify every feedback item.
   - `fix`: code, docs, tests, CI, or config change is needed.
   - `respond`: a reviewer asked for clarification and no code change is appropriate.
   - `ignore`: duplicate, outdated, already resolved, or demonstrably wrong.
   - `blocked`: credentials, product decision, external service, or maintainer action is required.
5. Start or continue CI monitoring.
   - Use `gh run watch` for the relevant workflow run when practical.
   - If CI fails, inspect failing jobs and logs, reproduce locally when practical, and make the smallest fix.
6. Implement all `fix` items.
   - Keep edits scoped to the PR and trace each change back to a feedback or CI cluster.
   - Add or update tests when the feedback identifies behavior risk.
   - Do not rewrite unrelated user changes or broaden the PR scope.
7. Handle every current review thread explicitly.
   - Required conversation resolution is per GitHub review thread, not per PR. The merge gate "all comments must be resolved" is satisfied only when every unresolved `reviewThreads` node has been replied to or intentionally handled and then resolved.
   - For `fix` items, reply in the same review thread or directly to the review comment with the fix made and validation run.
   - For `respond` and `ignore` items, reply in the same review thread or directly to the review comment with the clarification or reason the suggestion is not applicable.
   - Reply before resolving. Use the thread's first review comment `fullDatabaseId` for the REST reply endpoint, then resolve the thread with the GraphQL `reviewThreads.nodes[].id`.
   - Resolve each addressed GitHub review thread, including outdated unresolved threads, when permissions allow. If GitHub does not allow replying or resolving, report the thread URL as `blocked: unresolved required conversation`.
   - Do not rely on an aggregate PR comment as a substitute for per-thread disposition; repositories with required conversation resolution stay blocked until each current thread is resolved.
8. Push fixes and repeat the PR state, CI, and feedback checks.
   - Re-fetch review threads after CodeRabbit, Codex, or other review automation has had time to update.
   - If CodeRabbit, Codex, or another expected review bot is `pending`, `in_progress`, or says it is still processing changes after a push, keep waiting within the review wait window. Any unresolved-thread count gathered while a review bot is still processing is provisional and must not be reported as the final conversation state.
   - After every expected review bot reaches a terminal state, re-fetch thread-aware review data before replying, resolving, posting a final PR update, or reporting success. New bot comments can appear after CI is already green.
   - Continue while `reviewDecision` is `CHANGES_REQUESTED`, required checks are pending or failing, expected bot reviews are pending, any review thread remains unresolved, any actionable top-level PR comment lacks a clear disposition, or `mergeStateStatus` is `BLOCKED`, `DIRTY`, `UNKNOWN`, or `BEHIND`.
9. Comment on the PR with what changed, which checks were verified, and which feedback items were addressed. If a suggestion is not applied, explain why and link to the per-thread reply.

## Mergeability gate

Before finalizing, run a final state check such as:

```sh
gh pr view <pr> --json mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,reviews,comments
gh pr checks <pr> --watch
```

Also re-run the thread-aware GraphQL query and count unresolved review threads:

```sh
gh api graphql \
  -f owner='<owner>' \
  -f name='<repo>' \
  -F number=<number> \
  -f query='
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first:20) {
            nodes {
              fullDatabaseId
              url
              author { login }
              body
              outdated
            }
          }
        }
      }
    }
  }
}'
```

If `pageInfo.hasNextPage` is true, paginate before counting unresolved threads. For each unresolved thread that has been handled, reply and resolve:

```sh
gh api \
  --method POST \
  repos/<owner>/<repo>/pulls/<pr-number>/comments/<top-level-comment-full-database-id>/replies \
  -f body='Fixed in <commit>: <short disposition>. Verified with <command>.'

gh api graphql \
  -f threadId='<review-thread-id>' \
  -f query='
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { id isResolved }
  }
}'
```

Success requires all of these:

- `mergeStateStatus` is clean enough for the repository to merge, usually `CLEAN`, `HAS_HOOKS`, or `UNSTABLE` with only non-required failures explicitly documented.
- `reviewDecision` is not `CHANGES_REQUESTED`.
- All required checks in `statusCheckRollup` pass.
- Expected CodeRabbit, Codex, or other bot reviews have completed, and thread-aware review data has been re-fetched after they completed. If checks pass but an expected bot review is still pending, report `pending external review` only after the wait window is exhausted, and make clear that the unresolved-thread count is not final while the bot is still processing.
- All actionable human, bot, CodeRabbit, Codex, or agent review comments are fixed, answered, or explicitly explained as not applicable in the relevant review thread or top-level PR conversation.
- Thread-aware review data shows zero unresolved review threads, including outdated threads. If any thread remains unresolved, do not report merge-ready even when `mergeable` is `MERGEABLE`; report `blocked: unresolved required conversations` with the thread URLs unless the only remaining step is a pending external reviewer action.

If `mergeable` is `MERGEABLE` but `mergeStateStatus` remains `BLOCKED`, keep investigating branch protection, unresolved requested changes, required review state, required conversations, or pending checks. Do not report the PR as mergeable until the blocking reason is gone or documented as an external blocker.

## Loop control

- Default to 5 fix-and-push attempts per PR.
- Cap each CI or review wait window at 30 minutes, or 30 polling checks at 60-second intervals. If checks or review bots are still pending after that, do one fresh PR-state and review-thread fetch, then report `pending external review` instead of waiting indefinitely. Do not claim conversations are resolved when the latest bot review is still pending.
- If the same CI failure or review comment returns after two fixes, stop broad changes and inspect the underlying assumption before trying again.
- For cross-repo work, finish and report one PR before moving to the next so context loss still leaves useful progress.

## Final Report

Group by repo when multiple PRs are involved. Include:

- PR URL, identifier, and branch
- feedback sources inspected, including CodeRabbit/Codex thread status
- CI runs watched and final status
- fixes pushed and commits
- comments or review feedback addressed, including per-thread replies, resolved thread count, and any suggestions intentionally not applied
- PR comment posted or drafted
- unresolved review-thread count, including outdated threads
- final state: merge-ready, pending external review, or blocked with reason
