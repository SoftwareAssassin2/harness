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
# it needs a rebase or is behind its base). auto-merge: Ensure Auto-Merge has
# nothing to set now — every one not Closed is Merged, set to merge when its
# checks pass, or Open and waiting on a depends-on neither Merged nor Closed
# (MR_DEPS's unmerged_deps; Ensure Auto-Merge sets it only once those merge,
# ASS-351), so Team Code Review's timer keeps polling, spending no visit,
# while the group waits for approvals. Once a dependency merges, one it
# unblocks that is not set yet makes it false again, and Ensure Auto-Merge
# runs once to set it. merged: every one not Closed is Merged. A merged one
# needs nothing and counts as auto-merged.
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
# The wait for approvals is bounded (ASS-351). An Open one set to auto-merge
# with no reason of its own (a held-back pipeline aside) records when it was
# first seen so, as approval-wait-since on its row; one seen otherwise has it
# cleared, so a real problem, or GitLab cancelling auto-merge, restarts it.
# Its wait counts from the later of that and the variation's last move at its
# own level (a Release entered afresh, or resumed from Blocked for Human,
# waits afresh). Once the whole group is only waiting (needs-attention false,
# auto-merge true, merged false) and any one has waited harness.json's
# approval-wait-days or more (3 by default; any number above 0, a part of a
# day too; one that is not is said on stderr and 3 used), the check adds:
#
#   "approval-wait-expired": true,
#   "awaiting-approval": [{ "id", "key", "url", "since" }],   # those past the bound
#   "ai-feedback-short": "Waited over 3 days for approval: MR 1 (!7)",
#   "ai-feedback-long": "…each with its url and since, those waiting on others, and what to do"
#
# for Team Code Review's approval-wait-expired exit to end the Release at
# Blocked for Human, the feedback becoming the variation's (steps.js, with
# record-script-output on the step; engines/grouped-engines.md).
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

# The approval wait (ASS-351): each Open one set to auto-merge with nothing of its own to act on has
# waited since its approval-wait-since, recorded the first time it is seen so and cleared once it is not.
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
while IFS=$'\t' read -r i since; do
  set_merge_request "$command" "$project" "$key" "$variation" "$i" "{\"approval-wait-since\": $since}"
done < <(jq -r --argjson views "$VIEWS" --argjson pending "$pending" --arg now "$now" '
  . as $all
  | range(length) as $i | $all[$i] as $m | $views[$i] as $v
  | select($m.status == "Open" and $v != null)
  | ($v["auto-merge"] == true and ([$v.reasons[] | select(. != "build-failed" or (any($pending[]; .i == $i) | not))] == [])) as $waits
  | if $waits and $m["approval-wait-since"] == null then [$i, ($now | tojson)]
    elif ($waits | not) and $m["approval-wait-since"] != null then [$i, "null"]
    else empty end
  | @tsv' <<< "$MRS")
# Its bound: harness.json's approval-wait-days, 3 by default; counted from the later of that and the variation's
# last move at its own level (a new Release, or one resumed from Blocked for Human, waits afresh).
days="$(jq -r '.["approval-wait-days"] // 3 | if type == "number" and . > 0 then . else "bad" end' "${HARNESS_FILE:-$projects/../harness.json}" 2>/dev/null || echo 3)"
[[ "$days" != bad ]] || { echo "$command: harness.json's approval-wait-days must be a positive number of days; 3 used" >&2; days=3; }
entered="$(variation_field '[.["state-changes"] // [] | .[] | select(.["sub-state-change"] == null) | .timestamp // empty] | last' "$command" "$project" "$key" "$variation")"

jq -nc --argjson mrs "$MRS" --argjson views "$VIEWS" --argjson pending "$pending" --arg now "$now" --argjson days "$days" --argjson entered "$entered" "$MR_DEPS$MR_TIME"'
  def name: if .id then "MR \(.id) (\(.key))" else .key end;
  [range($mrs | length) as $i | { m: $mrs[$i], v: $views[$i], held: any($pending[]; .i == $i) } | select(.m.status != "Closed")] as $live
  | [$live[] | select(.m.status == "Open") | .held as $held | .v.reasons[] | select(($held and . == "build-failed") | not)] as $all
  | ["open-threads", "build-failed", "needs-rebase"] | map(select(IN($all[]))) as $reasons
  | ($live != [] and all($live[]; .m.status == "Merged" or (.m.status == "Open" and (.v["auto-merge"] == true or (.m | unmerged_deps($mrs)) != [])))) as $auto
  | ($live != [] and all($live[]; .m.status == "Merged")) as $merged
  # Each Open one set to auto-merge that has waited past the bound, when the whole group is only waiting.
  | ($now | epoch) as $at
  | [if $reasons == [] and $auto and ($merged | not) then
       $live[] | select(.m.status == "Open" and .v["auto-merge"] == true and .m["approval-wait-since"] != null)
       | ([.m["approval-wait-since"], $entered] | map(select(. != null) | epoch) | max) as $since
       | select($at - $since >= $days * 86400)
       | { id: .m.id, key: .m.key, url: .m.url, since: .m["approval-wait-since"] }
     else empty end] as $expired
  | ($expired | map(name) | join(", ")) as $names
  | (if $days == 1 then "1 day" else "\($days) days" end) as $bound
  | { "needs-attention": ($reasons | length > 0), reasons: $reasons, "auto-merge": $auto, merged: $merged }
  + (if $pending == [] then {} else { "build-pending": [$pending[] | { id, key, why }] } end)
  + (if $expired == [] then {} else {
      "approval-wait-expired": true, "awaiting-approval": $expired,
      "ai-feedback-short": "Waited over \($bound) for approval: \($names)",
      "ai-feedback-long": ("Set to auto-merge with nothing for an agent to do, these merge requests have not merged within \($bound) (harness.json approval-wait-days): "
        + ([$expired[] | "\(name)\(if .url then " \(.url)" else "" end), waiting since \(.since)"] | join("; ")) + ". "
        + ([$live[] | select(.m.status == "Open" and (.m | unmerged_deps($mrs)) != []) | .m | name] | if . == [] then "" else "Waiting for those before them to merge: \(join(", ")). " end)
        + "They need a reviewer'"'"'s approval, or their pipeline to pass, on the forge. Once they have it, choose Resolved: the wait starts again.") } end)'
