#!/usr/bin/env bash
# Description: Bring a Substrate sandbox's command server within the Mac's reach: the sandbox resumed when suspended, its proxy on its cluster's machine and (a remote machine's) the forward over its SSH connection — substrate:sandbox-endpoint <project> <machine> <actor>; prints JSON { port }.
set -euo pipefail

# ASS-535: sandbox-exec.js runs this when the port it has does not answer
# (the proxy ended, the machine's connection came back without its forward,
# the sandbox suspended), and the machine layer's start
# (machine-substrate.bash substrate_start). sandbox.bash sandbox_endpoint.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"

command=substrate:sandbox-endpoint
[[ $# -eq 3 ]] || { echo "usage: $command <project> <machine> <actor>" >&2; exit 1; }
project="$1" machine="$2" actor="$3"
entry="$(substrate_entry "$command" "$project" "$machine")"
substrate_connected "$project" "$machine" "$entry" || { echo "$command: $project's $machine has no open connection" >&2; exit 1; }
port="$(sandbox_endpoint "$command" "$project" "$machine" "$entry" "$actor")"
jq -nc --argjson p "$port" '{ port: $p }'
