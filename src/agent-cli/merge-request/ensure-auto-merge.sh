#!/usr/bin/env bash
# Description: Set the ticket's merge requests to merge once their checks pass, in depends-on order — merge-request:ensure-auto-merge <project> <ticket-key> <variation>.
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
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 3 ]] || { echo "usage: merge-request:ensure-auto-merge <project> <ticket-key> <variation>" >&2; exit 1; }
refresh_merge_requests merge-request:ensure-auto-merge "$1" "$(upper "$2")" "$3"
for i in $(jq -r "$(in_order) | .[] as \$i | \$all[\$i] | select(.status == \"Open\" and .key != null
    and all(.[\"depends-on\"][]?; . as \$d | all(\$all[]; .id != \$d or (.status | IN(\"Merged\", \"Closed\"))))) | \$i" <<< "$MRS"); do
  name="$(mr_name "$i")" iid="$(mr_iid_at "$i")"
  if [[ "$(jq -r ".[$i][\"auto-merge\"]" <<< "$VIEWS")" != true ]]; then
    mr_auto_merge merge-request:ensure-auto-merge "$i" || { echo "merge-request:ensure-auto-merge: could not set $name to auto-merge" >&2; exit 1; }
  fi
  jq -nc --argjson iid "$iid" '{ iid: $iid, "auto-merge": true }'
done
