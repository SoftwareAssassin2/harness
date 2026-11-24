#!/usr/bin/env bash
# Description: Remove a ticket variation's worktrees on its project's workstations and cloud VMs (ASS-553: run targets workstation-worktree, cloud-vm-worktree), once the ticket is done — workstation:remove-worktree <project> <ticket-key> <variation>; prints { removed, left } (left: its machine not connected, or a step of it still holds it).
set -euo pipefail

# Each of the variation's `remote-worktrees` ({ name: <machine id>, folder }, recorded by workstation:claim
# --worktree) whose machine is connected now and holds no step of the variation in it: its folder
# (<home>/harness/worktrees/<KEY>[.<variation>], nothing else is ever removed here) deleted over the machine's
# connection, under the project's pool lock (so no claim takes it meanwhile), and the entry dropped. The branch stays:
# every step's end pushed it. A machine not connected is never started for this: that one is left (`left`, with
# why), and control tries again once it is connected (src/control/run-target-places.js removeDoneWorktrees). A
# machine no longer listed in dev-environments has its entry dropped (nothing to reach). Nothing recorded: { removed:
# [], left: [] }.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

command=workstation:remove-worktree
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "$command: invalid project '$project'" >&2; exit 1; }
sprint="$(sprint_file "$command" "$project")"
list="$(jq -c --arg k "$key" --arg v "$variation" '
  first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == $k)) // {} | (.variations // [])
  | map(select(.name == $v)) | first // {} | .["remote-worktrees"] // []' "$sprint")"
removed=() left=()
wsv_pool_lock "$command" "$project"
while IFS= read -r wt; do
  [[ -n "$wt" ]] || continue
  id="$(jq -r .name <<< "$wt")" folder="$(jq -r .folder <<< "$wt")"
  drop() {
    update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --arg id "$id" --arg f "$folder" '
      .variations |= map(if .name == $name then .["remote-worktrees"] = ((.["remote-worktrees"] // []) | map(select(.name != $id or .folder != $f))) | (if .["remote-worktrees"] == [] then del(.["remote-worktrees"]) else . end) else . end)' >/dev/null
  }
  [[ "$folder" =~ $wsv_worktree_folder && "$folder" != *..* ]] || { echo "$command: $key $variation records a worktree $folder on $id that is not a worktree folder; dropped, not touched" >&2; drop; continue; }
  if ! dev_environments_workstation "$command" "$project" "$id" >/dev/null 2>&1; then echo "$command: $id is no longer one of $project's machines; its record dropped" >&2; drop; continue; fi
  if workstation_entry "$project" "$id" | jq -e --arg f "$folder" "$wsv_holders"' | any(.folder == $f)' >/dev/null; then left+=("$(jq -nc --arg n "$id" --arg f "$folder" '{ name: $n, folder: $f, why: "a step of it holds it now" }')"); continue; fi
  if ! workstation_alive "$project" "$id"; then left+=("$(jq -nc --arg n "$id" --arg f "$folder" '{ name: $n, folder: $f, why: "not connected" }')"); continue; fi
  workstation_ssh "$project" "$id" bash -c 'f="$1"; [ ! -e "$f" ] || { chmod -R u+w "$f" 2>/dev/null; rm -rf "$f"; }; [ ! -e "$f" ]' harness-ws "$folder" </dev/null 7>&- \
    || { left+=("$(jq -nc --arg n "$id" --arg f "$folder" '{ name: $n, folder: $f, why: "it could not be removed" }')"); continue; }
  echo "$command: $key $variation's worktree $folder on $id removed" >&2
  drop
  removed+=("$(jq -nc --arg n "$id" --arg f "$folder" '{ name: $n, folder: $f }')")
done < <(jq -c '.[]' <<< "$list")
exec 7>&-
jq -nc --argjson r "$(printf '%s\n' "${removed[@]+"${removed[@]}"}" | jq -s -c .)" --argjson l "$(printf '%s\n' "${left[@]+"${left[@]}"}" | jq -s -c .)" '{ removed: $r, left: $l }'
