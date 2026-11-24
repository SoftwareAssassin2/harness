#!/usr/bin/env bash
# Description: Suspend (hibernate) a Substrate sandbox on its cluster, its proxy ended first — substrate:sandbox-suspend <project> <machine> <actor>; prints what it did.
set -euo pipefail

# ASS-535: the machine layer's stop (machine-substrate.bash substrate_stop,
# machine-substrate.js stop) and substrate:sandbox-stop's. A remote machine
# with no open connection: nothing to do there (its sandboxes are not
# running while it is stopped); exit 0.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"

command=substrate:sandbox-suspend
[[ $# -eq 3 ]] || { echo "usage: $command <project> <machine> <actor>" >&2; exit 1; }
project="$1" machine="$2" actor="$3"
entry="$(substrate_entry "$command" "$project" "$machine")"
substrate_connected "$project" "$machine" "$entry" || { echo '{"ok":true,"did":[],"failed":[],"reason":"not connected"}'; exit 0; }
substrate_on "$project" "$machine" "$entry" sandbox-stop "$actor" </dev/null | tail -n 1
