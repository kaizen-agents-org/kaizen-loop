# macOS publication broker

Scheduled HTTPS publication uses a root LaunchDaemon so a GitHub token never enters
the environment of the Kaizen supervisor, builder, verifier, or another process running
as the scheduler user. Authenticated GitHub CLI operations are sent over the registered
broker connection. The broker runs one fixed, root-owned `gh` executable from `/var/empty`,
with a fixed empty configuration directory and the root-only token. It returns bounded
stdout, stderr, and exit status; neither the token nor an authenticated `gh` environment
crosses into the runtime user process.
The installed scheduler launcher asks the
daemon to start one configured Kaizen supervisor. The daemon records the launcher's PID
and one-run capability, waits for its readiness handshake, and then binds the post-`exec`
Node process's macOS audit token on the first preflight. Publication requests must come
from that exact process identity
and carry the same capability. A child, sibling, stale PID, or reused PID does not
match the registered audit identity. Supervisor-start requests additionally require
the configured immutable launcher executable to be a direct child of macOS launchd;
another process running under the scheduler UID cannot invoke the broker entry point.
Kaizen creates and revalidates each registered workspace, worktree parent, run
directory, and issue worktree with mode `0700` before untrusted work starts.
`kaizen doctor` reports an exposed workspace; `kaizen doctor --repair` tightens an
existing workspace only after confirming that it is a real directory owned by the
runtime user. On macOS, validation also rejects extended ACLs; repair refuses to mutate
ACL-bearing directories by pathname, so an operator must remove the ACL before retrying.
Any non-dry run, scheduled or manual, rebuilds a formerly exposed workspace from
the trusted developer checkout's origin before reading its contents. A dry run never
repairs or rebuilds a workspace; a scheduled dry run validates privacy and refuses
exposed or previously marked-untrusted contents.
Doctor tightens the directory but persists an untrusted-contents marker outside the
workspace, so later Doctor invocations still refuse its config and Builder smoke test.
A successful non-dry rebuild clears that marker.

> **Upgrade note:** Workspaces created by versions before private workspace enforcement
> are normally mode `0755`. The first non-dry run after upgrading rebuilds each such
> workspace once. Untracked files and unpushed local branches in the managed workspace
> are discarded; checkpoints already pushed to `origin` remain resumable.

## Install

Build the checkout, create a token file without placing the token in shell history,
then run the reviewed installer. The token file and its ancestors must be root-owned;
the file must be a non-symlink regular file with mode `0600`.

```sh
npm ci
npm run build
# Prerequisite: install or link Verifier before the broker. It must resolve for
# the runtime user on this exact --tool-path and return structured provenance.
sudo -u "$USER" /usr/bin/env -i HOME="$HOME" \
  PATH="/usr/local/libexec/kaizen-gh:/usr/local/bin:/usr/bin:/bin" \
  verifier --version --json
sudo install -d -o root -g wheel -m 0755 /Library/Application\ Support/KaizenLoop
sudo sh -c 'umask 077; /bin/cat > /Library/Application\ Support/KaizenLoop/github-token'
sudo scripts/install-macos-publication-broker.sh \
  --runtime-user "$USER" \
  --token-file /Library/Application\ Support/KaizenLoop/github-token \
  --repository kaizen-agents-org/kaizen-loop \
  --scheduled-job kaizen-agents-org-kaizen-loop/maintenance@02:00 \
  --tool-path "/usr/local/libexec/kaizen-gh:/usr/local/bin:/usr/bin:/bin" \
  --github-cli /usr/local/libexec/kaizen-gh/gh \
  --node "$(command -v node)"
```

The installer compiles and installs three root-owned executables, an immutable copy of
the built Kaizen runtime, a root-owned mode-`0644` broker configuration containing no
token value, and
`/Library/LaunchDaemons/org.kaizen-agents.publication-broker.plist`. It refuses an
unmarked existing installation and validates the Node, npm, GitHub CLI, and root-only
token ownership chains. `--github-cli` must identify an immutable, root-owned executable;
the runtime user's interactive `gh` installation or keychain session is not used.
Before installing the broker, the installer creates or repairs the root-owned
`/var/db/kaizen-loop` parent with mode `0711`. This permits the runtime user to
traverse the path to the broker's runtime-owned `publication` directory while
keeping the parent contents private; a symlink or non-directory at that path is
rejected. The broker continues to own `/var/db/kaizen-loop/publication` for the
runtime group with mode `0710`.
Before replacing an existing broker, the installer also resolves `verifier` with the
exact registered `--tool-path` and runs `verifier --version --json` as the runtime user
with the configured Kaizen home. A missing command, broken shebang interpreter, or
unstructured provenance fails before the runtime or LaunchDaemons are changed; the
diagnostic names the effective PATH, resolved executable, and shebang.
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
and a one-run, non-credential capability. Authenticated GitHub CLI reads are executed by
the broker from `/var/empty` for the repository bound to that registered project. The
runtime process and its untrusted children receive neither the credential nor a
credential-bearing process environment.

The installer uses `<runtime-user home>/.kaizen` by default. When the registered
projects live in another state directory, pass `--kaizen-home /absolute/path`.
Every `--scheduled-job` project must already exist in that home's `registry.json`; the
installer fails before replacing the runtime or launchd configuration when it does not.
Both root launchd daemons write stdout and stderr to `/var/log/kaizen-loop/` so
scheduled-dispatch and broker startup failures remain diagnosable with `tail` or
the Console app.

## Operator canary

Run one registered job immediately after installation or a toolchain repair with the
root-owned launcher:

```sh
sudo /usr/local/libexec/kaizen-loop/bin/kaizen-scheduled-launcher \
  canary kaizen-agents-org-kaizen-loop maintenance
```

This is a real, non-dry scheduled run and may create or update a branch and pull request.
The caller must be root, the launcher path must match the immutable path in the root-owned
broker configuration, and the project/job pair must already be registered. The broker
continues to bind the spawned supervisor to a one-run capability and the registered
repository. `dispatch` remains reserved for launchd and still refuses off-calendar runs.
Use the resulting project `last-run.json` and run summary as the canary evidence; require
`infrastructureFailed: 0` and the expected processed/PR counts before enabling the rest of
the fleet.

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

For GitHub metadata and pull-request operations, the broker authenticates the same exact
registered supervisor, runs only the configured root-owned `gh` executable from
`/var/empty`, bounds request and output sizes, and returns its output and exit status.

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
preflight, its same-UID Node child cannot invoke authenticated GitHub CLI work, the
runtime environment has no token, brokered `gh` receives the credential only under the
root identity, publication reaches the configured remote, and launcher disconnect
terminates the supervisor process group. The regular
cross-platform suite may skip these native cases, but the dedicated
`native-publication-broker` macOS CI job sets `KAIZEN_REQUIRE_NATIVE_BROKER_TESTS=1`,
so a missing or broken Swift/Foundation toolchain fails that job instead of silently
reducing credential-boundary coverage.
