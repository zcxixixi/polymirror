#!/bin/sh
set -eu

run_dir=${1:-}
if [ -z "$run_dir" ]; then
  echo "usage: npm run preview:pipeline:start -- <run-dir>" >&2
  exit 1
fi

case "$run_dir" in
  /*) ;;
  *) run_dir="$PWD/$run_dir" ;;
esac

config_path="$run_dir/config.preview.yaml"
data_dir="$run_dir/data"
report_dir="$run_dir/reports"
[ -f "$config_path" ] || {
  echo "preview config missing: $config_path" >&2
  exit 1
}

mkdir -p "$data_dir" "$report_dir"
npm run build:daemon

CONFIG_PATH="$config_path" \
REPORT_DATA_DIR="$data_dir/accounts" \
REPORT_OUT_DIR="$report_dir" \
REPORT_STARTING_CAPITAL_USD=200 \
REPORT_WINDOW_MINUTES=1440 \
REPORT_COLLECT_INTERVAL_MINUTES="${REPORT_COLLECT_INTERVAL_MINUTES:-60}" \
REPORT_COLLECT_RUN_IMMEDIATELY=1 \
node dist/report-preview-collector.js &
collector_pid=$!

cleanup() {
  kill "$collector_pid" 2>/dev/null || true
  wait "$collector_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

CONFIG_PATH="$config_path" \
POLYMIRROR_DATA_DIR="$data_dir" \
POLYMARKET_LIVE_CONFIRM="" \
HEALTH_PORT="${HEALTH_PORT:-18080}" \
node dist/index.js
