#!/usr/bin/env bash
# Description: Read the ticket's merge requests from their forges and report whether they need an agent — merge-request:check <project> <ticket-key> <variation>.
set -euo pipefail

# Deterministic: control's read of every one of the variation's merge
# requests (refresh_merge_requests, merge-requests.bash), recording each
# one's live status and base by id (ASS-81). Run on a timer during Team Code
# Review, so an agent starts only when there is something to act on, and by
# Generate Solution before it works on each planned merge request. Prints one
# JSON object over the Open ones:
#
#   { "needs-attention": <any reason>, "reasons": [...], "auto-merge": <bool>, "merged": <bool> }
#
# reasons, in this order: "open-threads" (blocking discussions unresolved;
# on GitHub, changes requested), "build-failed" (its head pipeline failed or
# was canceled; a failed check), "needs-rebase" (conflicts, or the forge says
# it needs a rebase or is behind its base). auto-merge: every one not Closed
# is Merged or set to merge when its checks pass. merged: every one not
# Closed is Merged. A merged one needs nothing and counts as auto-merged.
#
# A failed pipeline that only reflects a dependency is held back (ASS-346):
#   - one whose depends-on names a merge request, in its repository or
#     another, neither Merged nor Closed (MR_DEPS's unmerged_deps, shared
#     with merge-request:await-dependencies) is not build-failed: its CI may
#     read the dependency's repository as it is without the change, which
#     nothing on its branch can fix. Its open threads and needs-rebase are
#     still reasons. Ensure Auto-Merge sets its dependencies to merge first;
#   - once all have merged, a failed pipeline that started before the latest
#     of them merged (the forge's merged-at against the pipeline's created-at;
#     on GitHub, the latest start of a failed check) is started again
#     (mr_rerun: on GitLab a new merge request pipeline, else its failed jobs
#     retried; on GitHub its failed workflow runs re-run) and is not
#     build-failed while it runs. Once per dependency merge: that merge's time
#     is recorded on the row ("pipeline-rerun"), and a pipeline that started
#     after it, or one re-run for it already, that fails is build-failed, so a
#     merge request broken in itself cannot loop. One that cannot be started
#     again is build-failed.
# Each one held back is listed, only when there is one:
#
#   "build-pending": [{ "id", "key", "why": "dependency-unmerged" | "re-run" }]
#
# Exits 0 when the check ran, whatever it found; fails when the variation has
# no merge request (but a fast-tracked ticket, ASS-151), a forge call fails, or the project, ticket or variation
# is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 3 ]] || { echo "usage: merge-request:check <project> <ticket-key> <variation>" >&2; exit 1; }
command=merge-request:check project="$1" key="$(upper "$2")" variation="$3"
refresh_merge_requests "$command" "$project" "$key" "$variation"

# Each Open one whose pipeline failed and that is held back: { i, why, merged } (merged: its latest dependency's merge, in seconds).
held="$(jq -c --argjson views "$VIEWS" "$MR_DEPS$MR_TIME"'
  . as $all
  | [range(length) as $i | $all[$i] as $m | $views[$i] as $v
     | select($m.status == "Open" and $v != null and any($v.reasons[]; . == "build-failed"))
     | ([range($all | length) as $j | select($all[$j].status == "Merged" and ($all[$j].id as $id | $id != null and any($m["depends-on"][]?; . == $id)))
         | $views[$j]["merged-at"] // empty | epoch] | max) as $merged
     | ($v.pipeline["created-at"] // null | if . then epoch else null end) as $started
     | if ($m | unmerged_deps($all)) != [] then { i: $i, why: "dependency-unmerged" }
       elif $merged != null and $started != null and $started < $merged and $m["pipeline-rerun"] != $merged then { i: $i, why: "re-run", merged: $merged }
       else empty end]' <<< "$MRS")"

# Each to re-run started again and recorded, so it is not re-run again for the same merge; one that cannot be stays build-failed.
pending='[]'
while IFS=$'\t' read -r i why merged; do
  if [[ "$why" == re-run ]]; then
    mr_rerun "$command" "$i" "$(jq -c ".[$i]" <<< "$VIEWS")" || { echo "$command: could not start $(mr_name "$i")'s failed pipeline again" >&2; continue; }
    set_merge_request "$command" "$project" "$key" "$variation" "$i" "{\"pipeline-rerun\": $merged}"
  fi
  pending="$(jq -c --argjson i "$i" --arg why "$why" --argjson mrs "$MRS" '. + [{ i: $i, id: $mrs[$i].id, key: $mrs[$i].key, why: $why }]' <<< "$pending")"
done < <(jq -r '.[] | [.i, .why, (.merged // "")] | @tsv' <<< "$held")

jq -nc --argjson mrs "$MRS" --argjson views "$VIEWS" --argjson pending "$pending" '
  [range($mrs | length) as $i | { m: $mrs[$i], v: $views[$i], held: any($pending[]; .i == $i) } | select(.m.status != "Closed")] as $live
  | [$live[] | select(.m.status == "Open") | .held as $held | .v.reasons[] | select(($held and . == "build-failed") | not)] as $all
  | ["open-threads", "build-failed", "needs-rebase"] | map(select(IN($all[]))) as $reasons
  | { "needs-attention": ($reasons | length > 0), reasons: $reasons,
      "auto-merge": ($live != [] and all($live[]; .m.status == "Merged" or (.m.status == "Open" and .v["auto-merge"]))),
      merged: ($live != [] and all($live[]; .m.status == "Merged")) }
  + (if $pending == [] then {} else { "build-pending": [$pending[] | { id, key, why }] } end)'
