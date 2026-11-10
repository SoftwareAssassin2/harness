#!/usr/bin/env bash
# Description: Wait until every merge request the ticket's merge requests depend on in another repository is merged, saying what each needs — merge-request:await-dependencies <project> <ticket-key> <variation>.
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
# { id, repository, status, key, url }, needs }] }.
#
# needs (ASS-359) says why the dependency is not merging — what a person or
# an agent must do — in this order: "not-created" (planned, never opened),
# "draft", "build-failed" (its head pipeline failed or was canceled; on
# GitHub a failed check), "open-threads" (unresolved blocking threads; on
# GitHub changes requested), "needs-rebase" (conflicts, or behind its
# target), "needs-approval" (approvals still required: GitLab's
# approvals_left, GitHub's review decision); [] when it only waits to be
# merged (set to auto-merge, say). The reasons are mr_view's, as
# merge-request:check reads them; the approvals and the failed jobs' names
# are asked of the forge only for a dependency that waits.
#
# Exits:
#   0  none waits;
#   2  one waits (the step's waiting-exit-code: polled again on its timer,
#      no failure) — needs or none;
#   3  one waits on a dependency that was never created: every dependency
#      here is a planned merge request of this same variation, so it is
#      one Generate Solution never opened (killed before it got there, say)
#      and nothing but Generate Solution will. grouped-build sends exit 3
#      back to Generate Solution, under that step's max-visits, then
#      Blocked. A note in execution-plan-<variation>.md tells it which;
#   1  any other failure — the ticket or variation missing, a forge call
#      failing — matching no exit, so the step tries again.
#
# The operator is told (ASS-359): while any dependency it waits on needs
# something, the variation's ai-feedback-short and -long (as
# ticket:set-ai-feedback writes them; the TUI's Health) name each one by
# repository, key and url and say what it needs in plain words — "acme/api
# !12 (url): is a draft; its pipeline failed (lint); it needs 1 approval".
# The needs last written are kept on the variation as
# awaited-dependency-needs { needs, feedback }, so the feedback is written —
# and said once on stderr, which control's log keeps — only when they
# change (or the feedback was replaced since), not on every poll. Once
# nothing needs action (only waiting to merge, or nothing waiting) the
# feedback is cleared, when it is still the one written here, and the kept
# needs dropped.
#
# It waits for the merge only: a dependency whose repository publishes on a
# later pipeline (a promotion after the merge) may still be publishing when
# the tests run.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
# Any failure exits 1, never a command's own status: jq's 2 or 3 would read as waiting or as never created.
set -E
trap 'exit 1' ERR

[[ $# -eq 3 ]] || { echo "usage: merge-request:await-dependencies <project> <ticket-key> <variation>" >&2; exit 1; }
command=merge-request:await-dependencies project="$1" key="$(upper "$2")" variation="$3"

# Each waiting pair: the dependent's id and repository, the dependency's row ("depends-on") and its index in MRS (at).
WAITING="$MR_DEPS"'
  . as $all
  | [ $all[] | select(.id != null and (done | not)) as $m
      | $m | unmerged_deps($all)[]
      | select(.repository != $m.repository) as $d
      | { id: $m.id, repository: $m.repository, "depends-on": ($d | { id, repository, status, key, url }),
          at: first(range($all | length) as $k | select($all[$k].id == $d.id) | $k) } ]'

# record_feedback <needs-json|null> <short> <long> — the operator's feedback written only when the needs changed.
record_feedback() {
  local needs="$1" short="$2" long="$3" was
  was="$(variation_field '{ kept: .["awaited-dependency-needs"], long: .["ai-feedback-long"] }' "$command" "$project" "$key" "$variation")"
  if [[ "$needs" != null ]]; then
    jq -e --argjson needs "$needs" '.kept != null and .kept.needs == $needs and .long == .kept.feedback' <<< "$was" >/dev/null && return 0
    update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson needs "$needs" --arg short "$short" --arg long "$long" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else
        .["ai-feedback-short"] = $short | .["ai-feedback-long"] = $long | .["awaited-dependency-needs"] = { needs: $needs, feedback: $long } end)'
    echo "$command: $key $variation: $long" >&2
  elif jq -e '.kept != null' <<< "$was" >/dev/null; then
    update_whole_ticket "$command" "$project" "$key" --arg name "$variation" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else
        (if .["ai-feedback-long"] == .["awaited-dependency-needs"].feedback then .["ai-feedback-short"] = null | .["ai-feedback-long"] = null else . end)
        | del(.["awaited-dependency-needs"]) end)'
    echo "$command: $key $variation: no dependency in another repository needs action now" >&2
  fi
}

MRS="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")"
# None waiting, as recorded or once read from the forge: any feedback of this step's cleared, exit 0.
none_waiting() { record_feedback null "" ""; echo '{"waiting":[]}'; exit 0; }
waiting="$(jq -c "$WAITING" <<< "$MRS")"
[[ "$waiting" != '[]' ]] || none_waiting
refresh_merge_requests "$command" "$project" "$key" "$variation"
waiting="$(jq -c "$WAITING" <<< "$MRS")"
[[ "$waiting" != '[]' ]] || none_waiting

