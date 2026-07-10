#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: run-scheduled.sh <node> <project> <job>" >&2
  exit 2
fi

node_bin=$1
project=$2
job=$3
remote_url=${KAIZEN_RUNTIME_REMOTE:-}
if [ -z "$remote_url" ]; then
  source_root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$source_root" ]; then
    remote_url=$(git -C "$source_root" remote get-url origin 2>/dev/null || true)
  fi
fi
remote_url=${remote_url:-https://github.com/kaizen-agents-org/kaizen-loop.git}
kaizen_home=${KAIZEN_HOME:-"$HOME/.kaizen"}
runtime_dir=${KAIZEN_RUNTIME_DIR:-"$kaizen_home/runtime/kaizen-loop"}
lock_dir="$kaizen_home/runtime/update.lock"

mkdir -p "$(dirname "$runtime_dir")"
if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_pid=''
  if [ -f "$lock_dir/pid" ]; then
    lock_pid=$(sed -n '1p' "$lock_dir/pid")
  fi
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "Kaizen runtime update is already running; refusing to use an uncertain CLI build." >&2
    exit 1
  fi
  rm -rf "$lock_dir"
  mkdir "$lock_dir"
fi
printf '%s\n' "$$" > "$lock_dir/pid"
cleanup() {
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ ! -d "$runtime_dir/.git" ]; then
  git clone --branch main --single-branch "$remote_url" "$runtime_dir"
fi

git -C "$runtime_dir" fetch --prune origin main
git -C "$runtime_dir" checkout --detach origin/main

installed_launcher="$kaizen_home/bin/run-scheduled.sh"
runtime_launcher="$runtime_dir/scripts/run-scheduled.sh"
if [ -f "$runtime_launcher" ] && ! cmp -s "$runtime_launcher" "$installed_launcher"; then
  mkdir -p "$(dirname "$installed_launcher")"
  cp "$runtime_launcher" "$installed_launcher.tmp"
  chmod 755 "$installed_launcher.tmp"
  mv "$installed_launcher.tmp" "$installed_launcher"
fi

commit=$(git -C "$runtime_dir" rev-parse HEAD)
built_commit=''
if [ -f "$runtime_dir/.kaizen-built-commit" ]; then
  built_commit=$(sed -n '1p' "$runtime_dir/.kaizen-built-commit")
fi

if [ "$commit" != "$built_commit" ] || [ ! -f "$runtime_dir/dist/cli.js" ]; then
  (
    cd "$runtime_dir"
    npm ci
    npm run build
  )
  printf '%s\n' "$commit" > "$runtime_dir/.kaizen-built-commit"
fi

cleanup
trap - EXIT
exec "$node_bin" "$runtime_dir/dist/cli.js" run \
  --project "$project" \
  --scheduled \
  --job "$job"
