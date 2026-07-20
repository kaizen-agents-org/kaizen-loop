#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: run-scheduled.sh <node> <project> <job>" >&2
  exit 2
fi

node_bin=$1
project=$2
job=$3
kaizen_home=${KAIZEN_HOME:-"$HOME/.kaizen"}
operator_launcher="$kaizen_home/bin/kaizen"
if [ ! -x "$operator_launcher" ]; then
  runtime_dir=${KAIZEN_RUNTIME_DIR:-"$kaizen_home/runtime/kaizen-loop"}
  runtime_launcher="$runtime_dir/scripts/kaizen-runtime.sh"
  if [ ! -f "$runtime_launcher" ]; then
    echo "Kaizen operator launcher is missing; run scheduler sync from an upgraded kaizen-loop checkout." >&2
    exit 1
  fi
  cp "$runtime_launcher" "$operator_launcher.tmp"
  chmod 755 "$operator_launcher.tmp"
  mv "$operator_launcher.tmp" "$operator_launcher"
fi
KAIZEN_NODE="$node_bin" exec "$operator_launcher" run \
  --project "$project" \
  --scheduled \
  --job "$job"
