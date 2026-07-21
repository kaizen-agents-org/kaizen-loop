# Repository Instructions

## Kaizen Issue-to-PR MVP

- Treat GitHub Issues as selected for Kaizen Loop processing only when they have both `kaizen` and `kaizen:ready`; manual/external authorization also requires `kaizen:authorized`.
- Keep the MVP PR-first: create ready-for-review pull requests, not draft PRs, unless explicitly requested.
- Every implementation PR must include a GitHub closing keyword in the PR body, for example `Closes #123`.
- Do not rely on issue comments, PR titles, or branch names alone to link issues.
- If requirements are unclear, ask on the issue instead of guessing.
- Do not modify secrets, credentials, billing, destructive data changes, or production infrastructure without explicit human approval.

## Verification

Run these before opening a PR:

```sh
npm test
npm run typecheck
npm run build
```

## Local Kaizen Runtime

The committed `.kaizen/config.yml` assumes these commands are available on the machine running `kaizen-loop`:

- `builder-agent`
- `verifier`

Before enabling scheduled runs, build or link the local `builder-agent` and `verifier` CLIs so those commands resolve from PATH.

## Shared Kaizen Skills

Shared Kaizen Agents skills are vendored under `skills/` from `kaizen-agents-org/.github/skills`.

- Use `skills/gh-link-issue-pr/SKILL.md` when opening or updating implementation PRs so source issues are linked with closing keywords.
- Use `skills/kaizen-bug-router/SKILL.md` when a Kaizen Agents bug is reported; file the bug in the owning repository, or in `kaizen-loop` if ownership is unclear.
- Use `skills/pr-guardian/SKILL.md` after opening a PR; monitor checks with `gh run watch`, address actionable feedback, comment on each addressed item, and stop only when the PR is mergeable or a real blocker remains.

When the shared skills are updated in `.github`, apply the sync PR for this repository or run the org-level sync script from the sibling `.github` checkout.
