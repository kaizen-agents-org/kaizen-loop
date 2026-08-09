# Release tag verification

Run the complete repository checks before creating a release tag:

```sh
set -euo pipefail
npm test
npm run typecheck
npm run build
npm run check:dist
```

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
