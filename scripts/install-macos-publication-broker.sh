#!/bin/sh
set -eu

usage() {
  echo "usage: sudo install-macos-publication-broker.sh --runtime-user <user> (--token-file <root-only-file> | --github-app-id <id> --github-app-installation-id <id> --github-app-private-key-file <root-only-pem> | --github-app-installation <owner>:<app-id>:<installation-id>:<root-only-pem> [...]) --repository <owner/repo> --scheduled-job <project/job@HH:MM> --tool-path <absolute-path-list> [--replace-all] [--kaizen-home <absolute-kaizen-home>] [--publication-timeout-ms <10000-3600000>] [--repository <owner/repo> ...] [--scheduled-job <project/job@HH:MM> ...] [--node <absolute-node>] [--npm <absolute-npm>] [--github-cli <absolute-gh>] [--source <kaizen-loop-checkout>]" >&2
  exit 2
}

[ "$(uname -s)" = Darwin ] || { echo "The publication broker installer supports macOS only." >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run the publication broker installer as root." >&2; exit 2; }

runtime_user=
token_file=
github_app_id=
github_app_installation_id=
github_app_private_key_file=
github_app_installations=
node_executable=
npm_executable=
github_cli_executable=
source_root=
kaizen_home=
repositories=
scheduled_jobs=
tool_path=
publication_timeout_ms=1800000
replace_all=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-user) [ "$#" -ge 2 ] || usage; runtime_user=$2; shift 2 ;;
    --token-file) [ "$#" -ge 2 ] || usage; token_file=$2; shift 2 ;;
    --github-app-id) [ "$#" -ge 2 ] || usage; github_app_id=$2; shift 2 ;;
    --github-app-installation-id) [ "$#" -ge 2 ] || usage; github_app_installation_id=$2; shift 2 ;;
    --github-app-private-key-file) [ "$#" -ge 2 ] || usage; github_app_private_key_file=$2; shift 2 ;;
    --github-app-installation) [ "$#" -ge 2 ] || usage; github_app_installations="${github_app_installations}${github_app_installations:+
}$2"; shift 2 ;;
    --repository) [ "$#" -ge 2 ] || usage; repositories="${repositories}${repositories:+
}$2"; shift 2 ;;
    --scheduled-job) [ "$#" -ge 2 ] || usage; scheduled_jobs="${scheduled_jobs}${scheduled_jobs:+
}$2"; shift 2 ;;
    --tool-path) [ "$#" -ge 2 ] || usage; tool_path=$2; shift 2 ;;
    --publication-timeout-ms) [ "$#" -ge 2 ] || usage; publication_timeout_ms=$2; shift 2 ;;
    --replace-all) replace_all=true; shift ;;
    --node) [ "$#" -ge 2 ] || usage; node_executable=$2; shift 2 ;;
    --npm) [ "$#" -ge 2 ] || usage; npm_executable=$2; shift 2 ;;
    --github-cli) [ "$#" -ge 2 ] || usage; github_cli_executable=$2; shift 2 ;;
    --kaizen-home) [ "$#" -ge 2 ] || usage; kaizen_home=$2; shift 2 ;;
    --source) [ "$#" -ge 2 ] || usage; source_root=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$runtime_user" ] && [ -n "$repositories" ] && [ -n "$scheduled_jobs" ] && [ -n "$tool_path" ] || usage

