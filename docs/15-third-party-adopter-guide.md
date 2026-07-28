# Third-party adopter guide

This guide is for maintainers installing Kaizen Loop in a repository outside
`kaizen-agents-org`. The recommended deployment is the credential-separated
GitHub Actions workflow. A local scheduler is available when you need
operator-managed infrastructure.

Kaizen Loop turns an authorized GitHub Issue into a ready-for-review pull
request. It does not merge the pull request. The issue is input evidence, the
builder proposes a patch, repository commands and a trusted verifier gate that
patch, and a maintainer makes the final merge decision.

## Before you install

You need:

- repository admin access to configure Actions, secrets, labels, and branch
  protection;
- GitHub Actions enabled, with repository policy permitting the reusable
  workflow and the actions it pins;
- a stable setup command and one or more verification commands that pass on a
  clean GitHub-hosted Ubuntu runner;
- an OpenAI API key, an Anthropic API key, or both, with an owner-approved
  budget and rate limits;
- a maintainer who will authorize Issues and review generated pull requests.

The harness runtime uses Node.js 20 or later. `kaizen init` has built-in command
proposals for Node.js, Python, Go, Rust, and Ruby repositories, in that detection
order. These are starting points, not compatibility certification. The Actions
runner must contain every tool your `commands.setup` and `commands.verify`
entries require. Review the generated or copied commands against your lockfiles,
monorepo layout, and CI before authorizing an Issue.

If your default branch requires status checks, confirm that the generated pull
request can start those checks. A pull request created with the repository
`GITHUB_TOKEN` may not trigger a new `pull_request` workflow; use the optional
`KAIZEN_GITHUB_TOKEN` described below when necessary.

## Recommended installation: GitHub Actions

The target repository commits two files: `.kaizen/config.yml` and one caller
workflow.

### 1. Add the repository policy

Start with this minimal `.kaizen/config.yml`, replacing the commands and default
branch for your repository:

```yaml
version: 1

safety:
  operationMode: external
  wipLimit: 5

commands:
  setup: "npm ci"
  verify:
    - "npm test"
    - "npm run typecheck"
    - "npm run build"

verifier:
  enabled: true
  command: "verifier"

policy:
  mode: pr-only

git:
  defaultBranch: main

issues:
  label: kaizen
  executionAuthorization:
    label: kaizen:authorized
    minimumPermission: triage
  selection:
    mode: opt-in
    includeLabel: kaizen:ready
```

Unspecified fields use the audited defaults. Keep `operationMode: external`,
`policy.mode: pr-only`, and the trusted `verifier` command: external mode rejects
a disabled or substituted verifier. Review the complete
[configuration reference](./03-config-spec.md) before adding environment
variables or changing path policy.

### 2. Add the caller workflow

Copy the caller from [GitHub Actions deployment](./14-github-actions.md). Pin
both the reusable workflow reference and `runtime-ref` to the same reviewed,
full 40-character commit SHA:

```yaml
name: Kaizen issue fix

on:
  issues:
    types: [labeled]

permissions:
  contents: write
  issues: read
  pull-requests: write

jobs:
  fix:
    if: github.event.label.name == 'kaizen:authorized'
    uses: kaizen-agents-org/kaizen-loop/.github/workflows/kaizen-fix-reusable.yml@<FULL-KAIZEN-COMMIT-SHA>
    with:
      issue-number: ${{ github.event.issue.number }}
      runtime-ref: <FULL-KAIZEN-COMMIT-SHA>
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      KAIZEN_GITHUB_TOKEN: ${{ secrets.KAIZEN_GITHUB_TOKEN }}
```

Do not use a moving branch, use different SHAs for `uses` and `runtime-ref`, or
use `secrets: inherit`. Review pin updates through a normal pull request.

### 3. Add credentials and labels

Create Actions secrets for one or both providers:

- `OPENAI_API_KEY` for the Codex provider;
- `ANTHROPIC_API_KEY` for the Claude fallback;
- optionally, `KAIZEN_GITHUB_TOKEN`, using a narrowly scoped GitHub App token or
  fine-grained PAT, when the created pull request must trigger downstream CI.

Provider keys belong only in Actions secrets. Do not add them to
`safety.envAllowlist`, repository variables, `.env` files, or the workflow
itself. Configure provider billing alerts and rotation outside Kaizen Loop.

Create the `kaizen`, `kaizen:ready`, and `kaizen:authorized` labels. The
authorization label must be applied by a collaborator whose current permission
meets `minimumPermission`. The default is `triage`; raise it to `write`,
`maintain`, or `admin` if your repository needs a smaller authorization group.

