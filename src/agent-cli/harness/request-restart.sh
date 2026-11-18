#!/usr/bin/env bash
# Description: Ask the harness to restart itself — harness:request-restart [<ticket-key>]: a fix's, once it is in; with no key, the operator's.
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
# ASS-507: with no ticket key it is the operator's restart, the same drain, exit
# 75 and VMs left running: recorded as "operator": true beside the tickets
# (none of its own — a fresh one's are []). It joins a pending request, and a
# keyed one joins it, the same way: its tickets kept, "operator" kept true. A
# request is pending when it has tickets or is the operator's. An empty key is
# refused, so an engine's unfilled {ticket} is never taken for the operator.
home="${HARNESS_HOME:-$HOME/.harness}"

usage() { echo "usage: harness:request-restart [<ticket-key>]  (no key: the operator's restart)" >&2; exit 1; }
[[ $# -le 1 ]] || usage
[[ $# -eq 0 || -n "$1" ]] || usage
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
update_json --create "$file" --arg ticket "${1:-}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson now "${pids:-[]}" '
  ((.tickets // [.ticket]) | map(strings)) as $tickets | (.["control-pids"] // [.["control-pid"]]) as $named
  | (if $ticket == "" then [] else [$ticket] end) as $mine | (.operator == true) as $operator
  | if (($tickets | length) > 0 or $operator) and .restarted != true and (($now | length) == 0 or any($named[]; . as $p | any($now[]; . == $p)))
    then { tickets: ($tickets + ($mine - $tickets)), since, "control-pids": $named }
      + (if $operator or $ticket == "" then { operator: true } else {} end)
      + (if has("restarted-before") then { "restarted-before": .["restarted-before"] } else {} end)
    else { tickets: $mine, since: $at, "control-pids": $now }
      + (if $ticket == "" then { operator: true } else {} end)
      + (if ($tickets | length) > 0 then { "restarted-before": $tickets } else {} end) end'
jq -c . "$file"