if [ -n "$token_file" ]; then
  [ -z "$github_app_id" ] && [ -z "$github_app_installation_id" ] && [ -z "$github_app_private_key_file" ] && [ -z "$github_app_installations" ] || usage
  case "$token_file" in /*) ;; *) echo "--token-file must be absolute." >&2; exit 2 ;; esac
elif [ -n "$github_app_installations" ]; then
  [ -z "$github_app_id" ] && [ -z "$github_app_installation_id" ] && [ -z "$github_app_private_key_file" ] || usage
else
  [ -n "$github_app_id" ] && [ -n "$github_app_installation_id" ] && [ -n "$github_app_private_key_file" ] || usage
  echo "$github_app_id" | grep -Eq '^[1-9][0-9]{0,17}$' || usage
  echo "$github_app_installation_id" | grep -Eq '^[1-9][0-9]{0,17}$' || usage
  case "$github_app_private_key_file" in /*) ;; *) echo "--github-app-private-key-file must be absolute." >&2; exit 2 ;; esac
fi
case "$runtime_user" in *[!A-Za-z0-9._-]*|'') echo "Invalid runtime user." >&2; exit 2 ;; esac
case "$publication_timeout_ms" in *[!0-9]*|'') usage ;; esac
[ "$publication_timeout_ms" -ge 10000 ] && [ "$publication_timeout_ms" -le 3600000 ] || usage
runtime_uid=$(id -u "$runtime_user")
runtime_gid=$(id -g "$runtime_user")
runtime_home=$(dscl . -read "/Users/$runtime_user" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')
[ -n "$runtime_home" ] || { echo "Could not resolve the runtime user's home." >&2; exit 1; }
if [ -z "$kaizen_home" ]; then kaizen_home="$runtime_home/.kaizen"; fi
case "$kaizen_home" in /*) ;; *) echo "--kaizen-home must be absolute." >&2; exit 2 ;; esac

if [ -z "$source_root" ]; then
  source_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
else
  source_root=$(CDPATH= cd -- "$source_root" && pwd -P)
fi
[ -f "$source_root/dist/cli.js" ] && [ -f "$source_root/package-lock.json" ] &&
  [ -f "$source_root/scripts/macos/wait-for-unix-socket.mjs" ] || {
  echo "Build kaizen-loop before installing the broker (npm run build)." >&2
  exit 1
}

if [ -z "$node_executable" ]; then node_executable=$(command -v node || true); fi
case "$node_executable" in /*) ;; *) echo "--node must resolve to an absolute executable." >&2; exit 2 ;; esac
node_executable=$(realpath "$node_executable")
[ -x "$node_executable" ] || { echo "The configured Node executable is not executable." >&2; exit 1; }
if [ -z "$github_cli_executable" ]; then
  github_cli_executable=$(command -v gh || true)
  [ -n "$github_cli_executable" ] || { echo "GitHub CLI was not found on PATH; install gh or pass --github-cli." >&2; exit 1; }
fi
case "$github_cli_executable" in /*) ;; *) echo "--github-cli must name an absolute executable." >&2; exit 2 ;; esac
github_cli_executable=$(realpath "$github_cli_executable" 2>/dev/null) || {
  echo "The configured --github-cli path does not exist or cannot be resolved." >&2
  exit 1
}
[ -x "$github_cli_executable" ] || { echo "The configured GitHub CLI executable is not executable." >&2; exit 1; }
if [ -z "$npm_executable" ]; then
  node_sibling_npm=$(dirname "$node_executable")/npm
  if [ -x "$node_sibling_npm" ]; then
    npm_executable=$node_sibling_npm
  else
    npm_executable=$(command -v npm || true)
  fi
fi
case "$npm_executable" in /*) ;; *) echo "A trusted absolute npm executable is required." >&2; exit 1 ;; esac
npm_executable=$(realpath "$npm_executable" 2>/dev/null) || {
  echo "The configured --npm path does not exist or cannot be resolved." >&2
  exit 1
}
[ -x "$npm_executable" ] || { echo "The configured npm executable is not executable." >&2; exit 1; }

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
trusted_root_path "$github_cli_executable" || {
  echo "GitHub CLI and every ancestor must be root-owned and group/other non-writable." >&2
  exit 1
}
trusted_root_path "$npm_executable" || {
  echo "npm and every ancestor must be root-owned and group/other non-writable." >&2
  exit 1
}
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 022
validate_credential_file() {
  credential_file=$1
  credential_label=$2
  credential_max_size=$3
  [ -f "$credential_file" ] && [ ! -L "$credential_file" ] && trusted_root_path "$credential_file" || {
    echo "The $credential_label must be a root-owned, non-symlink file in root-owned non-writable directories." >&2
    exit 1
  }
  [ "$(stat -f %Lp "$credential_file")" -eq 600 ] || { echo "The $credential_label mode must be 0600." >&2; exit 1; }
  [ -s "$credential_file" ] || { echo "The $credential_label is empty." >&2; exit 1; }
  [ "$(stat -f %z "$credential_file")" -le "$credential_max_size" ] || { echo "The $credential_label is too large." >&2; exit 1; }
}
if [ -n "$token_file" ]; then
  validate_credential_file "$token_file" "token file" 1025
elif [ -n "$github_app_installations" ]; then
  seen_github_app_owners=
  old_ifs=$IFS
  IFS='
'
  for github_app_installation in $github_app_installations; do
    github_app_owner=${github_app_installation%%:*}
    github_app_remainder=${github_app_installation#*:}
    github_app_entry_id=${github_app_remainder%%:*}
    github_app_remainder=${github_app_remainder#*:}
    github_app_entry_installation_id=${github_app_remainder%%:*}
    github_app_entry_private_key_file=${github_app_remainder#*:}
    [ "$github_app_owner" != "$github_app_installation" ] &&
      [ "$github_app_entry_id" != "$github_app_remainder" ] &&
      [ "$github_app_entry_installation_id" != "$github_app_entry_private_key_file" ] || usage
    echo "$github_app_owner" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$' || usage
    echo "$github_app_entry_id" | grep -Eq '^[1-9][0-9]{0,17}$' || usage
    echo "$github_app_entry_installation_id" | grep -Eq '^[1-9][0-9]{0,17}$' || usage
    case "$github_app_entry_private_key_file" in /*) ;; *) echo "GitHub App private key paths must be absolute." >&2; exit 2 ;; esac
    printf '%s\n' "$seen_github_app_owners" | grep -Fqx "$github_app_owner" && { echo "Duplicate GitHub App owner: $github_app_owner" >&2; exit 2; }
    seen_github_app_owners="${seen_github_app_owners}${seen_github_app_owners:+
}${github_app_owner}"
    validate_credential_file "$github_app_entry_private_key_file" "GitHub App private key file for $github_app_owner" 65536
  done
  IFS=$old_ifs
else
  validate_credential_file "$github_app_private_key_file" "GitHub App private key file" 65536
fi

old_ifs=$IFS
IFS='
'
legacy_github_app_owner=
for repository in $repositories; do
  echo "$repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || { echo "Invalid repository: $repository" >&2; exit 2; }
  if [ -z "$token_file" ] && [ -z "$github_app_installations" ]; then
    repository_owner=${repository%%/*}
    [ -z "$legacy_github_app_owner" ] || [ "$legacy_github_app_owner" = "$repository_owner" ] || {
      echo "The legacy GitHub App flags support one repository owner; use --github-app-installation for each owner." >&2
      exit 2
    }
    legacy_github_app_owner=$repository_owner
  fi
done
IFS=$old_ifs

if [ -n "$github_app_installations" ]; then
  repository_owners=
  IFS='
'
  for repository in $repositories; do
    repository_owner=${repository%%/*}
    if ! printf '%s\n' "$repository_owners" | grep -Fqx "$repository_owner"; then
      repository_owners="${repository_owners}${repository_owners:+
}${repository_owner}"
    fi
  done
  for repository_owner in $repository_owners; do
    printf '%s\n' "$seen_github_app_owners" | grep -Fqx "$repository_owner" || {
      echo "Missing GitHub App installation for repository owner: $repository_owner" >&2
      exit 2
    }
  done
  for github_app_owner in $seen_github_app_owners; do
    printf '%s\n' "$repository_owners" | grep -Fqx "$github_app_owner" || {
      echo "GitHub App installation has no allowed repository owner: $github_app_owner" >&2
      exit 2
    }
  done
  IFS=$old_ifs
fi

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

registry_path="$kaizen_home/registry.json"
scheduled_projects=
IFS='
'
for scheduled_job in $scheduled_jobs; do
  scheduled_identity=${scheduled_job%@*}
  scheduled_projects="${scheduled_projects}${scheduled_projects:+
}${scheduled_identity%/*}"
done
IFS=$old_ifs
sudo -u "$runtime_user" -- "$node_executable" -e '
const fs = require("node:fs");
const registryPath = process.argv[1];
const projects = process.argv.slice(2);
let registry;
try { registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); }
catch (error) {
  console.error(`Could not read Kaizen registry at ${registryPath}: ${error.message}`);
  process.exit(1);
}
const registered = registry && registry.projects && typeof registry.projects === "object" ? registry.projects : {};
const missing = [...new Set(projects)].filter((project) => !Object.prototype.hasOwnProperty.call(registered, project));
if (missing.length > 0) {
  console.error(`Scheduled project(s) are not registered in ${registryPath}: ${missing.join(", ")}`);
  process.exit(1);
}
' "$registry_path" $scheduled_projects

verifier_diagnostic() {
  echo "Scheduled tool PATH: $tool_path" >&2
  echo "Resolved verifier: ${resolved_verifier:-<not found>}" >&2
  if [ -n "${resolved_verifier:-}" ] && [ -f "$resolved_verifier" ]; then
    verifier_shebang=$(sudo -u "$runtime_user" -- /usr/bin/head -n 1 "$resolved_verifier" 2>/dev/null || true)
    echo "Verifier shebang: ${verifier_shebang:-<unavailable>}" >&2
  fi
}

resolved_verifier=$(sudo -u "$runtime_user" -- /usr/bin/env -i \
  HOME="$runtime_home" PATH="$tool_path" KAIZEN_HOME="$kaizen_home" \
  /bin/sh -c 'command -v verifier' 2>/dev/null || true)
case "$resolved_verifier" in
  /*) ;;
  *)
    echo "Verifier preflight failed before broker installation: verifier is not available on the scheduled PATH." >&2
    verifier_diagnostic
    exit 1
    ;;
esac
if ! verifier_output=$(sudo -u "$runtime_user" -- /usr/bin/env -i \
  HOME="$runtime_home" PATH="$tool_path" KAIZEN_HOME="$kaizen_home" \
  "$resolved_verifier" --version --json 2>&1); then
  echo "Verifier preflight failed before broker installation: verifier --version --json did not run successfully." >&2
  verifier_diagnostic
  exit 1
fi
if ! printf '%s' "$verifier_output" | "$node_executable" -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 65536) process.exit(1); });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(input);
    const nullableString = (candidate) => candidate === null || typeof candidate === "string";
    const nullableBoolean = (candidate) => candidate === null || typeof candidate === "boolean";
    const expectedStale = value?.status === "stale" ? true : value?.status === "current" ? false : null;
    if (
      !value || Array.isArray(value) ||
      value.name !== "verifier" ||
      typeof value.version !== "string" ||
      !["current", "stale", "unverifiable"].includes(value.status) ||
      !nullableBoolean(value.stale) || value.stale !== expectedStale ||
      !value.build || Array.isArray(value.build) ||
      !nullableString(value.build.commit) ||
      !nullableString(value.build.builtAt) ||
      !nullableBoolean(value.build.dirty) ||
      !value.runtime || Array.isArray(value.runtime) ||
      !nullableString(value.runtime.commit) ||
      !nullableBoolean(value.runtime.dirty) ||
      typeof value.runtime.packageRoot !== "string" || value.runtime.packageRoot.length === 0
    ) process.exit(1);
  } catch { process.exit(1); }
});
'; then
  echo "Verifier preflight failed before broker installation: verifier --version --json did not return structured provenance." >&2
  verifier_diagnostic
  exit 1
fi

install_root=/usr/local/libexec/kaizen-loop
config_dir='/Library/Application Support/KaizenLoop'
log_dir=/var/log/kaizen-loop
private_root=/var/db/kaizen-loop
private_directory="$private_root/publication"
broker_out_log="$log_dir/publication-broker.out.log"
broker_err_log="$log_dir/publication-broker.err.log"
scheduled_out_log="$log_dir/scheduled-publication.out.log"
scheduled_err_log="$log_dir/scheduled-publication.err.log"
config_path="$config_dir/publication-broker.plist"
daemon_path=/Library/LaunchDaemons/org.kaizen-agents.publication-broker.plist
schedule_daemon_path=/Library/LaunchDaemons/org.kaizen-agents.scheduled-publication.plist
if [ -f "$config_path" ]; then
  old_ifs=$IFS
  IFS='
'
  set +e
  config_diff=$(/usr/bin/plutil -convert json -o - "$config_path" |
    "$node_executable" "$source_root/scripts/macos/compare-publication-broker-config.mjs" \
      "$replace_all" "$kaizen_home" --repositories $repositories --scheduled-jobs $scheduled_jobs)
  config_diff_status=$?
  set -e
  IFS=$old_ifs
  [ -z "$config_diff" ] || printf '%s\n' "$config_diff" >&2
  [ "$config_diff_status" -eq 0 ] || {
    [ "$config_diff_status" -eq 3 ] || echo "Could not compare the existing publication broker configuration." >&2
    exit 1
  }
fi
install -d -o root -g wheel -m 0755 /usr/local/libexec
trusted_root_path /usr/local/libexec || { echo "/usr/local/libexec must be root-owned and group/other non-writable." >&2; exit 1; }
validate_existing_private_directory() {
  if [ -L "$private_directory" ] || { [ -e "$private_directory" ] && [ ! -d "$private_directory" ]; }; then
    echo "$private_directory must be a real directory." >&2
    exit 1
  fi
  if [ -d "$private_directory" ]; then
    private_acl_listing=$(/bin/ls -lde "$private_directory") || { echo "Could not inspect ACLs for $private_directory." >&2; exit 1; }
    if printf '%s\n' "$private_acl_listing" | /usr/bin/tail -n +2 | /usr/bin/grep -Eq '^[[:space:]]*[0-9]+:'; then
      echo "$private_directory must not have an extended ACL." >&2
      exit 1
    fi
    private_uid=$(stat -f %u "$private_directory")
    private_gid=$(stat -f %g "$private_directory")
    private_mode=$(stat -f %Lp "$private_directory")
    [ "$private_uid" -eq 0 ] || { echo "$private_directory must be root-owned." >&2; exit 1; }
    [ $((0$private_mode & 022)) -eq 0 ] || { echo "$private_directory must not be group/other-writable." >&2; exit 1; }
    if [ "$private_gid" -ne "$runtime_gid" ] || [ "$private_mode" -ne 710 ]; then
      chown root:"$runtime_gid" "$private_directory"
      chmod 0710 "$private_directory"
    fi
    [ "$(stat -f %u "$private_directory")" -eq 0 ] || { echo "$private_directory owner normalization failed." >&2; exit 1; }
    [ "$(stat -f %g "$private_directory")" -eq "$runtime_gid" ] || { echo "$private_directory group normalization failed." >&2; exit 1; }
    [ "$(stat -f %Lp "$private_directory")" -eq 710 ] || { echo "$private_directory must have mode 0710." >&2; exit 1; }
  fi
}
if [ -L "$private_root" ] || { [ -e "$private_root" ] && [ ! -d "$private_root" ]; }; then
  echo "$private_root must be a real directory." >&2
  exit 1
fi
if [ -d "$private_root" ]; then
  trusted_root_path "$private_root" || { echo "$private_root must be root-owned and group/other non-writable." >&2; exit 1; }
  acl_listing=$(/bin/ls -lde "$private_root") || { echo "Could not inspect ACLs for $private_root." >&2; exit 1; }
  if printf '%s\n' "$acl_listing" | /usr/bin/tail -n +2 | /usr/bin/grep -Eq '^[[:space:]]*[0-9]+:'; then
    echo "$private_root must not have an extended ACL." >&2
    exit 1
  fi
fi
validate_existing_private_directory
if [ -d "$private_root" ]; then
  trusted_root_path "$private_root" || { echo "$private_root must be root-owned and group/other non-writable." >&2; exit 1; }
  chown root:wheel "$private_root"
  chmod 0711 "$private_root"
else
  install -d -o root -g wheel -m 0711 "$private_root"
fi
trusted_root_path "$private_root" || { echo "$private_root must be root-owned and group/other non-writable." >&2; exit 1; }
[ "$(stat -f %Sg "$private_root")" = wheel ] || { echo "$private_root must be owned by the wheel group." >&2; exit 1; }
[ "$(stat -f %Lp "$private_root")" -eq 711 ] || { echo "$private_root must have mode 0711." >&2; exit 1; }
acl_listing=$(/bin/ls -lde "$private_root") || { echo "Could not inspect ACLs for $private_root." >&2; exit 1; }
if printf '%s\n' "$acl_listing" | /usr/bin/tail -n +2 | /usr/bin/grep -Eq '^[[:space:]]*[0-9]+:'; then
  echo "$private_root must not have an extended ACL." >&2
  exit 1
fi
if [ -d "$config_dir" ]; then
  trusted_root_path "$config_dir" || { echo "$config_dir must be root-owned and group/other non-writable." >&2; exit 1; }
  chown root:wheel "$config_dir"
  chmod 0755 "$config_dir"
else
  install -d -o root -g wheel -m 0755 "$config_dir"
fi
install -d -o root -g wheel -m 0755 "$log_dir"
trusted_root_path "$log_dir" || { echo "$log_dir must be root-owned and group/other non-writable." >&2; exit 1; }
install -o root -g wheel -m 0600 /dev/null "$broker_out_log"
install -o root -g wheel -m 0600 /dev/null "$broker_err_log"
install -o root -g wheel -m 0600 /dev/null "$scheduled_out_log"
install -o root -g wheel -m 0600 /dev/null "$scheduled_err_log"
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
/usr/bin/plutil -insert kaizenHome -string "$kaizen_home" "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :schedulerSocketPath string /opt/kaizen/run/scheduler.sock' "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :publicationSocketPath string /opt/kaizen/run/publication.sock' "$config_stage"
/usr/libexec/PlistBuddy -c "Add :scheduledLauncherExecutable string $install_root/bin/kaizen-scheduled-launcher" "$config_stage"
/usr/libexec/PlistBuddy -c "Add :supervisorLauncherExecutable string $install_root/bin/kaizen-supervisor-launcher" "$config_stage"
/usr/bin/plutil -insert nodeExecutable -string "$node_executable" "$config_stage"
/usr/libexec/PlistBuddy -c 'Add :gitExecutable string /usr/bin/git' "$config_stage"
/usr/bin/plutil -insert githubCliExecutable -string "$github_cli_executable" "$config_stage"
/usr/libexec/PlistBuddy -c "Add :cliPath string $install_root/runtime/dist/cli.js" "$config_stage"
if [ -n "$token_file" ]; then
  /usr/bin/plutil -insert tokenFile -string "$token_file" "$config_stage"
elif [ -n "$github_app_installations" ]; then
  /usr/libexec/PlistBuddy -c 'Add :githubAppInstallations dict' "$config_stage"
  IFS='
'
  for github_app_installation in $github_app_installations; do
    github_app_owner=${github_app_installation%%:*}
    github_app_remainder=${github_app_installation#*:}
    github_app_entry_id=${github_app_remainder%%:*}
    github_app_remainder=${github_app_remainder#*:}
    github_app_entry_installation_id=${github_app_remainder%%:*}
    github_app_entry_private_key_file=${github_app_remainder#*:}
    /usr/libexec/PlistBuddy -c "Add :githubAppInstallations:$github_app_owner dict" "$config_stage"
    /usr/libexec/PlistBuddy -c "Add :githubAppInstallations:$github_app_owner:appId integer $github_app_entry_id" "$config_stage"
    /usr/libexec/PlistBuddy -c "Add :githubAppInstallations:$github_app_owner:installationId integer $github_app_entry_installation_id" "$config_stage"
    /usr/bin/plutil -insert "githubAppInstallations.$github_app_owner.privateKeyFile" -string "$github_app_entry_private_key_file" "$config_stage"
  done
  IFS=$old_ifs
else
  /usr/bin/plutil -insert githubAppId -integer "$github_app_id" "$config_stage"
  /usr/bin/plutil -insert githubAppInstallationId -integer "$github_app_installation_id" "$config_stage"
  /usr/bin/plutil -insert githubAppPrivateKeyFile -string "$github_app_private_key_file" "$config_stage"
fi
/usr/libexec/PlistBuddy -c "Add :privateDirectory string $private_directory" "$config_stage"
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
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $broker_out_log" "$daemon_stage"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $broker_err_log" "$daemon_stage"
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
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $scheduled_out_log" "$schedule_daemon_stage"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $scheduled_err_log" "$schedule_daemon_stage"
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
restore_previous_installation() {
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
}
if ! launchctl bootstrap system "$daemon_path" || ! launchctl bootstrap system "$schedule_daemon_path"; then
  restore_previous_installation
  echo "LaunchDaemon bootstrap failed; the prior runtime and configuration were restored." >&2
  exit 1
fi
if ! "$node_executable" "$source_root/scripts/macos/wait-for-unix-socket.mjs" /opt/kaizen/run/scheduler.sock 10000; then
  restore_previous_installation
  echo "Publication broker readiness failed; the prior runtime and configuration were restored." >&2
  exit 1
fi
if [ -d "$backup" ]; then rm -rf "$backup"; fi
trap - EXIT HUP INT TERM
rm -rf "$build_dir"
echo "Installed the Kaizen publication broker and root-owned scheduled dispatcher. Do not install a duplicate user LaunchAgent for these jobs."
