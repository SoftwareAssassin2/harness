#!/usr/bin/env bash
# Description: Read the ticket's merge requests from their forges and report whether they need an agent — merge-request:check <project> <ticket-key> <variation> [--only <ids>].
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
# --only <ids> (ASS-365: engines/grouped-merge, the merge loop; ids
# comma-separated, or - for every one; merge_request_options,
# merge-requests.bash) reports over the set alone: every merge request is
# still read and recorded, and one outside the set still counts as a
# dependency, but needs-attention, reasons, auto-merge, merged, build-pending,
# the approval wait and its expiry are the set's, and a pipeline outside it
# is never re-run. A reviewer's plain comment not yet answered
# (mr_review_comments, ASS-361) is a reason too, "review-comments" after
# "open-threads", and stops an approval wait, so the loop's Address Merge
# Request Feedback acts on it. And it tells the operator what the set waits
# for (loop_feedback): "<repo> <key>: it has unresolved review threads; sent
# to Address Merge Request Feedback", "acme/api !12 waits for 1 approval since
# <time>" (approvals left asked of the forge, mr_approvals_left), "Auto-merge
# set on acme/api !12; waiting for it to merge", "<repo> <key> waits for
# <repo> <key> to merge first"; cleared once the set has merged; an expired
# wait's feedback is the output's, as without it. merged is true once every
# one of the set is Merged or Closed, a set all Closed too, so the loop ends.
# Fails on an id the variation has not planned. Without --only, all as before.
#
# Exits 0 when the check ran, whatever it found; fails when the variation has
# no merge request (but a fast-tracked ticket, ASS-151), a forge call fails, or the project, ticket or variation
# is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

