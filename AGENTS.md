# Repository Instructions

## Kaizen Issue-to-PR MVP

- Treat GitHub Issues labeled `kaizen` as eligible for Kaizen Loop processing.
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
