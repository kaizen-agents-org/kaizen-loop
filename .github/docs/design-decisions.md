# Design decisions

## 2026-07-13: External-operation authorization and safety defaults

Kaizen Loop treats third-party repositories as an external trust boundary. New configurations therefore default to `safety.operationMode: external`; the Kaizen Agents self-organization deployment explicitly uses `dogfood` to retain its existing label-selection behavior.

In external mode, an issue is not executable merely because it has the base `kaizen` label. It must also have `issues.executionAuthorization.label` (default `kaizen:authorized`). Immediately before selection completes, Kaizen Loop fetches fresh issue state, reads the complete paginated label-event history, and requires the latest matching transition to be `labeled`. The actor who performed that transition must currently have at least `issues.executionAuthorization.minimumPermission` (default `triage`). Missing or inconsistent events, label removal, deleted actors, insufficient permission, and API/permission lookup failures all fail closed and produce a skip reason. Label matching follows GitHub's case-insensitive behavior.

This is not atomic with subsequent GitHub operations: a maintainer can remove a label after the check. Fetching fresh state narrows that race, while the PR-only and verifier gates limit its impact. Tokens used for external operation must be able to read issue events and collaborator permission; otherwise execution is intentionally skipped. If a migrated issue has an active label but no qualifying event, remove and re-add the authorization label.

External mode rejects both `verifier.enabled: false` and replacement of `verifier.command` during config parsing, so repository-controlled configuration cannot substitute a no-op command for the deterministic auth/secrets/billing/migration classifier. That classifier belongs to the separately installed `verifier` executable. The host operator must provide the trusted executable on `PATH`; this repository does not validate its capability or version. A future capability handshake is required to close that host-installation trust boundary. Dogfood mode may use a custom verifier command.

The defaults audit made these decisions:

- General child-process environments no longer inherit `GH_CONFIG_DIR`, `SSH_AUTH_SOCK`, or `GIT_SSH_COMMAND`. GitHub and Git authentication variables are forwarded only to their respective CLI invocations. `HOME` remains necessary for the configured agent CLIs and is a documented residual credential boundary.
- CI providers, release/publish directories, environment files, secret directories, migrations, and package-publisher config are protected, so they cannot take a direct-commit path.
- Git metadata, SSH/GnuPG directories, credential directories, and private-key file extensions are forbidden because human review after autonomous modification is not a sufficient default for credential material.
- External mode remains `pr-only` with a mandatory verifier. Dogfood mode may opt into the pre-existing verifier/direct-commit combinations, but it does not weaken forbidden-path enforcement.
