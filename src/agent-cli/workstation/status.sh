#!/usr/bin/env bash
# Description: Show a project's GCP workstation's state and whether its SSH connection is open — workstation:status <project> <id> [--connection]; prints its live data.
set -euo pipefail

# ASS-433 AC1, AC5: whether the workstation's one connection
# (workstation:connect) is open — its master up and a command run over it
# returning — and, unless --connection (control's frequent check, which asks
# Google nothing), its state as gcloud workstations describe gives it
# (running, stopped, …). Both are written to the project's workstations.json
# (connected, checked-at; state, state-at) and the entry printed with its id.
# While a connect or disconnect holds the workstation's lock, nothing is
# checked or written: the entry is printed as it stands, with "busy": true.
# A describe that fails leaves the state as it was, said on stderr (one line,
# any token redacted).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation.bash"

command=workstation:status
[[ $# -eq 2 || ( $# -eq 3 && "$3" == --connection ) ]] || { echo "usage: $command <project> <id> [--connection]" >&2; exit 1; }
project="$1" id="$2"
settings="$(workstation_settings "$command" "$project" "$id")"

if ! workstation_lock "$command" "$project" "$id" 1 2>/dev/null; then
  workstation_entry "$project" "$id" | jq -c '. + { busy: true }'
  exit 0
fi
connected=false
workstation_reachable "$project" "$id" && connected=true
workstation_record "$project" "$id" --argjson c "$connected" '. + { connected: $c, "checked-at": $at }'
if [[ $# -eq 2 ]]; then
  if state="$(workstation_state "$settings" 2>&1)"; then
    workstation_record "$project" "$id" --arg s "$state" '. + { state: $s, "state-at": $at }'
  else
    workstation_error "$state"
    echo "$command: $project's workstation $id: its state could not be read ($ws_error_kind): $ws_error_message" >&2
  fi
fi
workstation_entry "$project" "$id"
