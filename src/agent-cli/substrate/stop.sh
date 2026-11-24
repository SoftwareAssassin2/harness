#!/usr/bin/env bash
# Description: Stop a project's Substrate cluster's node on its cloud VM or workstation, its state kept, so the machine can stop itself when idle; the next setup starts it — substrate:stop <project> <machine>; prints what it did.
set -euo pipefail

# ASS-533: on-machine/substrate.sh stop over the machine's open connection,
# under the cluster's lock. A cloud VM's idle check (its own, never the
# harness's to change) counts load as busy, and a running cluster keeps its
# load up, so the VM would never stop itself: control runs this before its
# idle disconnect of a cloud VM (src/control/workstations.js). The cluster's
# state (its node's volume: postgres, rustfs, the snapshots) stays on disk;
# workstation:setup's host setup starts the node again at the next connect.
# Not for the Mac's cluster, which every Mac project shares (exit 2). Fails
# without an open connection.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"

command=substrate:stop
[[ $# -eq 2 ]] || { echo "usage: $command <project> <machine>" >&2; exit 1; }
project="$1" machine="$2"
entry="$(substrate_entry "$command" "$project" "$machine")"
case "$(substrate_host "$entry")" in mac|gke) echo "$command: $project's $machine cluster is not one a machine's idle stop waits for" >&2; exit 2 ;; esac
substrate_lock "$command" "$project" "$machine" "$entry"
substrate_connected "$project" "$machine" "$entry" || { echo "$command: $project's $machine has no open connection" >&2; exit 1; }
substrate_on "$project" "$machine" "$entry" stop </dev/null
