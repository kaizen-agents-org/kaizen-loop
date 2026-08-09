#!/bin/sh
set -eu

usage() {
  echo "usage: sudo install-macos-publication-broker.sh --runtime-user <user> --token-file <root-only-file> --repository <owner/repo> --scheduled-job <project/job@HH:MM> --tool-path <absolute-path-list> [--publication-timeout-ms <10000-3600000>] [--repository <owner/repo> ...] [--scheduled-job <project/job@HH:MM> ...] [--node <absolute-node>] [--source <kaizen-loop-checkout>]" >&2
  exit 2
}

[ "$(uname -s)" = Darwin ] || { echo "The publication broker installer supports macOS only." >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run the publication broker installer as root." >&2; exit 2; }

runtime_user=
token_file=
node_executable=
source_root=
repositories=
scheduled_jobs=
tool_path=
publication_timeout_ms=1800000
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-user) [ "$#" -ge 2 ] || usage; runtime_user=$2; shift 2 ;;
    --token-file) [ "$#" -ge 2 ] || usage; token_file=$2; shift 2 ;;
    --repository) [ "$#" -ge 2 ] || usage; repositories="${repositories}${repositories:+
}$2"; shift 2 ;;
    --scheduled-job) [ "$#" -ge 2 ] || usage; scheduled_jobs="${scheduled_jobs}${scheduled_jobs:+
}$2"; shift 2 ;;
    --tool-path) [ "$#" -ge 2 ] || usage; tool_path=$2; shift 2 ;;
    --publication-timeout-ms) [ "$#" -ge 2 ] || usage; publication_timeout_ms=$2; shift 2 ;;
    --node) [ "$#" -ge 2 ] || usage; node_executable=$2; shift 2 ;;
    --source) [ "$#" -ge 2 ] || usage; source_root=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$runtime_user" ] && [ -n "$token_file" ] && [ -n "$repositories" ] && [ -n "$scheduled_jobs" ] && [ -n "$tool_path" ] || usage

