#!/usr/bin/env bash
# Description: Whether the ticket's merge requests passed Code Review and Security Review at their head commits, or mark them so — merge-request:reviewed-at-head <project> <ticket-key> <variation> [--only <ids>] [--mark].
set -euo pipefail

# The merge loop's review gate (ASS-365: engines/grouped-merge's Check
# Reviewed at Head and Mark Reviewed). A merge request leaves draft and is set
# to auto-merge only once the harness's own Code Review and Security Review
# have passed for the variation with that merge request at its current head
# commit; a commit pushed since — by the loop's Address Merge Request
# Feedback, say — needs them again. The heads are kept on the merge request's
# row: review-head, the head a review about to run sees, and reviewed-head,
# the head the last passing review saw.
#
# Without --mark: each Open one of the set (--only <ids>, comma-separated, or
# - for every one; merge_request_options, merge-requests.bash; every Open one
# without it) has its head read from its forge (mr_head). One whose head is
# its reviewed-head is reviewed. Any other gets that head as its review-head,
# for the review that follows. Prints { reviewed: [{ id, key, head }],
# unreviewed: [{ id, key, head }] }. With any unreviewed, the operator is told
# so (loop_feedback), and it exits 2, grouped-merge's way to Code Review.
# None unreviewed (a set merged or closed already among them) exits 0.
#
# --mark, once Code Review and Security Review have passed: each Open one of
# the set with a review-head gets it as its reviewed-head, with no forge
# call: what was reviewed is the head read before the review, so a commit
# pushed during it is not counted as reviewed, and the gate, asked again,
# sends it back to review. Prints { marked: [{ id, key, head }] }, exit 0.
#
# Exits 1 on any other failure — the ticket or variation missing, an id not
# planned, a forge call failing — never 2, so it is never read as unreviewed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
set -E
trap 'exit 1' ERR

USAGE="merge-request:reviewed-at-head <project> <ticket-key> <variation> [--only <ids>] [--mark]"
[[ $# -ge 3 ]] || { echo "usage: $USAGE" >&2; exit 1; }
command=merge-request:reviewed-at-head project="$1" key="$(upper "$2")" variation="$3"
merge_request_options "$command" "$USAGE" "${@:4}"
load_merge_requests "$command" "$project" "$key" "$variation"
only_checked "$command" "$key" "$variation"
open="$(jq -r --argjson only "$ONLY" "$MR_ONLY"'to_entries[] | select(.value.status == "Open" and .value.key != null and (.value | in_set($only))) | .key' <<< "$MRS")"

if [[ "$MARK" == true ]]; then
  marked='[]'
  for i in $open; do
    head="$(jq -r --argjson i "$i" '.[$i]["review-head"] // empty' <<< "$MRS")"
    [[ -n "$head" ]] || continue
    set_merge_request "$command" "$project" "$key" "$variation" "$i" "$(jq -nc --arg h "$head" '{ "reviewed-head": $h }')"
    marked="$(jq -c --argjson i "$i" --arg h "$head" --argjson mrs "$MRS" '. + [{ id: $mrs[$i].id, key: $mrs[$i].key, head: $h }]' <<< "$marked")"
  done
  jq -nc --argjson marked "$marked" '{ marked: $marked }'
  exit 0
fi

reviewed='[]' unreviewed='[]'
for i in $open; do
  head="$(mr_head "$command" "$i")"
  entry="$(jq -c --argjson i "$i" --arg h "$head" '.[$i] | { id, key, head: $h }' <<< "$MRS")"
  if [[ "$(jq -r --argjson i "$i" '.[$i]["reviewed-head"] // empty' <<< "$MRS")" == "$head" ]]; then
    reviewed="$(jq -c --argjson e "$entry" '. + [$e]' <<< "$reviewed")"
    continue
  fi
  [[ "$(jq -r --argjson i "$i" '.[$i]["review-head"] // empty' <<< "$MRS")" == "$head" ]] \
    || set_merge_request "$command" "$project" "$key" "$variation" "$i" "$(jq -nc --arg h "$head" '{ "review-head": $h }')"
  unreviewed="$(jq -c --argjson e "$entry" '. + [$e]' <<< "$unreviewed")"
done
jq -nc --argjson reviewed "$reviewed" --argjson unreviewed "$unreviewed" '{ reviewed: $reviewed, unreviewed: $unreviewed }'
[[ "$unreviewed" != '[]' ]] || exit 0

said="$(jq -c --argjson unreviewed "$unreviewed" "$MR_LABEL"'
  [$unreviewed[] as $u | first(.[] | select(.id == $u.id)) + { head: $u.head }]
  | (map(mr_label + " at " + .head[0:8]) | join(", ")) as $at
  | { short: ("Reviewing " + $at + " before it leaves draft or is set to auto-merge"),
      long: ("Code Review and Security Review run again for " + $at + ": a merge request leaves draft and is set to auto-merge only once both have passed at its head commit.") }' <<< "$MRS")"
loop_feedback "$command" "$project" "$key" "$variation" "$(jq -r .short <<< "$said")" "$(jq -r .long <<< "$said")"
exit 2
