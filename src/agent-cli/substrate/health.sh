#!/usr/bin/env bash
# Description: Check a project's Substrate cluster on the Mac or on its workstation or cloud VM — pods, its template's golden snapshot, rustfs, postgres, the host's Docker memory — and record it; never starts a machine — substrate:health <project> [<machine>]; prints { ok, state, problems, … }.
set -euo pipefail

# ASS-533 AC4: on-machine/substrate.sh health on the cluster's machine (the
# Mac, or a remote one over its open connection), which says what it checks;
# each problem { what, why, repair } (repair: substrate:up can fix it). The
# result is recorded as the machine's entry in data/projects/<project>/
# substrate.json with its checked-at (its `up` and, ASS-538, `credentials` kept), which control
# (src/control/substrate.js, every few minutes) and the dashboard's header
# read. A remote machine with no open connection is not checked — it would
# have to be started — and recorded state not-connected (exit 3); a GKE
# entry, refused until approved, state refused. Exit 0 whenever the check ran,
# whatever it found.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"

command=substrate:health
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: $command <project> [<machine>]" >&2; exit 1; }
project="$1" machine="${2:-mac}"
entry="$(substrate_entry "$command" "$project" "$machine")"
if [[ "$(substrate_host "$entry")" == gke ]]; then
  substrate_record "$project" "$machine" --arg why "$(jq -r .refused <<< "$entry")" '. + { ok: true, state: "refused", problems: [], why: $why, "checked-at": $at }'
  jq -c --arg m "$machine" '.[$m]' "$substrate_projects/$project/substrate.json"
  exit 0
fi
if ! substrate_connected "$project" "$machine" "$entry"; then
  substrate_record "$project" "$machine" '. + { state: "not-connected", "checked-at": $at }'
  jq -c --arg m "$machine" '.[$m]' "$substrate_projects/$project/substrate.json"
  exit 3
fi
rc=0
out="$(ws_timeout "${SUBSTRATE_HEALTH_TIMEOUT:-180}" bash -c "source '$here_substrate/substrate.bash' && substrate_on \"\$@\"" _ "$project" "$machine" "$entry" health </dev/null 7>&- 8>&- 9>&-)" || rc=$?
result="$(tail -n 1 <<< "$out")"
if ! jq -e 'type == "object" and has("state")' <<< "$result" >/dev/null 2>&1; then
  why="it exited $rc and printed nothing"
  [[ $rc -ne 124 ]] || why="it did not finish within ${SUBSTRATE_HEALTH_TIMEOUT:-180} seconds"
  [[ $rc -ne 255 ]] || why="the connection failed"
  result="$(jq -cn --arg why "$why" '{ ok: false, state: "unchecked", problems: [{ what: "check", why: $why, repair: false }] }')"
fi
substrate_record "$project" "$machine" --argjson r "$result" '{ up, credentials } + $r + { "checked-at": $at } | with_entries(select(.value != null))'
printf '%s\n' "$result"
