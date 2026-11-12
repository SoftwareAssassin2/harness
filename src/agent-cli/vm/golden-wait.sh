#!/usr/bin/env bash
# Description: Whether a project's golden image is being built, for a step that waits until no build runs — vm:golden-wait <project>; exits 1 while one does; prints JSON.
set -euo pipefail

# ASS-392 AC3: grouped-blocked's Await the Golden Build, before Repair Image
# (and after it, when Repair Image started a build): one golden rebuild of a
# project at a time. A build runs while golden.bash's golden_status says
# "building" — the build lock (golden-build.lock, vm:build-golden's) held,
# or the build vm:build-golden-start last started (golden-build-run.json)
# still going: the same reading vm:build-golden-start refuses a second start
# on, so whoever started it (control's golden rebuild ticket, ASS-151, an
# operator by hand, another ticket's Repair Image) no two overlap. Prints
# golden_status's JSON with the image's label — built-at, generation and fix
# (null when it has none or was never built) — so Repair Image can tell a
# build that finished while it waited, and re-check the problem first. Exits:
#   1  building — the step's waiting-exit-code: polled again on its timer, no
#      failure counted
#   0  no build runs (status current or failed)
#   2  the project or its golden-image definition is missing — printing
#      { ai-feedback-short, ai-feedback-long } for Blocked for Human
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:golden-wait <project>" >&2; exit 2; }
if ! why="$(golden_definition vm:golden-wait "$1" 2>&1 >/dev/null)"; then
  jq -nc --arg w "$why" '{ "ai-feedback-short": "Repair Image: no golden image definition to repair", "ai-feedback-long": $w }'
  echo "$why" >&2
  exit 2
fi
golden_definition vm:golden-wait "$1"
now="$(golden_status "$1")"
label="$(golden_label "$1")"
jq -c --slurpfile l <(cat "$label" 2>/dev/null || true) \
  '. + { "built-at": ($l[0]["built-at"] // null), generation: ($l[0].generation // null), fix: ($l[0].fix // null) }' <<< "$now"
if [[ "$(jq -r .status <<< "$now")" == building ]]; then
  echo "vm:golden-wait: golden-$1 is being built; waiting for it to finish" >&2
  exit 1
fi