case "$token_file" in /*) ;; *) echo "--token-file must be absolute." >&2; exit 2 ;; esac
case "$runtime_user" in *[!A-Za-z0-9._-]*|'') echo "Invalid runtime user." >&2; exit 2 ;; esac
case "$publication_timeout_ms" in *[!0-9]*|'') usage ;; esac
[ "$publication_timeout_ms" -ge 10000 ] && [ "$publication_timeout_ms" -le 3600000 ] || usage
runtime_uid=$(id -u "$runtime_user")
runtime_gid=$(id -g "$runtime_user")
runtime_home=$(dscl . -read "/Users/$runtime_user" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')
[ -n "$runtime_home" ] || { echo "Could not resolve the runtime user's home." >&2; exit 1; }

if [ -z "$source_root" ]; then
  source_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
else
  source_root=$(CDPATH= cd -- "$source_root" && pwd -P)
fi
[ -f "$source_root/dist/cli.js" ] && [ -f "$source_root/package-lock.json" ] || {
  echo "Build kaizen-loop before installing the broker (npm run build)." >&2
  exit 1
}

if [ -z "$node_executable" ]; then node_executable=$(command -v node || true); fi
case "$node_executable" in /*) ;; *) echo "--node must resolve to an absolute executable." >&2; exit 2 ;; esac
node_executable=$(realpath "$node_executable")
[ -x "$node_executable" ] || { echo "The configured Node executable is not executable." >&2; exit 1; }
npm_executable=$(command -v npm || true)
case "$npm_executable" in /*) ;; *) echo "A trusted absolute npm executable is required." >&2; exit 1 ;; esac
npm_executable=$(realpath "$npm_executable")

trusted_root_path() {
  candidate=$1
  while :; do
    [ "$(stat -f %Su "$candidate")" = root ] || return 1
    mode=$(stat -f %Lp "$candidate")
    [ $((0$mode & 022)) -eq 0 ] || return 1
    [ "$candidate" = / ] && return 0
    candidate=$(dirname "$candidate")
  done
}
trusted_root_path "$node_executable" || {
  echo "Node and every ancestor must be root-owned and group/other non-writable." >&2
  exit 1
}
trusted_root_path "$npm_executable" || {
  echo "npm and every ancestor must be root-owned and group/other non-writable." >&2
  exit 1
}
[ -f "$token_file" ] && [ ! -L "$token_file" ] && trusted_root_path "$token_file" || {
  echo "The token file must be a root-owned, non-symlink file in root-owned non-writable directories." >&2
  exit 1
}
[ "$(stat -f %Lp "$token_file")" -eq 600 ] || { echo "The token file mode must be 0600." >&2; exit 1; }
[ -s "$token_file" ] || { echo "The token file is empty." >&2; exit 1; }

old_ifs=$IFS
IFS='
'
for repository in $repositories; do
  echo "$repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || { echo "Invalid repository: $repository" >&2; exit 2; }
done
IFS=$old_ifs
printf '%s\n' "$tool_path" | awk -F: '
  length($0) > 16384 || NF > 128 { exit 1 }
  { for (i = 1; i <= NF; i++) if ($i !~ /^\// || length($i) > 4096) exit 1 }
' || { echo "--tool-path must contain only bounded absolute directories." >&2; exit 2; }
IFS='
'
for scheduled_job in $scheduled_jobs; do
  echo "$scheduled_job" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}@([01][0-9]|2[0-3]):[0-5][0-9]$' || {
    echo "Invalid scheduled job: $scheduled_job" >&2
    exit 2
  }
done
IFS=$old_ifs

install_root=/usr/local/libexec/kaizen-loop
config_dir='/Library/Application Support/KaizenLoop'
config_path="$config_dir/publication-broker.plist"
daemon_path=/Library/LaunchDaemons/org.kaizen-agents.publication-broker.plist
schedule_daemon_path=/Library/LaunchDaemons/org.kaizen-agents.scheduled-publication.plist
install -d -o root -g wheel -m 0755 /usr/local/libexec
trusted_root_path /usr/local/libexec || { echo "/usr/local/libexec must be root-owned and group/other non-writable." >&2; exit 1; }
if [ -d "$config_dir" ]; then
  trusted_root_path "$config_dir" || { echo "$config_dir must be root-owned and group/other non-writable." >&2; exit 1; }
  chown root:wheel "$config_dir"
  chmod 0755 "$config_dir"
else
  install -d -o root -g wheel -m 0755 "$config_dir"
fi
marker="$install_root/.kaizen-publication-broker-install"
if [ -e "$install_root" ] && [ ! -f "$marker" ]; then
  echo "Refusing to replace an installation without the Kaizen publication broker marker." >&2
  exit 1
fi

build_dir=$(mktemp -d /private/tmp/kaizen-broker-build.XXXXXX)
stage="$install_root.new.$$"
backup="$install_root.backup.$$"
cleanup() {
  if [ -d "$backup" ] && [ ! -e "$install_root" ]; then mv "$backup" "$install_root"; fi
  rm -rf "$build_dir"
  if [ -d "$stage" ]; then rm -rf "$stage"; fi
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$stage/runtime" "$stage/bin"

swiftc -module-cache-path "$build_dir/module-cache-broker" "$source_root/scripts/macos/kaizen-publication-broker.swift" -o "$stage/bin/kaizen-publication-broker"
swiftc -module-cache-path "$build_dir/module-cache-scheduled" "$source_root/scripts/macos/kaizen-scheduled-launcher.swift" -o "$stage/bin/kaizen-scheduled-launcher"
swiftc -module-cache-path "$build_dir/module-cache-supervisor" "$source_root/scripts/macos/kaizen-supervisor-launcher.swift" -o "$stage/bin/kaizen-supervisor-launcher"
ditto "$source_root/dist" "$stage/runtime/dist"
install -m 0644 "$source_root/package.json" "$source_root/package-lock.json" "$stage/runtime/"
(cd "$stage/runtime" && "$node_executable" "$npm_executable" ci --omit=dev --ignore-scripts)
touch "$stage/.kaizen-publication-broker-install"
chown -R root:wheel "$stage"
chmod -R go-w "$stage"
chmod 0755 "$stage/bin/"* "$stage/runtime/dist/cli.js"

config_stage="$build_dir/publication-broker.plist"
/usr/libexec/PlistBuddy -c 'Clear dict' "$config_stage"
/usr/bin/plutil -insert runtimeUser -string "$runtime_user" "$config_stage"
/usr/libexec/PlistBuddy -c "Add :runtimeUid integer $runtime_uid" "$config_stage"
/usr/libexec/PlistBuddy -c "Add :runtimeGid integer $runtime_gid" "$config_stage"
/usr/bin/plutil -insert runtimeHome -string "$runtime_home" "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :schedulerSocketPath string /opt/kaizen/run/scheduler.sock' "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :publicationSocketPath string /opt/kaizen/run/publication.sock' "$config_stage"
/usr/libexec/PlistBuddy -c "Add :scheduledLauncherExecutable string $install_root/bin/kaizen-scheduled-launcher" "$config_stage"
/usr/libexec/PlistBuddy -c "Add :supervisorLauncherExecutable string $install_root/bin/kaizen-supervisor-launcher" "$config_stage"
/usr/bin/plutil -insert nodeExecutable -string "$node_executable" "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :gitExecutable string /usr/bin/git' "$config_stage"
/usr/libexec/PlistBuddy -c "Add :cliPath string $install_root/runtime/dist/cli.js" "$config_stage"
/usr/bin/plutil -insert tokenFile -string "$token_file" "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :privateDirectory string /var/db/kaizen-loop/publication' "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :allowedRepositories dict' "$config_stage"
IFS='
'
for repository in $repositories; do
  /usr/libexec/PlistBuddy -c "Add :allowedRepositories:$repository string https://github.com/$repository.git" "$config_stage"
done
IFS=$old_ifs
/usr/bin/plutil -insert scheduledJobs -json '[]' "$config_stage"
scheduled_index=0
IFS='
'
for scheduled_job in $scheduled_jobs; do
  scheduled_identity=${scheduled_job%@*}
  scheduled_time=${scheduled_job##*@}
  scheduled_project=${scheduled_identity%/*}
  scheduled_name=${scheduled_identity#*/}
  scheduled_hour=${scheduled_time%:*}
  scheduled_minute=${scheduled_time#*:}
  /usr/bin/plutil -insert "scheduledJobs.$scheduled_index" -json '{}' "$config_stage"
  /usr/bin/plutil -insert "scheduledJobs.$scheduled_index.project" -string "$scheduled_project" "$config_stage"
  /usr/bin/plutil -insert "scheduledJobs.$scheduled_index.job" -string "$scheduled_name" "$config_stage"
  /usr/bin/plutil -insert "scheduledJobs.$scheduled_index.toolPath" -string "$tool_path" "$config_stage"
  /usr/bin/plutil -insert "scheduledJobs.$scheduled_index.hour" -integer "$scheduled_hour" "$config_stage"
  /usr/bin/plutil -insert "scheduledJobs.$scheduled_index.minute" -integer "$scheduled_minute" "$config_stage"
  /usr/bin/plutil -insert "scheduledJobs.$scheduled_index.publicationTimeoutMs" -integer "$publication_timeout_ms" "$config_stage"
  scheduled_index=$((scheduled_index + 1))
done
IFS=$old_ifs
chown root:wheel "$config_stage"
chmod 0644 "$config_stage"

daemon_stage="$build_dir/publication-broker-daemon.plist"
/usr/libexec/PlistBuddy -c 'Clear dict' "$daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :Label string org.kaizen-agents.publication-broker' "$daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments array' "$daemon_stage"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $install_root/bin/kaizen-publication-broker" "$daemon_stage"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $config_path" "$daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :RunAtLoad bool true' "$daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :KeepAlive bool true' "$daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :ProcessType string Background' "$daemon_stage"
chown root:wheel "$daemon_stage"
chmod 0644 "$daemon_stage"

schedule_daemon_stage="$build_dir/scheduled-publication-daemon.plist"
schedule_times="$build_dir/schedule-times"
: > "$schedule_times"
IFS='
'
for scheduled_job in $scheduled_jobs; do
  scheduled_time=${scheduled_job##*@}
  if ! grep -Fqx "$scheduled_time" "$schedule_times"; then printf '%s\n' "$scheduled_time" >> "$schedule_times"; fi
done
IFS=$old_ifs
/usr/libexec/PlistBuddy -c 'Clear dict' "$schedule_daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :Label string org.kaizen-agents.scheduled-publication' "$schedule_daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments array' "$schedule_daemon_stage"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $install_root/bin/kaizen-scheduled-launcher" "$schedule_daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments:1 string dispatch' "$schedule_daemon_stage"
/usr/libexec/PlistBuddy -c 'Add :StartCalendarInterval array' "$schedule_daemon_stage"
schedule_index=0
while IFS=: read -r scheduled_hour scheduled_minute; do
  /usr/libexec/PlistBuddy -c "Add :StartCalendarInterval:$schedule_index dict" "$schedule_daemon_stage"
  /usr/libexec/PlistBuddy -c "Add :StartCalendarInterval:$schedule_index:Hour integer $scheduled_hour" "$schedule_daemon_stage"
  /usr/libexec/PlistBuddy -c "Add :StartCalendarInterval:$schedule_index:Minute integer $scheduled_minute" "$schedule_daemon_stage"
  schedule_index=$((schedule_index + 1))
done < "$schedule_times"
/usr/libexec/PlistBuddy -c 'Add :ProcessType string Background' "$schedule_daemon_stage"
chown root:wheel "$schedule_daemon_stage"
chmod 0644 "$schedule_daemon_stage"

had_config=false
had_daemon=false
had_schedule_daemon=false
if [ -f "$config_path" ]; then cp -p "$config_path" "$build_dir/config.backup"; had_config=true; fi
if [ -f "$daemon_path" ]; then cp -p "$daemon_path" "$build_dir/daemon.backup"; had_daemon=true; fi
if [ -f "$schedule_daemon_path" ]; then cp -p "$schedule_daemon_path" "$build_dir/schedule-daemon.backup"; had_schedule_daemon=true; fi
launchctl bootout system/org.kaizen-agents.publication-broker 2>/dev/null || true
launchctl bootout system/org.kaizen-agents.scheduled-publication 2>/dev/null || true
if [ -d "$install_root" ]; then mv "$install_root" "$backup"; fi
mv "$stage" "$install_root"
install -o root -g wheel -m 0644 "$config_stage" "$config_path"
install -o root -g wheel -m 0644 "$daemon_stage" "$daemon_path"
install -o root -g wheel -m 0644 "$schedule_daemon_stage" "$schedule_daemon_path"
if ! launchctl bootstrap system "$daemon_path" || ! launchctl bootstrap system "$schedule_daemon_path"; then
  launchctl bootout system/org.kaizen-agents.scheduled-publication 2>/dev/null || true
  launchctl bootout system/org.kaizen-agents.publication-broker 2>/dev/null || true
  rm -rf "$install_root"
  if [ -d "$backup" ]; then mv "$backup" "$install_root"; fi
  if [ "$had_config" = true ]; then cp -p "$build_dir/config.backup" "$config_path"; else rm -f "$config_path"; fi
  if [ "$had_daemon" = true ]; then
    cp -p "$build_dir/daemon.backup" "$daemon_path"
    launchctl bootstrap system "$daemon_path" 2>/dev/null || true
  else
    rm -f "$daemon_path"
  fi
  if [ "$had_schedule_daemon" = true ]; then
    cp -p "$build_dir/schedule-daemon.backup" "$schedule_daemon_path"
    launchctl bootstrap system "$schedule_daemon_path" 2>/dev/null || true
  else
    rm -f "$schedule_daemon_path"
  fi
  echo "LaunchDaemon bootstrap failed; the prior runtime and configuration were restored." >&2
  exit 1
fi
if [ -d "$backup" ]; then rm -rf "$backup"; fi
trap - EXIT HUP INT TERM
rm -rf "$build_dir"
echo "Installed the Kaizen publication broker and root-owned scheduled dispatcher. Do not install a duplicate user LaunchAgent for these jobs."
