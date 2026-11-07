#!/usr/bin/env bash
# Description: Whether the harness has restarted since harness:request-restart — harness:restarted <ticket-key>.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# Reads $HARNESS_HOME/restart-requested.json (~/.harness by default).
# Restarted means controls run now (run.pid, run-<project>.pid) and none of
# them is one the request named: then the request is stamped restarted: true
# and "restarted-at" (under its lock, update_json) and { ticket, restarted:
# true, "control-pids" } printed — for every ticket in its tickets, each time
# asked, and for one in its "restarted-before" (ASS-210). Not yet — a
# requested control still runs, or none does — exits 1 saying so: Await the
# Restart's waiting-exit-code, polled again with no failure (ASS-255). A
# ticket no request was made for exits 2, an error: it would wait forever.
# An old-shape request's "ticket" is a one-ticket list.
home="${HARNESS_HOME:-$HOME/.harness}"

[[ $# -eq 1 ]] || { echo "usage: harness:restarted <ticket-key>" >&2; exit 1; }
file="$home/restart-requested.json"
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
# before: this ticket's restart has happened already (the request stamped, or the ticket carried forward); named: it waits on this request.
asked="$([[ -f "$file" ]] && jq -r --arg t "$1" 'if any(.["restarted-before"][]?; . == $t) or (.restarted == true and any((.tickets // [.ticket])[]; . == $t)) then "before" elif any((.tickets // [.ticket])[]; . == $t) then "named" else "" end' "$file" || true)"
[[ -n "$asked" ]] || { echo "harness:restarted: no restart was requested for $1" >&2; exit 2; }
[[ "$asked" != before ]] || { jq -nc --arg ticket "$1" --argjson pids "$(control_pids)" '{ ticket: $ticket, restarted: true, "control-pids": $pids }'; exit 0; }
now="$(control_pids)"
[[ "${now:-[]}" != '[]' ]] || { echo "harness:restarted: not yet — no control runs" >&2; exit 1; }
still="$(jq -r --argjson now "$now" '[(.["control-pids"] // [.["control-pid"]])[] | numbers | select(. as $p | $now | any(.[]; . == $p))] | first // empty' "$file")"
[[ -z "$still" ]] || { echo "harness:restarted: not yet — control $still still runs" >&2; exit 1; }
update_json --create "$file" --arg ticket "$1" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  'if .restarted != true and any((.tickets // [.ticket])[]; . == $ticket) then .restarted = true | .["restarted-at"] = $at else . end'
jq -nc --arg ticket "$1" --argjson pids "$now" '{ ticket: $ticket, restarted: true, "control-pids": $pids }'