USAGE="merge-request:check <project> <ticket-key> <variation> [--only <ids>]"
[[ $# -ge 3 ]] || { echo "usage: $USAGE" >&2; exit 1; }
command=merge-request:check project="$1" key="$(upper "$2")" variation="$3"
merge_request_options "$command" "$USAGE" "${@:4}"
# The set's ids checked against the plan as recorded, before the forge is read or anything retargeted (ASS-365).
if [[ "$LOOP" == true ]]; then MRS="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")"; only_checked "$command" "$key" "$variation"; fi
refresh_merge_requests "$command" "$project" "$key" "$variation"

# The set's plain review comments not yet answered, by index ({ "<i>": <count> }): asked only with --only (ASS-365).
comments='{}'
if [[ "$LOOP" == true ]]; then
  for i in $(jq -r --argjson only "$ONLY" "$MR_ONLY"'to_entries[] | select(.value.status == "Open" and .value.key != null and (.value | in_set($only))) | .key' <<< "$MRS"); do
    comments="$(jq -c --arg i "$i" --argjson n "$(mr_review_comments "$command" "$i" "$project" | jq length)" 'if $n > 0 then .[$i] = $n else . end' <<< "$comments")"
  done
fi

# Each Open one whose pipeline failed and that is held back: { i, why, merged } (merged: its latest dependency's merge, in seconds).
held="$(jq -c --argjson views "$VIEWS" --argjson only "$ONLY" "$MR_DEPS$MR_TIME$MR_ONLY"'
  . as $all
  | [range(length) as $i | $all[$i] as $m | $views[$i] as $v
     | select($m.status == "Open" and ($m | in_set($only)) and $v != null and any($v.reasons[]; . == "build-failed"))
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
done < <(jq -r --argjson views "$VIEWS" --argjson pending "$pending" --arg now "$now" --argjson only "$ONLY" --argjson comments "$comments" "$MR_ONLY"'
  . as $all
  | range(length) as $i | $all[$i] as $m | $views[$i] as $v
  | select($m.status == "Open" and ($m | in_set($only)) and $v != null)
  | ($v["auto-merge"] == true and ([$v.reasons[] | select(. != "build-failed" or (any($pending[]; .i == $i) | not))] == []) and $comments[$i | tostring] == null) as $waits
  | if $waits and $m["approval-wait-since"] == null then [$i, ($now | tojson)]
    elif ($waits | not) and $m["approval-wait-since"] != null then [$i, "null"]
    else empty end
  | @tsv' <<< "$MRS")
# Its bound: harness.json's approval-wait-days, 3 by default; counted from the later of that and the variation's
# last move at its own level (a new Release, or one resumed from Blocked for Human, waits afresh).
days="$(jq -r '.["approval-wait-days"] // 3 | if type == "number" and . > 0 then . else "bad" end' "${HARNESS_FILE:-$projects/../harness.json}" 2>/dev/null || echo 3)"
[[ "$days" != bad ]] || { echo "$command: harness.json's approval-wait-days must be a positive number of days; 3 used" >&2; days=3; }
entered="$(variation_field '[.["state-changes"] // [] | .[] | select(.["sub-state-change"] == null) | .timestamp // empty] | last' "$command" "$project" "$key" "$variation")"

result="$(jq -nc --argjson mrs "$MRS" --argjson views "$VIEWS" --argjson pending "$pending" --arg now "$now" --argjson days "$days" --argjson entered "$entered" \
  --argjson only "$ONLY" --argjson comments "$comments" --argjson loop "$LOOP" "$MR_DEPS$MR_TIME$MR_ONLY"'
  def name: if .id then "MR \(.id) (\(.key))" else .key end;
  [range($mrs | length) as $i | { i: $i, m: $mrs[$i], v: $views[$i], held: any($pending[]; .i == $i) } | select(.m.status != "Closed" and (.m | in_set($only)))] as $live
  | [$live[] | select(.m.status == "Open") | .held as $held | (.v.reasons[] | select(($held and . == "build-failed") | not)), (if $comments[.i | tostring] then "review-comments" else empty end)] as $all
  | ["open-threads", "review-comments", "build-failed", "needs-rebase"] | map(select(IN($all[]))) as $reasons
  | ($live != [] and all($live[]; .m.status == "Merged" or (.m.status == "Open" and (.v["auto-merge"] == true or (.m | unmerged_deps($mrs)) != [])))) as $auto
  | (($live != [] or $loop) and all($live[]; .m.status == "Merged")) as $merged
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
        + "They need a reviewer'"'"'s approval, or their pipeline to pass, on the forge. Once they have it, choose Resolved: the wait starts again.") } end)')"
echo "$result"
[[ "$LOOP" == true ]] || exit 0

# The merge loop's word to the operator (ASS-365): what the set waits for, from this check alone; cleared once it has merged.
if jq -e '.merged' <<< "$result" >/dev/null; then loop_feedback "$command" "$project" "$key" "$variation" "" ""; exit 0; fi
jq -e '.["approval-wait-expired"] != true' <<< "$result" >/dev/null || exit 0
# Approvals left, asked only of the set's ones set to auto-merge with nothing of their own to act on: { "<i>": <left> }.
approvals='{}'
while read -r i; do
  approvals="$(jq -c --arg i "$i" --arg left "$(mr_approvals_left "$command" "$i" "$(jq -c ".[$i]" <<< "$VIEWS")")" '.[$i] = $left' <<< "$approvals")"
done < <(jq -r --argjson views "$VIEWS" --argjson only "$ONLY" --argjson comments "$comments" --argjson pending "$pending" "$MR_ONLY"'
  range(length) as $i | .[$i] as $m | $views[$i] as $v
  | select($m.status == "Open" and $m.key != null and ($m | in_set($only)) and $v != null and $v["auto-merge"] == true and $comments[$i | tostring] == null
      and ([$v.reasons[] | select(. != "build-failed" or (any($pending[]; .i == $i) | not))] == [])) | $i' <<< "$MRS")
said="$(jq -c --argjson views "$VIEWS" --argjson only "$ONLY" --argjson comments "$comments" --argjson pending "$pending" --argjson approvals "$approvals" "$MR_DEPS$MR_ONLY$MR_LABEL"'
  . as $all
  | def words: { "open-threads": "it has unresolved review threads", "review-comments": "it has review comments not yet answered",
      "build-failed": "its pipeline failed", "needs-rebase": "it needs a rebase onto its target branch" }[.];
    def approvals($n): if $n == "unknown" then "approval" elif $n == "1" then "1 approval" else $n + " approvals" end;
    [range(length) as $i | $all[$i] as $m | $views[$i] as $v | select($m.status == "Open" and ($m | in_set($only)) and $v != null)
     | ([($v.reasons[] | select(. != "build-failed" or (any($pending[]; .i == $i) | not))), (if $comments[$i | tostring] then "review-comments" else empty end)]
        | ["open-threads", "review-comments", "build-failed", "needs-rebase"] - (["open-threads", "review-comments", "build-failed", "needs-rebase"] - .)) as $own
     | ($m | mr_label) as $l | ($m | unmerged_deps($all)) as $deps
     | if $own != [] then { act: true, text: ($l + ": " + ($own | map(words) | join(", "))), url: $m.url }
       elif $v["auto-merge"] == true and (($approvals[$i | tostring] // "0") != "0") then
         { text: ($l + " waits for " + approvals($approvals[$i | tostring]) + (if $m["approval-wait-since"] then " since " + $m["approval-wait-since"] else "" end)), url: $m.url }
       elif $v["auto-merge"] == true then { text: ("Auto-merge set on " + $l + "; waiting for it to merge"), url: $m.url }
       elif $deps != [] then { text: ($l + " waits for " + ($deps | map(mr_label) | join(", ")) + " to merge first"), url: $m.url }
       else empty end] as $parts
  | if $parts == [] then null
    elif any($parts[]; .act) then [$parts[] | select(.act)] as $act
      | { short: (($act | map(.text) | join("; ")) + "; sent to Address Merge Request Feedback"),
          long: (($act | map(.text + (if .url then " (" + .url + ")" else "" end)) | join("; ")) + ". Sent to Address Merge Request Feedback, to act on its review and pipeline; then it is reviewed again at its new head commit before auto-merge is set.") }
    else { short: ($parts | map(.text) | join("; ")), long: (($parts | map(.text + (if .url then " (" + .url + ")" else "" end)) | join("; ")) + ".") } end' <<< "$MRS")"
[[ "$said" == null ]] || loop_feedback "$command" "$project" "$key" "$variation" "$(jq -r .short <<< "$said")" "$(jq -r .long <<< "$said")"
