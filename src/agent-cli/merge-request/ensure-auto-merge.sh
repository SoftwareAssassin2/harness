#!/usr/bin/env bash
# Description: Set the ticket's merge requests to merge once their checks pass, in depends-on order — merge-request:ensure-auto-merge <project> <ticket-key> <variation> [--only <ids>].
set -euo pipefail

# Idempotent. Control reads every one of the variation's merge requests
# (refresh_merge_requests, merge-requests.bash), which retargets a dependent
# to master once its dependency has merged; then, in depends-on order, each
# Open one neither merged nor set to auto-merge is set — GitLab merges it
# once its pipeline passes and its approvals are in, never before (`glab mr
# merge --auto-merge`, or its API for a planned one; gh's auto-merge with a
# merge commit on GitHub). One whose dependencies have not all merged waits
# (ASS-81): set now, it would merge into its dependency's branch. Team Code
# Review's check counts it as needing nothing meanwhile (ASS-351) and, once
# the dependency has merged, sees it unset and runs this again. Prints { "iid",
# "auto-merge": true } for each one set or set already. The first refused
# stops it, failing, before any later one; a re-run resumes. Fails when the
# variation has no merge request, or the project, ticket or variation is
# missing.
#
# --only <ids> (ASS-365: engines/grouped-merge, the merge loop; ids
# comma-separated, or - for every one; merge_request_options,
# merge-requests.bash) sets the set's alone, the same way — every merge
# request is still read, and one outside the set still counts as a
# dependency — and tells the operator "Auto-merge set on acme/api !12;
# waiting for it to merge" (loop_feedback). Fails, setting nothing, on an id
# the variation has not planned. Without it, every Open one as before.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

USAGE="merge-request:ensure-auto-merge <project> <ticket-key> <variation> [--only <ids>]"
[[ $# -ge 3 ]] || { echo "usage: $USAGE" >&2; exit 1; }
command=merge-request:ensure-auto-merge project="$1" key="$(upper "$2")" variation="$3"
merge_request_options "$command" "$USAGE" "${@:4}"
# The set's ids checked against the plan as recorded, before the forge is read or anything retargeted (ASS-365).
if [[ "$LOOP" == true ]]; then MRS="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")"; only_checked "$command" "$key" "$variation"; fi
refresh_merge_requests "$command" "$project" "$key" "$variation"
armed=()
for i in $(jq -r --argjson only "$ONLY" "$MR_ONLY$(in_order)"' | .[] as $i | $all[$i] | select(.status == "Open" and .key != null and in_set($only)
    and all(.["depends-on"][]?; . as $d | all($all[]; .id != $d or (.status | IN("Merged", "Closed"))))) | $i' <<< "$MRS"); do
  name="$(mr_name "$i")" iid="$(mr_iid_at "$i")"
  if [[ "$(jq -r ".[$i][\"auto-merge\"]" <<< "$VIEWS")" != true ]]; then
    mr_auto_merge "$command" "$i" || { echo "$command: could not set $name to auto-merge" >&2; exit 1; }
  fi
  armed+=("$i")
  jq -nc --argjson iid "$iid" '{ iid: $iid, "auto-merge": true }'
done
if [[ "$LOOP" == true && ${#armed[@]} -gt 0 ]]; then
  said="$(jq -c --argjson at "$(printf '%s\n' "${armed[@]}" | jq -sc .)" "$MR_LABEL"'
    [$at[] as $i | .[$i]] | { short: ("Auto-merge set on " + (map(mr_label) | join(", ")) + "; waiting for " + (if length > 1 then "them" else "it" end) + " to merge"),
      long: ("Auto-merge set on " + (map(mr_label + (if .url then " " + .url else "" end)) | join(", ")) + "; waiting for " + (if length > 1 then "them" else "it" end)
        + " to merge. The forge merges once the pipeline passes and the approvals are in.") }' <<< "$MRS")"
  loop_feedback "$command" "$project" "$key" "$variation" "$(jq -r .short <<< "$said")" "$(jq -r .long <<< "$said")"
fi
