# macOS publication broker

Scheduled HTTPS publication uses a root LaunchDaemon so a GitHub token never enters
the Kaizen supervisor, builder, verifier, or another process running as the scheduler
user. The installed scheduler launcher asks the daemon to start one configured Kaizen
supervisor. The daemon records the launcher's PID and one-run capability, waits for its
readiness handshake, and then binds the post-`exec` Node process's macOS audit token on
the first preflight. Publication requests must come from that exact process identity
and carry the same capability. A child, sibling, stale PID, or reused PID does not
match the registered audit identity. Supervisor-start requests additionally require
the configured immutable launcher executable to be a direct child of macOS launchd;
another process running under the scheduler UID cannot invoke the broker entry point.

## Install

Build the checkout, create a token file without placing the token in shell history,
then run the reviewed installer. The token file and its ancestors must be root-owned;
the file must be a non-symlink regular file with mode `0600`.

```sh
npm ci
npm run build
sudo install -d -o root -g wheel -m 0755 /Library/Application\ Support/KaizenLoop
sudo sh -c 'umask 077; /bin/cat > /Library/Application\ Support/KaizenLoop/github-token'
sudo scripts/install-macos-publication-broker.sh \
  --runtime-user "$USER" \
  --token-file /Library/Application\ Support/KaizenLoop/github-token \
  --repository kaizen-agents-org/kaizen-loop \
  --scheduled-job kaizen-agents-org-kaizen-loop/maintenance@02:00 \
  --tool-path "/usr/local/libexec/kaizen-gh:/usr/local/bin:/usr/bin:/bin" \
  --node "$(command -v node)"
```

The installer compiles and installs three root-owned executables, an immutable copy of
the built Kaizen runtime, a root-owned mode-`0644` broker configuration containing no
token value, and
`/Library/LaunchDaemons/org.kaizen-agents.publication-broker.plist`. It refuses an
unmarked existing installation and validates the Node, npm, and root-only token ownership chain.
Add one `--repository owner/name` for every repository the broker may publish; the
daemon maps these names to canonical `https://github.com/owner/name.git` URLs and never
treats a client URL as authority. Add each authorized scheduler project/job pair with
`--scheduled-job project/job@HH:MM` and record its fixed executable search path with `--tool-path`.
The root-owned registration prevents another LaunchAgent under the runtime UID from
choosing a different job or toolchain.

The installer creates `org.kaizen-agents.scheduled-publication` as a system
LaunchDaemon with the registered calendar times. Do not install duplicate user
LaunchAgents for these jobs. The root dispatcher starts the fixed root-owned runtime
with the registered `PATH` and publication timeout, then injects the publication socket
and a one-run, non-credential capability. Kaizen captures and removes the capability at
startup; its normal untrusted child environment allowlist contains neither value.

## Broker validation

Before authenticated push, the broker:

1. authenticates the exact registered supervisor with kernel peer credentials and the
   macOS audit token;
2. resolves the expected repository through the root-owned allowlist and accepts only
   the matching canonical GitHub HTTPS URL and branch refspec;
3. imports the bare repository as the unprivileged runtime user into a fresh private
   directory with `git clone --bare --no-local`;
4. rejects symlinks and hard-linked regular files, takes root ownership, removes hooks
   and alternates, replaces repository config, runs `git fsck --full`, and revalidates
   the expected commit SHA;
5. runs root Git with system/global config, redirects, and hooks disabled, using a
   credential helper that reads the token from the root-only file; and
6. replies with only `{"ok":true}` or `{"ok":false}`.

Publication rejects a ref that contains Git LFS pointer files, including a ref whose
candidate count exceeds the inspection bound. The separate trusted credential path
cannot run repository pre-push hooks or upload LFS objects; rejection remains the
boolean `{"ok":false}` response.

Publication uses a 30-minute absolute deadline by default. Set
`KAIZEN_GITHUB_PUBLICATION_TIMEOUT_MS` at supervisor startup to a value between
10000 and 3600000 milliseconds.

The broker monitors the client during import and push and terminates the subprocess
group when the client disconnects. GitHub ref updates are not transactional with the
local socket: a disconnect after the remote accepted an update is an ambiguous result.
Kaizen therefore reports failure and does not automatically retry an unacknowledged
publication.

## Recovery and uninstall

If installation is interrupted during the runtime swap, inspect
`/usr/local/libexec/kaizen-loop.backup.*`, choose the backup created by that attempt,
move it back to `/usr/local/libexec/kaizen-loop` when the install root is absent, and
re-bootstrap the daemon:

```sh
sudo launchctl bootstrap system /Library/LaunchDaemons/org.kaizen-agents.publication-broker.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/org.kaizen-agents.scheduled-publication.plist
```

To uninstall, first stop the daemon, then remove only the broker-owned paths:

```sh
sudo launchctl bootout system/org.kaizen-agents.publication-broker
sudo launchctl bootout system/org.kaizen-agents.scheduled-publication
sudo rm /Library/LaunchDaemons/org.kaizen-agents.publication-broker.plist
sudo rm /Library/LaunchDaemons/org.kaizen-agents.scheduled-publication.plist
sudo rm /Library/Application\ Support/KaizenLoop/publication-broker.plist
sudo rm -R /usr/local/libexec/kaizen-loop
sudo rm -R /var/db/kaizen-loop/publication
```

## Verification

`test/macos-publication-broker.test.ts` compiles and exercises the native broker on a
healthy macOS Swift toolchain. It proves that the broker-spawned supervisor passes
preflight, its same-UID Node child is rejected, and launcher disconnect terminates the
supervisor process group. Native tests are skipped when Foundation cannot compile
(including mismatched Command Line Tools/SDK installations); source-contract and
TypeScript preflight tests still run on every platform.