### 4. Run the first Issue

1. Open a narrowly scoped Issue with observed behavior, expected behavior, and
   verification expectations.
2. Add `kaizen` to mark it as eligible.
3. Add `kaizen:ready` to select it for execution.
4. After reviewing the Issue as untrusted input, an authorized maintainer adds
   `kaizen:authorized`. Add this label last because its label event starts the
   workflow.
5. Watch the `Kaizen issue fix` workflow.
6. Review the ready pull request; do not merge from the workflow result alone.

Removing authorization after generation still prevents publication because the
publish job re-fetches the Issue and checks eligibility, opt-in selection, and
authorization again. If an imported Issue has the authorization label but no
usable label event, remove it and have an authorized maintainer add it again.

## What the safety boundary does

Issue bodies and comments are wrapped as untrusted data in builder and verifier
prompts. Repository instructions, committed policy, mechanical verification,
and the actual diff take precedence over requests embedded in an Issue.
Authorization does not make Issue content trusted; it only permits the harness
to evaluate that content.

The Actions workflow separates capabilities:

1. `prepare` re-fetches the Issue and checks the eligibility and opt-in
   selection labels, active authorization label, latest label event, and actor
   permission.
2. `codex`, then `claude` as fallback, receives a read-only checkout and a
   provider key and emits a patch.
3. `verify` receives neither provider keys nor a write-capable token. It rejects
   forbidden paths, applies the patch, runs setup and verification, invokes the
   pinned trusted verifier, and seals the base commit and patch hash.
4. `publish` receives no provider key and runs no repository code. It rechecks
   authorization, the base commit, and the sealed artifact before creating a
   ready pull request with `Closes #<issue>`.

`safety.envAllowlist` is the complete allowlist for repository commands and
agents, plus Kaizen-owned runtime variables. The target repository's `.env` is
not loaded automatically. Adding a variable can expose it to untrusted
repository code, so add only non-secret values required by setup or tests.

Default protected paths include CI configuration, `.kaizen/**`, `.env` files,
secret directories, migration/release/publish paths, package registry config,
and Dockerfiles. They may be changed only through human-reviewed pull requests.
Default forbidden paths include Git internals, SSH/GnuPG data, credential paths,
private keys, and certificates; a matching patch is rejected before setup runs.
See [Safety](./07-safety.md) for the full defaults and failure modes.

External mode also requires the trusted verifier. It is a conservative
PR-creation gate, not merge approval. It cannot be replaced through repository
configuration to bypass its auth, secrets, billing, and migration checks.

## Review and operate generated work

Read each generated pull request in this order:

1. Confirm the source Issue and closing reference are correct.
2. Compare the builder's task understanding with the actual Issue.
3. Review every changed file and its stated reason, especially protected paths.
4. Confirm each verification command was actually executed and passed.
5. Read the verifier status, evidence grade, warnings, and required fixes.
6. Inspect residual risks, then check the diff, required CI, approvals, and
   unresolved review conversations yourself.

Treat builder statements as reported evidence, diff statistics as static
evidence, and Kaizen-run commands as executed evidence. A verifier
`open_pr_with_warning` is a review prompt, not permission to ignore the warning.
Branch protection remains authoritative. If conversation resolution is
required, reply to and resolve each actionable thread, including stale bot
threads, before merging.

For the local scheduled path, two backpressure settings limit unattended intake:

- `run.maxOpenPullRequests` limits open pull requests in one repository;
- `safety.wipLimit` limits open generated pull requests across the owner.

When either limit is reached, scheduled intake skips new work so maintainers can
review the oldest generated pull requests first. Explicit `kaizen fix` runs are
not stopped by the repository limit. The reusable Actions workflow is triggered
for a specific Issue and does not apply these scheduled-intake limits; it only
serializes duplicate runs for that Issue. Control Actions volume with who may
apply the authorization label and your normal review queue.

`kaizen:needs-human` means a local run has recorded one concrete unanswered
question or approval request. Answer the question in the Issue, then remove the
label to acknowledge that request. Do not use this label as a pause switch.
Remove the base `kaizen` label to exclude one Issue, or disable the scheduler to
pause local automation. Other terminal labels and recovery steps are documented
in [Issue conventions](./05-issue-conventions.md).

## Optional local installation

Use the local path when you can operate a persistent macOS or Linux host and
install `git`, `gh`, `builder-agent`, `verifier`, and the configured guardian
runner. Authenticate `gh` and the selected provider tooling using
operator-managed credentials.

From a clean checkout of the target repository:

```sh
npx kaizen-loop init --agent codex --schedule 02:00
```

