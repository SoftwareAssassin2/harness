#!/usr/bin/env bash
# Description: Stop (hibernate) a ticket variation's Substrate sandbox: its proxy ended and the sandbox suspended, its files and processes kept, so it takes no memory, CPU or seat until it is resumed — substrate:sandbox-stop <project> <ticket-key> <variation>; prints JSON.
set -euo pipefail

# ASS-535 AC1. Its record's state becomes stopped. A variation with no
# sandbox: nothing (exit 0). The endpoint file is kept (its port too), so the
# next substrate:sandbox-up or a command run in it (sandbox-exec.js, through
# substrate:sandbox-endpoint) resumes it at the same port.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"

command=substrate:sandbox-stop
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
record="$(sandbox_of "$command" "$project" "$key" "$variation")" || { echo "$command: no $key variation $variation in $project's sprint" >&2; exit 1; }
[[ "$record" != null ]] || { echo '{"stopped":false,"reason":"no sandbox"}'; exit 0; }
machine="$(jq -r .machine <<< "$record")" actor="$(jq -r .name <<< "$record")"
"$sandbox_agent" substrate:sandbox-suspend "$project" "$machine" "$actor" >/dev/null
sandbox_set "$command" "$project" "$key" "$variation" "$(jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.state = "stopped" | .at = $at' <<< "$record")"
jq -nc --arg a "$actor" --arg m "$machine" '{ stopped: true, name: $a, host: $m }'
