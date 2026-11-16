#!/usr/bin/env bash
# Description: Close a project's GCP workstation's SSH connection, so its own idle stop can happen — workstation:disconnect <project> <id>; prints its live data.
set -euo pipefail

# ASS-433 AC1, AC3: the workstation's one connection (workstation:connect)
# ended — its master told to exit (ssh -O exit), its process group
# SIGTERMed, its socket removed — under the workstation's lock, and recorded
# in the project's workstations.json (connected false, disconnected-at). The
# workstation itself is left running: with no SSH session left it stops
# itself after its idle timeout (30 minutes), as control wants once nothing
# on it needs it. Nothing to do, and no failure, when no connection is open.
# ASS-470: its owner (control-pid, workstation.bash) cleared.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation.bash"

command=workstation:disconnect
[[ $# -eq 2 ]] || { echo "usage: $command <project> <id>" >&2; exit 1; }
project="$1" id="$2"
workstation_settings "$command" "$project" "$id" >/dev/null
workstation_lock "$command" "$project" "$id"
workstation_close "$project" "$id"
workstation_record "$project" "$id" '. + { connected: false, "disconnected-at": $at, "control-pid": null }'
workstation_entry "$project" "$id"
