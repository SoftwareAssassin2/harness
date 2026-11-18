#!/usr/bin/env bash
# Description: Whether the harness has restarted since harness:request-restart — harness:restarted [<ticket-key>]; with none, the latest request.
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
# ASS-507: with no ticket key, whether the latest request — the operator's or
# any ticket's — has been fulfilled, judged the same way: { tickets, operator,
# restarted: true, "control-pids" } (the request stamped the same way), 1 while
# pending, 2 when there is no request (none has tickets or is the operator's).
home="${HARNESS_HOME:-$HOME/.harness}"

usage() { echo "usage: harness:restarted [<ticket-key>]  (no key: the latest request)" >&2; exit 1; }
[[ $# -le 1 ]] || usage
[[ $# -eq 0 || -n "$1" ]] || usage
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
# ASS-507: the keyless form — the latest request, whatever it names. Restarted
# already (stamped), else as below: no control it named still runs, and one does.
if [[ $# -eq 0 ]]; then
  latest="$([[ -f "$file" ]] && jq -c 'select(((.tickets // [.ticket]) | map(strings) | length) > 0 or .operator == true)
    | { tickets: ((.tickets // [.ticket]) | map(strings)), operator: (.operator == true), restarted: (.restarted == true) }' "$file" || true)"
  [[ -n "$latest" ]] || { echo "harness:restarted: no restart was requested" >&2; exit 2; }
  now="$(control_pids)"
  if [[ "$(jq -r .restarted <<< "$latest")" != true ]]; then
    [[ "${now:-[]}" != '[]' ]] || { echo "harness:restarted: not yet — no control runs" >&2; exit 1; }
    still="$(jq -r --argjson now "$now" '[(.["control-pids"] // [.["control-pid"]])[] | numbers | select(. as $p | $now | any(.[]; . == $p))] | first // empty' "$file")"
    [[ -z "$still" ]] || { echo "harness:restarted: not yet — control $still still runs" >&2; exit 1; }
    # Stamped only if, under the lock, it still names none running: a fresh request made meanwhile is not this one.
    update_json --create "$file" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson now "$now" \
      'if .restarted != true and ((.["control-pids"] // [.["control-pid"]]) | all(.[]; . as $p | $now | all(.[]; . != $p))) then .restarted = true | .["restarted-at"] = $at else . end'
  fi
  jq -c --argjson pids "${now:-[]}" '.restarted = true | .["control-pids"] = $pids' <<< "$latest"
  exit 0
fi
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
