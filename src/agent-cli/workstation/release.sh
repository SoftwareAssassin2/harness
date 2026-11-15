#!/usr/bin/env bash
# Description: Free one of a project's GCP workstations, removing the folder of the ticket variation that holds it — workstation:release <project> <id> [--force]; prints its live data.
set -euo pipefail

# ASS-435 AC6: what deleting a VM is to a variation on a workstation. The
# workstation's holder (workstations.json's `holder`, the one ticket
# variation on it: workstation-variation.bash) has its folder there,
# ~/harness/<KEY>-<variation>, removed over the workstation's connection —
# its repositories, the ticket's copy, and the containers working in it or
# mounting any of it (a dev container's, with their anonymous volumes) — and
# the credentials and forwarder token vm:start put in the setup's runtime
# folder (env, gitconfig, npmrc, gh, glab, agent-token); its vm-tokens.json
# binding dropped and the holder removed, so the workstation is free for the
# next variation. Nothing outside ~/harness and the runtime folder is
# touched, nor ~/harness's own bin, lib, tools, env and setup.json, nor the
# runtime folder's agent-url (setup's). Control runs it once the holder gives
# the workstation up (Done, set aside, gone from the sprint, at a `vm:
# released` step) with no assignment on it (src/control/workstations.js), and
# vm:create's placement reclaims a workstation whose holder is no longer in
# flight through the same. Refused while the holder is in flight unless
# --force. Under the project's pool lock (descriptor 7), so a placement never
# races it. Needs the connection open (workstation:connect): fails, the
# holder kept, when it is not. No holder: nothing to do.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

command=workstation:release
[[ $# -eq 2 || ( $# -eq 3 && "$3" == --force ) ]] || { echo "usage: $command <project> <id> [--force]" >&2; exit 1; }
project="$1" id="$2"
workstation_settings "$command" "$project" "$id" >/dev/null
wsv_pool_lock "$command" "$project"
holder="$(workstation_entry "$project" "$id" | jq -c '.holder // empty')"
if [[ -n "$holder" && $# -eq 2 ]] && wsv_in_flight "$project" "$(jq -r .ticket <<< "$holder")" "$(jq -r .variation <<< "$holder")"; then
  echo "$command: $(jq -r '"\(.ticket) \(.variation)"' <<< "$holder") still needs $project's workstation $id (an assignment on it, or at a step that runs its machine); --force to free it anyway" >&2
  exit 1
fi
wsv_release "$command" "$project" "$id" "released"
workstation_entry "$project" "$id"
