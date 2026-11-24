#!/usr/bin/env bash
# Description: Say where a Substrate sandbox stands on its cluster (exists, running or suspended, its proxy) — substrate:sandbox-state <project> <machine> <actor>; prints JSON.
set -euo pipefail

# ASS-535: the machine layer's status (machine-substrate.bash substrate_status,
# machine-substrate.js status): on-machine/substrate.sh sandbox-state on the
# cluster's machine. A remote machine with no open connection: { exists:
# null, state: null, reason: "not connected" }.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"

command=substrate:sandbox-state
[[ $# -eq 3 ]] || { echo "usage: $command <project> <machine> <actor>" >&2; exit 1; }
project="$1" machine="$2" actor="$3"
entry="$(substrate_entry "$command" "$project" "$machine")"
substrate_connected "$project" "$machine" "$entry" || { echo '{"exists":null,"state":null,"reason":"not connected"}'; exit 0; }
substrate_on "$project" "$machine" "$entry" sandbox-state "$actor" </dev/null | tail -n 1
