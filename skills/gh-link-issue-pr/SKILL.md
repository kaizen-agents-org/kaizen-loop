---
name: gh-link-issue-pr
description: Create or update GitHub pull requests for kaizen-agents-org so they are linked to the source issue with GitHub closing keywords. Use when opening PRs, editing PR bodies, publishing implementation branches, or cleaning up issue-to-PR workflow problems in this project.
---

# GitHub Issue-Linked PR

## Rule

Every implementation PR for `kaizen-agents-org` must link its source issue in the PR body with a GitHub closing keyword.

Do not rely on only:

- the PR title containing `#123`
- an issue comment such as `Implemented in ...`
- a branch name containing the issue number

Those do not close the issue when the PR is merged.

## Workflow

1. Identify the source issue before creating the PR.
   - Use the issue from the user request when provided.
   - If the branch was created from an issue, infer it from branch name or commit messages, then verify with `gh issue view`.
   - If no issue exists, do not invent one. State that the PR has no linked issue.
2. Put the closing reference in the PR body, preferably near the top or bottom.
3. Create a regular ready-for-review PR unless the user explicitly asks for draft.
4. After PR creation, verify the PR targets the default branch and GitHub recognizes the link:

```sh
gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
gh pr view <number> --json baseRefName,closingIssuesReferences,isDraft,url
```

Compare `defaultBranchRef.name` from `gh repo view` with `baseRefName` from `gh pr view`. They must match because GitHub only applies closing keywords automatically when the PR targets the default branch. `closingIssuesReferences` should include the intended issue. `isDraft` should be `false` unless the user requested draft.

## Closing Keyword Format

Use one of GitHub's closing keywords: `Closes`, `Fixes`, or `Resolves`.

For issues in the same repository:

```markdown
Closes #42
```

For issues in another repository:

```markdown
Closes kaizen-agents-org/builder-agent#3
```

Use one line per issue when closing multiple issues.

## PR Body Template

```markdown
## Summary
- ...

## Verification
- ...

Closes #<issue-number>
```

For Kaizen Agents generated PRs, include the normal workflow context as well:

- original issue
- builder summary
- self-review result
- mechanical verification result
- verifier verdict
- risk or known limitations

## Existing PR Cleanup

If a PR is open and missing the issue link, edit the PR body and add the closing keyword before merge.

If a PR was already merged without a closing keyword, GitHub will not auto-close the issue retroactively. Comment on the issue with the merged PR link, then close the issue manually if the PR fully resolved it.
