# macOS publication broker

Scheduled HTTPS publication uses a root LaunchDaemon so a GitHub token never enters
the Kaizen supervisor, builder, verifier, or another process running as the scheduler
user. The installed scheduler launcher asks the daemon to start one configured Kaizen
supervisor. The daemon records that process's PID and macOS audit token before the
launcher drops privileges and `exec`s Node. Publication and preflight requests must
come from that exact process identity and carry its one-run capability. A child,
sibling, stale PID, or reused PID does not match the registered audit identity.

## Install

Build the checkout, create a token file without placing the token in shell history,
then run the reviewed installer. The token file and its ancestors must be root-owned;
the file must be a non-symlink regular file with mode `0600`.

```sh
npm ci
npm run build
sudo install -d -o root -g wheel -m 0700 /Library/Application\ Support/KaizenLoop
sudo sh -c 'umask 077; /bin/cat > /Library/Application\ Support/KaizenLoop/github-token'
sudo scripts/install-macos-publication-broker.sh \
  --runtime-user "$USER" \
  --token-file /Library/Application\ Support/KaizenLoop/github-token \
  --repository kaizen-agents-org/kaizen-loop \
  --node "$(command -v node)"
```

The installer compiles and installs three root-owned executables, an immutable copy of
the built Kaizen runtime, a mode-`0600` broker configuration, and
`/Library/LaunchDaemons/org.kaizen-agents.publication-broker.plist`. It refuses an
unmarked existing installation and validates the Node, npm, and token ownership chain.
Add one `--repository owner/name` for every repository the broker may publish; the
daemon maps these names to canonical `https://github.com/owner/name.git` URLs and never
treats a client URL as authority.

Configure scheduler jobs to invoke the installed launcher, then resync them:

```sh
export KAIZEN_CRON_SCHEDULED_LAUNCHER=/usr/local/libexec/kaizen-loop/bin/kaizen-scheduled-launcher
kaizen scheduler sync
```

The user LaunchAgent or cron environment clears any inherited broker socket. The root
daemon starts the fixed root-owned runtime with a small environment and injects the
publication socket and a one-run, non-credential capability only after that clear
boundary. Kaizen captures and removes the capability at startup; its normal untrusted
child environment allowlist contains neither value.

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

The broker monitors the client during import and push and terminates the subprocess
group when the client disconnects. GitHub ref updates are not transactional with the
local socket: a disconnect after the remote accepted an update is an ambiguous result.
Kaizen therefore reports failure and does not automatically retry an unacknowledged
publication.

## Verification

`test/macos-publication-broker.test.ts` compiles and exercises the native broker on a
healthy macOS Swift toolchain. It proves that the broker-spawned supervisor passes
preflight, its same-UID Node child is rejected, and launcher disconnect terminates the
supervisor process group. Native tests are skipped when Foundation cannot compile
(including mismatched Command Line Tools/SDK installations); source-contract and
TypeScript preflight tests still run on every platform.
