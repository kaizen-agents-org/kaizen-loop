# Release tag verification

The organization-level [release tag guide](https://github.com/kaizen-agents-org/.github/blob/main/docs/release-tags.md)
defines compatible component sets. Do not redefine compatibility here:
`.github/onboarding/versions.json` is the source of truth for the set installed
by the onboarding kit.

Run the complete repository checks before creating a release tag:

```sh
set -euo pipefail
test -z "$(git status --porcelain)"
npm run audit:production
npm test
npm run typecheck
npm run check:dist
npm run build
```

`dist/` is committed and is the CLI shipped by the tag, so `check:dist` is a
release gate rather than optional generated-file cleanup. The clean-tree check
must run before it: locally, `check:dist` preserves and compares against existing
working-tree output rather than replacing it with `HEAD`. Releases that change
the runtime launcher, scheduler integration, or publication broker must also
reinstall or resync those operator-managed assets from the candidate build and
exercise a scheduled run; an old launcher can otherwise mask the tagged CLI.

Then install the packed candidate in a temporary prefix and exercise a real,
read-only GitHub operation. The selected project must already be registered, and
`PATH` must contain a trusted `gh` executable accepted by `kaizen doctor`.

```sh
set -euo pipefail
: "${KAIZEN_PROJECT_SLUG:?Set KAIZEN_PROJECT_SLUG to a registered project slug}"
project_slug="$KAIZEN_PROJECT_SLUG"
release_dir="$(mktemp -d)"
npm pack --pack-destination "$release_dir"
npm install --prefix "$release_dir/install" "$release_dir"/kaizen-loop-*.tgz
doctor_output="$("$release_dir/install/node_modules/.bin/kaizen" doctor --project "$project_slug" --json)"
printf '%s\n' "$doctor_output"
node -e 'const report = JSON.parse(process.argv[1]); const check = report.checks.find(({ name }) => name === "gh auth"); if (check?.ok !== true) process.exit(1)' "$doctor_output"
```

Do not tag the commit unless the packed CLI reaches `gh auth status` and reports
the GitHub authentication check as successful. This check must use the packed
artifact rather than `src/cli.ts`, so stale or incorrectly wired `dist/` output is
covered.

For releases that change the issue-to-PR pipeline, also run `kaizen smoke` against
the designated sandbox project and verify that it creates and validates a
ready-for-review pull request.

After creating the tag, update `kaizen-agents-org/.github`'s
`onboarding/versions.json` to the new `kaizen-loop` tag and verify the complete
pinned set through `onboarding/onboard.sh`. Run the smoke with the installed
`kaizen` command, not this source checkout: this catches distribution skew where
the installer records a pinned Verifier version but the pinned Kaizen CLI is too
old to carry it into `verifier.expectedRef`.