# What each dependency waited on needs, by its index: { "<at>": { needs, jobs, approvals } }.
found='{}'
for at in $(jq -r '[.[].at] | unique | .[]' <<< "$waiting"); do
  view="$(jq -c --argjson i "$at" '.[$i]' <<< "$VIEWS")"
  jobs='[]' approvals=0
  if [[ "$(jq -r --argjson i "$at" '.[$i].key // empty' <<< "$MRS")" && "$view" != null ]]; then
    approvals="$(mr_approvals_left "$command" "$at" "$view")"
    if jq -e 'any(.reasons[]; . == "build-failed")' <<< "$view" >/dev/null; then jobs="$(mr_failed_jobs "$command" "$at" "$view")"; fi
  fi
  found="$(jq -c --arg at "$at" --argjson view "$view" --argjson jobs "$jobs" --arg approvals "$approvals" --argjson mrs "$MRS" '
    ($mrs[$at | tonumber]) as $d
    | .[$at] = { jobs: $jobs, approvals: $approvals,
        needs: (if $d.key == null then ["not-created"]
                elif $view == null then []
                else [ (if $view.draft then "draft" else empty end),
                       ("build-failed", "open-threads", "needs-rebase" | select(IN($view.reasons[]))),
                       (if $approvals != "0" then "needs-approval" else empty end) ] end) }' <<< "$found")"
done

out="$(jq -c --argjson found "$found" '{ waiting: map(del(.at) + { needs: $found[.at | tostring].needs }) }' <<< "$waiting")"

# The feedback: each dependency that needs something, named and said in plain words; the needs that changed it.
FEEDBACK='
  def repo: .repository // "" | rtrimstr(".git") | sub("^[a-z]+://[^/]+/"; "");
  def name: if .key then repo + " " + .key else "MR \(.id) (" + repo + ")" end;
  # Each need of a dependency in plain words, with its failed jobs and the approvals it still needs.
  def said: . as $f | [ .needs[] | {
      "not-created": "was never created",
      draft: "is a draft",
      "build-failed": ("its pipeline failed" + (if $f.jobs == [] then "" else " (" + ($f.jobs | join(", ")) + ")" end)),
      "open-threads": "it has unresolved review threads",
      "needs-rebase": "it needs a rebase onto its target branch",
      "needs-approval": (if $f.approvals == "unknown" then "it needs approval" elif $f.approvals == "1" then "it needs 1 approval" else "it needs " + $f.approvals + " approvals" end) }[.] ];
  def about: (.dep | name) + (if .dep.url then " " + .dep.url else "" end) + ": " + (said | join("; ")) + ". "
    + (.by | join(", ")) + (if (.by | length) > 1 then " depend" else " depends" end) + " on it.";
  [ $waiting | group_by(.at)[] | { at: .[0].at, dep: .[0]["depends-on"], by: map("MR \(.id)") }
    | . + $found[.at | tostring] | select(.needs != []) ] as $deps
  | [ $deps[] | select(.needs | index("not-created")) | .dep | name ] as $unmade
  | if $deps == [] then { needs: null, short: "", long: "" } else
      (if $unmade != [] then "Never created: " + ($unmade | join(", ")) + "; back to Generate Solution"
       else "Waiting on " + ([$deps[] | (.dep | name) + ": " + (said | join(", "))] | join("; ")) end) as $short
    | ([$deps[] | about] | join(" ")
       + (if $unmade != [] then " A planned merge request Generate Solution never created is not waited on: the ticket goes back to Generate Solution to create it."
          else " The tests run once it merges: act on it on the forge, and this step goes on by itself." end)) as $long
    | { needs: [$deps[] | { id: .dep.id, key: .dep.key, needs }], short: $short, long: $long } end'
feedback="$(jq -nc --argjson found "$found" --argjson waiting "$waiting" "$FEEDBACK")"

needs="$(jq -c '.needs' <<< "$feedback")"
record_feedback "$needs" "$(jq -r '.short' <<< "$feedback")" "$(jq -r '.long' <<< "$feedback")"
echo "$out"

# A dependency never created: back to Generate Solution, told which in its execution plan.
unmade="$(jq -r --argjson found "$found" '[.[] | select($found[.at | tostring].needs | index("not-created"))]
  | if . == [] then empty else "MR \([.[]["depends-on"].id] | unique | join(", MR ")) never created, though MR \([.[].id] | unique | join(", MR ")) in another repository depends on it" end' <<< "$waiting")"
if [[ -n "$unmade" ]]; then
  plan_note "$project" "$key" "$variation" "$unmade: back to Generate Solution to build it and record it (merge-request:create)."
  exit 3
fi
exit 2