`kaizen init` proposes setup and verification commands, creates
`.kaizen/config.yml` and the Issue template, creates labels, registers an
isolated workspace, and prepares scheduler settings. Review and commit the two
generated repository files before enabling unattended runs. The generated
selection mode is `auto`; change it to the same explicit ready-label gate used
by the Actions installation:

```yaml
issues:
  selection:
    mode: opt-in
    includeLabel: kaizen:ready
```

Commit that policy change with the generated files. Validate the
installation and perform a dry run before synchronizing the scheduler:

```sh
npx kaizen-loop doctor
npx kaizen-loop run --dry-run --json
npx kaizen-loop scheduler sync
```

Process one already authorized Issue manually with:

```sh
npx kaizen-loop fix 42 --json
```

Local execution uses the same authorization, untrusted-input, path, verification,
verifier, and PR-first gates. `kaizen doctor --repair` may recreate missing
labels, but it does not decide whether your verification commands are correct.
See the [CLI specification](./02-cli-spec.md) and
[instant-run behavior](./09-instant-run.md) before operating it unattended.

## Troubleshooting

### The Actions workflow does not start or `prepare` fails

- Confirm Actions are enabled and repository policy permits the referenced
  reusable workflow and pinned actions.
- Confirm the Issue has `kaizen`, `kaizen:ready`, and `kaizen:authorized`.
- Confirm the latest authorization-label event was created by a collaborator
  who still meets `minimumPermission`.
- Confirm the caller's `uses` SHA and `runtime-ref` are identical full lowercase
  commit SHAs.
- If permission or event lookup fails, fix token/repository permissions; the
  gate intentionally fails closed.

### Provider timeout, rate limit, or authentication failure

In Actions, a failed Codex attempt falls back to Claude when its secret is
configured. If neither provider produces a patch, verification and publication
do not run. Inspect the provider job for a 429, timeout, quota, or authentication
error, correct provider capacity or credentials, and rerun the failed workflow.
Do not move provider keys into verification or publish jobs.

In the local pipeline, recognized timeout and rate-limit failures use the
retryable disposition and consume the configured retry budget; after
`run.maxAttemptsPerIssue`, the Issue becomes `kaizen:attempts-exhausted`.
These local labels are not the Actions fallback mechanism.

### Verification passes locally but fails in Actions

Run the exact `commands.setup` and `commands.verify` sequence from a clean Linux
checkout. Check lockfiles, runtime versions, native or optional dependencies,
monorepo working-directory assumptions, case-sensitive paths, and tests that
depend on undeclared environment variables or services. Keep secrets out of
`envAllowlist`; use test doubles or separately reviewed CI services instead.

### The verifier blocks publication

Read the verifier reason and evidence in the `verify` job. Fix the patch or
clarify the Issue and rerun. A suspected false positive still requires human
review; do not disable or replace the verifier in external mode. For local runs,
a genuine missing decision may become a concrete `kaizen:needs-human` request;
answer it before retrying.

### The pull request is not mergeable

Compare branch protection's required-check names with checks that actually ran.
If downstream `pull_request` CI never started, configure a narrowly scoped
`KAIZEN_GITHUB_TOKEN`. Address requested changes and resolve required
conversations. Rebase or regenerate if the default branch advanced; the Actions
workflow refuses to publish a patch verified against a stale base.

## Uninstall or roll back

Stop new work before removing policy:

1. Disable or delete the caller workflow. For a local installation, run
   `npx kaizen-loop scheduler disable` first.
2. Remove `kaizen:authorized` from open Issues so an in-flight publish check
   fails closed.
3. Cancel any active Kaizen workflow runs.
4. Review open generated pull requests. Close unwanted pull requests and delete
   their branches only after preserving any work you need; merged changes are
   not reverted automatically.
5. Remove provider secrets and revoke the optional App/PAT token if it was
   dedicated to Kaizen.
6. In a reviewed cleanup pull request, remove the caller workflow,
   `.kaizen/config.yml`, and the optional Kaizen Issue template. Remove labels
   only after no automation or reporting depends on them.

To roll back a broken harness update, disable the workflow, remove authorization
from active Issues, and revert the commit that changed the pinned workflow SHA
or configuration. Restore the last reviewed pin/configuration, then test with a
harmless sandbox Issue before re-enabling authorization. Reverting the harness
does not revert application pull requests it previously created or merged.

Operational validation in a real third-party repository is a separate exercise,
tracked by
[kaizen-agents-org/.github#120](https://github.com/kaizen-agents-org/.github/issues/120).
Use a sandbox repository and preserve its workflow logs and pull-request evidence
instead of weakening these gates in a production repository.
