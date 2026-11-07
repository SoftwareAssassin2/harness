#!/usr/bin/env bash
# Description: Ask the harness to restart itself, once a fix is in — harness:request-restart <ticket-key>.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# Writes $HARNESS_HOME/restart-requested.json (~/.harness by default):
# { tickets: [<key>,…], since (when first made, UTC), "control-pids" } — the
# pids every control running when it was first made wrote (run.pid, and run-<project>.pid for a control per
# project), [] when none runs. A control finding its own pid there dispatches
# nothing more, waits for its running agents to end their turns (up to
# harness.json's restart-drain-seconds, 300 by default; ASS-200), stops the
# rest and exits with code 75; once every control it names has, the dashboard
# stops the rest and exits with 75 too, and harness-cli/tui.sh starts it again
# on the new code.
# harness:restarted says when that has happened. Prints the request. A
# request still pending — judged as harness:restarted judges it: a control it
# named still runs, or none runs yet — is joined, the ticket added once
# (ASS-210). A fulfilled one, or none, starts a fresh one-ticket request; a
# fulfilled one's tickets move into its "restarted-before", one generation.
# Under the file's lock (update_json), so two requests at once lose neither.
home="${HARNESS_HOME:-$HOME/.harness}"

[[ $# -eq 1 ]] || { echo "usage: harness:request-restart <ticket-key>" >&2; exit 1; }
mkdir -p "$home"
# The pids the controls running now wrote: run.pid, and run-<project>.pid for a control per project.
# A pidfile naming a process that has ended (a control that died leaving it) counts as none.
control_pids() {
  local file pid pids=()
  for file in "$home"/run.pid "$home"/run-*.pid; do
    [[ -f "$file" ]] && pid="$(tr -dc '0-9' < "$file")" && [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && pids+=("$pid")
  done
  [[ ${#pids[@]} -gt 0 ]] || { echo '[]'; return 0; }
  printf '%s\n' "${pids[@]}" | { grep -v '^$' || true; } | jq -sc 'map(tonumber) | sort'
}
pids="$(control_pids)"
file="$home/restart-requested.json"
update_json --create "$file" --arg ticket "$1" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson now "${pids:-[]}" '
  ((.tickets // [.ticket]) | map(strings)) as $tickets | (.["control-pids"] // [.["control-pid"]]) as $named
  | if ($tickets | length) > 0 and .restarted != true and (($now | length) == 0 or any($named[]; . as $p | any($now[]; . == $p)))
    then { tickets: ($tickets + ([$ticket] - $tickets)), since, "control-pids": $named } + (if has("restarted-before") then { "restarted-before": .["restarted-before"] } else {} end)
    else { tickets: [$ticket], since: $at, "control-pids": $now } + (if ($tickets | length) > 0 then { "restarted-before": $tickets } else {} end) end'
jq -c . "$file"
