# PR Feedback Audit

Use these commands when a PR may have unresolved CodeRabbit, Codex, human review, or CI feedback. Prefer explicit PR URLs; otherwise run from the repo checkout.

## Resolve PRs

Current branch PR:

```sh
gh pr view --json number,url,headRefName,baseRefName,isDraft,author
```

Open PRs in the current repo:

```sh
gh pr list --state open --json number,url,headRefName,baseRefName,isDraft,author,updatedAt,title
```

Workspace scan from an org folder:

```sh
find . -maxdepth 2 -type d -name .git -print | sed 's#/.git$##' | sort
```

For each repo path, `cd` into it and run the open PR command. Prioritize PRs whose head branch is checked out locally, authored by the user, recently updated, or explicitly named by the user.

## Read PR State

```sh
gh pr view <pr> --json number,url,title,headRefName,baseRefName,isDraft,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,reviews,comments,latestReviews,reviewRequests
gh pr checks <pr>
```

Inspect failing logs:

```sh
gh run list --branch <head-branch> --limit 10
gh run view <run-id> --log-failed
```

## Fetch Thread-Aware Review Data

Flat PR comments are not enough for CodeRabbit or Codex because actionable feedback is often in inline review threads. Use GraphQL:

```sh
gh api graphql \
  -f owner='<owner>' \
  -f name='<repo>' \
  -F number=<number> \
  -f query='
query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      url
      reviewDecision
      mergeStateStatus
      reviewThreads(first:100, after:$cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first:20) {
            nodes {
              id
              fullDatabaseId
              url
              author { login }
              body
              createdAt
              outdated
              diffHunk
            }
          }
        }
      }
    }
  }
}'
```

If there are more than 100 threads, repeat the query with `-f cursor='<endCursor>'` until `pageInfo.hasNextPage` is false.

## Reply To And Resolve Review Threads

Required conversation resolution is satisfied per review thread, not by a single aggregate PR comment. For every unresolved thread that you fix, answer, skip, or prove not applicable, including stale threads that became outdated after a fix:

1. Reply to the thread's top-level review comment, using the `fullDatabaseId` from the first comment node in the thread query. GitHub's REST reply endpoint does not support replies to replies, so do not use a later reply comment id here. Do this before resolving the thread, including for outdated unresolved threads:

   ```sh
   gh api \
     --method POST \
     repos/<owner>/<repo>/pulls/<pr-number>/comments/<top-level-comment-full-database-id>/replies \
     -f body='Fixed in <commit>: <short disposition>. Verified with <command>.'
   ```

2. Resolve the thread with the GraphQL `id` from `reviewThreads.nodes[].id`:

   ```sh
   gh api graphql \
     -f threadId='<review-thread-id>' \
     -f query='
   mutation($threadId:ID!) {
     resolveReviewThread(input:{threadId:$threadId}) {
       thread { id isResolved }
     }
   }'
   ```

If a thread is not applicable, reply with the reason before resolving it. If GitHub rejects the reply or resolve mutation, keep the thread URL in the blocker report as `blocked: unresolved required conversation`.

Top-level PR comments are not review threads and cannot be resolved with `resolveReviewThread`. When a top-level comment asks for a change, reports a blocker, or asks a question, answer that comment explicitly with a PR comment or review reply disposition so the conversation has an auditable close-out.

## Identify Agent Feedback

Search both thread comments and top-level comments for authors or markers like:

- `coderabbitai`, `coderabbitai[bot]`, `CodeRabbit`
- `codex`, `codex[bot]`, `openai`, `OpenAI`
- `github-actions`, `Copilot`, or repo-specific review bots
- phrases such as `Actionable comments posted`, `requested changes`, `nitpick`, `issue`, `bug`, `failing`, `blocking`

Treat outdated threads as non-actionable only after checking whether the same point reappears in a current thread or latest bot summary.

## Completion Gate

Before reporting success, run:

```sh
gh pr view <pr> --json mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,reviews,comments,latestReviews
gh pr checks <pr> --watch  # Use a 30-minute timeout, or poll with a 30-check cap if checks may hang.
```

Then re-run the GraphQL thread query and count unresolved threads. The PR is not merge-ready if:

- `reviewDecision` is `CHANGES_REQUESTED`
- any required check is pending, skipped unexpectedly, cancelled, or failing
- `mergeStateStatus` is `BLOCKED`, `DIRTY`, `UNKNOWN`, or `BEHIND`
- an expected CodeRabbit, Codex, or other bot review is still pending
- CodeRabbit/Codex says actionable comments remain
- any review thread remains unresolved, including outdated threads left unresolved after a pushed fix
- any actionable top-level PR comment has not been answered with a clear disposition
- the PR is draft and the user wanted ready-for-review

Allowed final states:

- `merge-ready`: all gates pass
- `pending external review`: local fixes and required checks pass, but a bot or maintainer review has not completed
- `blocked`: a specific external blocker prevents completion
