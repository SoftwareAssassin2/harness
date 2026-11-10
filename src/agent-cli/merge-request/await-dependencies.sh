#!/usr/bin/env bash
# Description: Wait until every merge request the ticket's merge requests depend on in another repository is merged — merge-request:await-dependencies <project> <ticket-key> <variation>.
set -euo pipefail

# Build's gate before its tests (ASS-335; grouped-build's Await Dependencies
# in Other Repositories, a timer step whose waiting exit is 2). A planned
# merge request depending on one in its own repository is stacked on that
# one's branch (refresh_merge_requests, merge-requests.bash), so its tests
# see the change; one depending on a merge request in another repository is
# not — its tests run against what that repository has published, which
# lacks the change (an image, a package) until the dependency merges and its
# pipeline publishes it. Tested before then, they fail on nothing Generate
# Solution can fix, and the ticket loops between Automated Testing and
# Generate Solution.
#
# So: each merge request not Closed or Merged whose depends-on names one in
# another repository that is neither Merged nor Closed (Closed: control's
# "nothing to wait for", as for a base; MR_DEPS's unmerged_deps, which
# merge-request:check shares) is waiting. With none recorded, it
# passes at once, asking no forge (most tickets: no merge request depends on
# another repository's). Otherwise every one is read from its forge first
# (refresh_merge_requests: statuses recorded, bases retargeted) and the
# question asked again. Prints { waiting: [{ id, repository, "depends-on":
# { id, repository, status, key, url } }] } and exits 0 when none waits, 2
# (the step's waiting-exit-code: polled again on its timer, no failure)
# while one does; any other failure — the ticket or variation missing, a
# forge call failing — exits 1, matching no exit, so the step tries again.
#
# It waits for the merge only: a dependency whose repository publishes on a
# later pipeline (a promotion after the merge) may still be publishing when
# the tests run.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 3 ]] || { echo "usage: merge-request:await-dependencies <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"

WAITING="$MR_DEPS"'
  . as $all
  | { waiting: [ $all[] | select(.id != null and (done | not)) as $m
      | $m | unmerged_deps($all)[]
      | select(.repository != $m.repository)
      | { id: $m.id, repository: $m.repository, "depends-on": { id, repository, status, key, url } } ] }'

MRS="$(variation_field '.["merge-request"] // []' merge-request:await-dependencies "$project" "$key" "$variation")"
if jq -e "$WAITING"' | .waiting != []' <<< "$MRS" >/dev/null; then
  refresh_merge_requests merge-request:await-dependencies "$project" "$key" "$variation"
fi
out="$(jq -c "$WAITING" <<< "$MRS")"
echo "$out"
[[ "$(jq '.waiting | length' <<< "$out")" -eq 0 ]] || exit 2
