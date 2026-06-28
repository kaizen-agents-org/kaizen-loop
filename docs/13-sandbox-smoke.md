# 13. Sandbox E2E Smoke Runs

`kaizen smoke` runs one controlled issue-to-PR pass against a sandbox repository and writes a durable artifact for production-readiness review.

Use this only against repositories where a harmless test PR is acceptable. The command creates a real GitHub Issue, runs the same instant pipeline as `kaizen report --now`, opens a ready-for-review PR, checks GitHub's closing-issue recognition, and records the run under local Kaizen state.

```sh
kaizen smoke --project <sandbox-project> --yes --json
```

The default smoke issue asks the builder to make a minimal harmless repository change, such as recording the smoke timestamp in `docs/sandbox-smoke.md`. Override the issue when the sandbox repository needs a different safe change:

```sh
kaizen smoke \
  --project <sandbox-project> \
  --title "[sandbox-smoke] Verify issue-to-PR path" \
  --body "Add one timestamped line to docs/sandbox-smoke.md." \
  --yes \
  --json
```

## Artifact Location

Each run writes:

```text
~/.kaizen/projects/<slug>/smoke-runs/<run-id>-issue-<number>.json
```

The artifact indexes the normal run logs:

- `runs/<run-id>/summary.json`
- `runs/<run-id>/issue-<number>/agent.log`
- `runs/<run-id>/issue-<number>/verify.log`
- `runs/<run-id>/issue-<number>/verifier.log`
- `guardian/jobs/<job-id>.json` when `guardian.mode: async`

## Readiness Evidence

Readiness reviews should record the artifact path and check these fields:

| Field | Evidence |
|---|---|
| `issue.number` / `issue.url` | The real sandbox GitHub Issue that entered the loop |
| `implementation.branch` | The isolated issue branch used for the run |
| `pullRequest.url` | The ready-for-review PR created by Kaizen Loop |
| `verification.commands` / `verification.verifyLogPath` | Mechanical verification commands and output |
| `verification.verifier.verdict` / `verification.verifier.logPath` | Verifier gate result and raw verifier log |
| `pullRequest.issueLinkRecognized` | Whether GitHub recognized the PR closing keyword for the issue |
| `pullRequest.isDraft` | Must be `false` unless a human explicitly requested draft behavior |
| `guardian.mode` / `guardian.status` | PR guardian mode and outcome, or queued job status when async guardian is configured |
| `guardian.jobId` / `guardian.jobPath` | Async PR guardian job id and durable job artifact path, when a job is queued |

`pullRequest.issueLinkRecognized` is computed from `gh pr view --json closingIssuesReferences`. It is stronger evidence than a branch name, PR title, or issue comment because it confirms GitHub recognizes the closing keyword on the PR.

## Safety Notes

- `kaizen smoke` always creates the issue with `kaizen:pr-only`; it does not intentionally exercise direct-commit reflection.
- The command requires `--yes` for non-interactive use.
- Do not run smoke against production repositories unless the test PR and issue are explicitly approved.
