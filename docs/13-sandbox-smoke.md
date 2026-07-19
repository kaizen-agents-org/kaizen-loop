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

Readiness evidence that should survive outside one operator's home directory can be copied into:

```text
docs/smoke-runs/<run-id>-issue-<number>.json
```

The artifact indexes the normal run logs:

- `runs/<run-id>/summary.json`
- `runs/<run-id>/issue-<number>/agent.log`
- `runs/<run-id>/issue-<number>/verify.log`
- `runs/<run-id>/issue-<number>/verifier.log`
- `guardian/jobs/<job-id>.json` when `guardian.mode: async`

## Weekly Operation

Register a dedicated scheduler job with a weekly schedule and `run.mode: smoke`. The configured time is interpreted in the local timezone of the machine running launchd or cron. For example, this repository runs the sandbox smoke every Sunday at 04:45 local time:

```yaml
scheduler:
  jobs:
    weekly-sandbox-smoke:
      enabled: true
      schedule:
        type: weekly
        days: [SU]
        time: "04:45"
      run:
        mode: smoke
```

Apply the configuration with `kaizen scheduler sync`, then confirm the job with `kaizen scheduler status --json`. A weekly cadence can occasionally produce zero runs inside the rolling seven-day boundary when a run is delayed; inspect `kaizen status --metrics --json` and the artifact directory together.

The `reviewWindow.sandboxSmoke` metrics report parseable in-window artifacts as `runs`, `passed`, and `failed`, plus the paired `latestRunAt` and `latestResult`. `result: success` is a pass; every other persisted terminal result is a failure. Malformed artifacts modified inside the window are counted as `unreadable` but not as runs.

When a smoke run fails, inspect the artifact and its referenced logs, then file a bug issue with the `kaizen` label. Follow `skills/kaizen-bug-router/SKILL.md`: route the issue to the owning Kaizen Agents repository when ownership is clear, or to `kaizen-loop` when it is not. This is an operator action; the scheduler does not file the bug automatically.

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

## Recorded Smoke Runs

| Timestamp | Issue | Required artifact evidence |
|---|---|---|
| `2026-07-04T07:49:04.852Z` | `#157` | Ready-for-review PR, closing issue keyword, mechanical verification log, verifier verdict, issue-link recognition, and PR guardian status |

## Safety Notes

- `kaizen smoke` always creates the issue with `kaizen:pr-only`; it does not intentionally exercise direct-commit reflection.
- The command requires `--yes` for non-interactive use.
- Do not run smoke against production repositories unless the test PR and issue are explicitly approved.
