#!/usr/bin/env bash
# Description: Mark the ticket's merge requests ready for review — code:take-out-of-draft-mode <project> <ticket-key> <variation> [--only <ids>].
set -euo pipefail

# Every one of the variation's merge requests recorded Open (!<iid> or
# #<number>; see merge-request:create, merge-requests.bash) taken out of
# draft — glab `mr update --ready` (through GitLab's API for a planned one,
# ASS-81: "Draft:" dropped from its title), or for GitHub gh `pr ready` (GLAB_DISABLED /
# GH_DISABLED=1 only say what they would run). Prints { "iid", "ready": true }
# for each. Fails when the variation has no merge request, glab fails, or the
# project, ticket or variation is missing. Changes nothing locally.
#
# --only <ids> (ASS-365: engines/grouped-merge, the merge loop; ids
# comma-separated, or - for every one; merge_request_options,
# merge-requests.bash) readies the set's Open ones alone, and tells the
# operator "Taking acme/api !12 out of draft" for each still a draft, as its
# forge says (loop_feedback). Fails, changing nothing, on an id the variation
# has not planned. Without it, every Open one as before.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

USAGE="code:take-out-of-draft-mode <project> <ticket-key> <variation> [--only <ids>]"
[[ $# -ge 3 ]] || { echo "usage: $USAGE" >&2; exit 1; }
command=code:take-out-of-draft-mode project="$1" key="$(upper "$2")" variation="$3"
merge_request_options "$command" "$USAGE" "${@:4}"
load_merge_requests "$command" "$project" "$key" "$variation"
only_checked "$command" "$key" "$variation"
open="$(jq -r --argjson only "$ONLY" "$MR_ONLY"'to_entries[] | select(.value.status == "Open" and .value.key != null and (.value | in_set($only))) | .key' <<< "$MRS")"
if [[ "$LOOP" == true ]]; then
  # The set's drafts, as their forge says, named for the operator before they are readied.
  drafts=()
  for i in $open; do
    if [[ "$(mr_view "$command" "$i" | jq -r '.draft')" == true ]]; then drafts+=("$i"); fi
  done
  if [[ ${#drafts[@]} -gt 0 ]]; then
    said="$(jq -c --argjson at "$(printf '%s\n' "${drafts[@]}" | jq -sc .)" "$MR_LABEL"'
      [$at[] as $i | .[$i]] | { short: ("Taking " + (map(mr_label) | join(", ")) + " out of draft"),
        long: ("Taking " + (map(mr_label + (if .url then " " + .url else "" end)) | join(", ")) + " out of draft, so its reviewers can approve it; it is set to auto-merge once nothing blocks it.") }' <<< "$MRS")"
    loop_feedback "$command" "$project" "$key" "$variation" "$(jq -r .short <<< "$said")" "$(jq -r .long <<< "$said")"
  fi
fi
for i in $open; do
  mr_ready "$command" "$i"
  jq -nc --argjson iid "$(jq -r ".[$i].key | ltrimstr(\"!\") | ltrimstr(\"#\")" <<< "$MRS")" '{ iid: $iid, ready: true }'
done
