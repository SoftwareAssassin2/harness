#!/usr/bin/env bash
# Description: Run the dashboard (and with it control and the downloader) — tui.
set -uo pipefail

# The dashboard exits with code 75 when control asked for a restart (a
# self-healing fix went in, harness:request-restart): it is started again, on
# the new code. Any other exit ends it, with that code.
dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
while :; do
  node "$dir/../tui/main.js" "$@"
  status=$?
  [[ $status -eq 75 ]] || exit "$status"
done
