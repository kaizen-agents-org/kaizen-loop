# GitHub Actions deployment

The reusable workflow provides an ephemeral `issue labeled -> kaizen fix -> ready pull request` path for external repositories. The target repository commits only `.kaizen/config.yml` and one caller workflow; local scheduler and fleet operation remain unchanged.

## Trust boundaries

The workflow deliberately separates credentials and generated code:

1. `prepare` re-fetches the issue and verifies the active authorization label and the label actor's current permission.
2. `codex` generates a binary patch through `openai/codex-action` with read-only repository permission, checkout credentials disabled, and its API-key proxy enabled. If it fails, `claude` tries `anthropics/claude-code-action` with the same read-only repository permission.
3. `verify` has no provider secret or write-capable token. It applies the patch through `kaizen fix --actions-patch`, runs repository setup/verification, invokes the pinned trusted verifier, and seals the patch SHA-256 plus evidence in an artifact.
4. `publish` has no provider secret and does not execute repository code. It re-checks authorization, requires the same base commit and patch hash, disables Git hooks, pushes a branch, and creates a ready PR with a closing keyword.

The provider artifact records the selected provider and preceding failed attempts. A GitHub Action failure that does not expose a structured provider error is recorded as `external_action_failure`; it falls back without being treated as a human-input block. Provider-native 429/timeout details remain visible in the Action log, while the stable workflow contract stays fail-closed.

## Requirements

- The committed config must use `safety.operationMode: external`, `policy.mode: pr-only`, and the trusted default `verifier` command.
- The issue must have the configured authorization label (default `kaizen:authorized`) applied by a collaborator with at least the configured permission (default `triage`).
- Add `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or both as Actions secrets. Codex is attempted first and Claude is the fallback.
- The caller grants `contents: write`, `issues: read`, and `pull-requests: write`; each reusable-workflow job narrows its own token permissions.
- `KAIZEN_GITHUB_TOKEN` is optional but recommended. Use a narrowly scoped GitHub App token or fine-grained PAT when PR creation must start downstream `pull_request` workflows. PRs created with the repository `GITHUB_TOKEN` may not trigger a new workflow run.

No provider key belongs in `safety.envAllowlist`. Setup, verification, verifier, and publish processes never receive provider secrets.

## Caller workflow

Commit this as the repository's single Kaizen workflow, replacing `<PINNED-KAIZEN-REF>` with a reviewed kaizen-loop commit or release tag:

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
    uses: kaizen-agents-org/kaizen-loop/.github/workflows/kaizen-fix-reusable.yml@<PINNED-KAIZEN-REF>
    with:
      issue-number: ${{ github.event.issue.number }}
      runtime-ref: <PINNED-KAIZEN-REF>
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      KAIZEN_GITHUB_TOKEN: ${{ secrets.KAIZEN_GITHUB_TOKEN }}
```

Do not use `secrets: inherit`: pass only the provider keys and optional publish token. Keep the workflow reference immutable in third-party repositories, and set `runtime-ref` to the exact same full commit SHA used after `@` in `uses`.

## Failure behavior

- Missing/removed authorization, insufficient actor permission, changed issue metadata, changed base commit, malformed/empty/oversized patches, forbidden paths, failed setup/verification, verifier rejection, and artifact hash mismatch all stop before publication.
- Codex Action failure activates Claude fallback and records `external_action_failure` evidence.
- If both providers fail, verification and publication do not run. Rerun the failed workflow after resolving provider capacity or authentication.
- Removing the authorization label after generation still prevents publication because authorization is checked again in the publish job.

The workflow's source checkouts and third-party actions are pinned by commit SHA. Update those pins through a normal reviewed PR.
