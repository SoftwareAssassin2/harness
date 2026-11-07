#!/usr/bin/env bash
# Description: Merge the ticket's pull requests itself, in depends-on order, confirming each merged — merge-request:merge <project> <ticket-key> <variation>.
set -euo pipefail

# For the harness's own repository (GitHub), whose development engine merges
# its own pull requests with no team review. The whole variation (ASS-81):
# control reads every merge request (refresh_merge_requests,
# merge-requests.bash), which retargets a dependent to master once its
# dependency has merged; then the first Open one in depends-on order is
# marked ready (`gh pr ready`), merged with a merge commit and its branch
# deleted (`gh pr merge --merge --delete-branch`), read back, and recorded
# Merged by id — and so on until none is Open. GitHub lets no author approve
# their own pull request, so the merge is the approval. Prints
# { "iid", "merged": true } for each one merged. The first that cannot merge
# (a conflict, a failed required check, a merge error) or is not merged
# afterwards stops it, failing: those merged before stay Merged, and a re-run
# resumes from the first unmerged. Fails, merging nothing, when the
# variation has no merge request (a fast-tracked ticket's none passes, ASS-151:
# load_merge_requests) or one is not on GitHub; or the project,
# ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 3 ]] || { echo "usage: merge-request:merge <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
load_merge_requests merge-request:merge "$project" "$key" "$variation"
stranger="$(jq -r 'first(.[] | select(startswith("https://github.com/") | not)) // empty' <<< "$URLS")"
[[ -z "$stranger" ]] || { echo "merge-request:merge: merges GitHub pull requests only; $stranger is not on GitHub" >&2; exit 1; }
while :; do
  refresh_merge_requests merge-request:merge "$project" "$key" "$variation"
  i="$(jq -r "$(in_order) | first(.[] as \$i | select(\$all[\$i].status == \"Open\" and \$all[\$i].key != null) | \$i) // empty" <<< "$MRS")"
  [[ -n "$i" ]] || break
  name="$(mr_name "$i")" iid="$(mr_iid_at "$i")"
  repo="$(path_of "$(jq -r ".[$i]" <<< "$URLS")")"
  gh_run merge-request:merge pr ready "$iid" --repo "$repo" >/dev/null 2>&1 || true   # already ready is fine
  out="$(gh_run merge-request:merge pr merge "$iid" --repo "$repo" --merge --delete-branch 2>&1)" || { echo "merge-request:merge: could not merge $name: $out" >&2; exit 1; }
  view="$(mr_view merge-request:merge "$i")"
  [[ "$(jq -r .state <<< "$view")" == Merged ]] || { echo "merge-request:merge: $name is $(jq -r .state <<< "$view"), not merged" >&2; exit 1; }
  set_merge_request merge-request:merge "$project" "$key" "$variation" "$i" '{ "status": "Merged" }'
  jq -nc --argjson iid "$iid" '{ iid: $iid, merged: true }'
done
