#!/usr/bin/env bash
# Description: Whether the Address Merge Request Feedback round just ended changed anything on the ticket's merge requests — merge-request:feedback-round <project> <ticket-key> <variation> [--only <ids>].
set -euo pipefail

# ASS-388: run after Address Merge Request Feedback (engines/grouped-merge's
# Check the Feedback Round; a project Release's own), so a round that did
# nothing spends none of that step's max-visits. merge-request:check, which
# sends a merge request to the round, records the head commit it saw on its
# row (checked-head) and clears feedback-acted; merge-request:reply and
# :resolve set feedback-acted. So, for each Open one of the set (--only
# <ids>, comma-separated, or - for every one; every Open one without it), its
# head is read from its forge (mr_head) and the round changed it when that
# head is not its checked-head, it has none recorded, or it has
# feedback-acted. Prints
#
#   { "changed": <bool>, "merge-requests": [{ id, key, head, "checked-head", acted }] }
#
# changed is false only when there is at least one Open one and none was
# changed: every head as the check saw it, nothing replied to or resolved.
# The engine's exit on changed false goes back to the check with cause
# no-op-round (engine.js NO_OP_ROUND), and control counts no visit for the
# round. Exits 0 when it ran; 1 on a failure (a forge call, the ticket or
# variation missing, an id not planned), which the engine reads as a change.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

USAGE="merge-request:feedback-round <project> <ticket-key> <variation> [--only <ids>]"
[[ $# -ge 3 ]] || { echo "usage: $USAGE" >&2; exit 1; }
command=merge-request:feedback-round project="$1" key="$(upper "$2")" variation="$3"
merge_request_options "$command" "$USAGE" "${@:4}"
load_merge_requests "$command" "$project" "$key" "$variation"
only_checked "$command" "$key" "$variation"

seen='[]'
for i in $(jq -r --argjson only "$ONLY" "$MR_ONLY"'to_entries[] | select(.value.status == "Open" and .value.key != null and (.value | in_set($only))) | .key' <<< "$MRS"); do
  head="$(mr_head "$command" "$i")"
  seen="$(jq -c --argjson i "$i" --arg h "$head" --argjson mrs "$MRS" '. + [$mrs[$i] | { id, key, head: $h, "checked-head": (.["checked-head"] // null), acted: (.["feedback-acted"] == true) }]' <<< "$seen")"
done
jq -c '{ changed: (. == [] or any(.[]; .head != .["checked-head"] or .acted)), "merge-requests": . }' <<< "$seen"
