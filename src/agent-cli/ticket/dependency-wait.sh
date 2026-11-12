#!/usr/bin/env bash
# Description: Send a blocked ticket to wait at Await Sequential Merge when its block only waits for one of its own dependency merge requests to merge — ticket:dependency-wait <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# ASS-390 AC5, grouped-blocked's dependency route. Classify said (issue
# "dependency", the Blocked run's structured-output, <run-id>) that the block
# is not a fault at all: one of the ticket's merge requests depends on one in
# another repository that has not merged yet, and what it needs from there
# (an image, a package) is published only after that merge — so its tests
# fail on nothing an agent or the operator can fix, and the ticket only has
# to wait. Build's Await Sequential Merge (ASS-335/359/365) is that wait; the
# ticket goes back to it rather than to the operator.
#
# Shown when the variation's merge requests, read from their forges where
# they can be (refresh_merge_requests, merge-requests.bash; as recorded when
# a forge cannot be read), have such a pair — a merge request neither Merged
# nor Closed whose depends-on names one in another repository that is
# neither (MR_DEPS's unmerged_deps, as merge-request:await-dependencies asks)
# — and, when Classify named the one it waits for (dependency-merge-request:
# its planned id, its key "!12"/"#12", or its url), that one is among them;
# and when the project's engine has a step to resume at running Await
# Sequential Merge (await-dependencies) at or before the step the ticket
# blocked at — fix-resume-step.js's check of a declared step, lifted to its
# top-level group (Build), as for ticket:own-branch-fix. Then it prints {
# awaits-dependency: true, dependency: { id, repository, status, key, url,
# waited-by }, resume-at, resume-sub-at: "await-dependencies", resume-source,
# resume-why, resume-ignored, ai-feedback-short: null, ai-feedback-long: null }
# and exits 0: control (engine.js awaitsDependency) resumes the ticket at
# Build, its run started at Await Sequential Merge (resume-sub-at, steps.js),
# the visit counts restarted (cause dependency-wait). Not shown prints {
# awaits-dependency: false, dependency-why, ai-feedback-short, -long } and
# exits 3, for Blocked for Human. Either way the change log says so
# (work.bash blocked_log, AC3). Each such return is counted by
# ticket:fix-attempts, so one that keeps blocking reaches the operator.
# Fails (1) on bad arguments, a bad variation or an unknown run.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/merge-requests.bash"
source "$here_vm/work.bash"
assignments="${ASSIGNMENTS_FILE:-$here_vm/../../data/assignments.json}"

command=ticket:dependency-wait
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" id="$4"
variation_exists "$command" "$project" "$key" "$variation"
found="$(jq -c --arg id "$id" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id) | .["structured-output"] // {})' "$assignments")"
[[ -n "$found" ]] || { echo "$command: no run $id" >&2; exit 1; }
named="$(jq -r '.["dependency-merge-request"] // "" | tostring' <<< "$found")"

no() {
  blocked_log "$project" "$key" "$variation" "Wait for the Dependency Merge Request" "Classify said the block only waits for a dependency merge request to merge, but $1. Handed to the operator."
  jq -nc --arg why "$1" --arg key "$key" '{ "awaits-dependency": false, "dependency-why": $why, "ai-feedback-short": "Not shown to wait only for a dependency merge request",
    "ai-feedback-long": "Blocked classified \($key)'"'"'s block as only waiting for one of its dependency merge requests to merge, but \($why). Check its merge requests and what blocks it, then resolve, or have AI try again." }'
  echo "$command: $1" >&2
  exit 3
}

# The variation's merge requests, from their forges where they can be read; as recorded otherwise.
refresh_merge_requests "$command" "$project" "$key" "$variation" 2>/dev/null || load_merge_requests "$command" "$project" "$key" "$variation" 2>/dev/null || no "$key $variation has no merge request recorded"
waiting="$(jq -c "$MR_DEPS"'
  . as $all
  | [ $all[] | select(.id != null and (done | not)) as $m
      | $m | unmerged_deps($all)[] | select(.repository != $m.repository)
      | { id, repository, status, key, url, "waited-by": $m.id } ]' <<< "$MRS")"
[[ "$waiting" != '[]' ]] || no "none of its merge requests depends on an unmerged one in another repository"
dependency="$(jq -c --arg n "$named" 'first(.[] | select($n == "" or (.id | tostring) == $n or .key == $n or ((.url // "") != "" and (.url | rtrimstr("/")) == ($n | rtrimstr("/"))))) // empty' <<< "$waiting")"
[[ -n "$dependency" ]] || no "$named is not one of its unmerged dependency merge requests in another repository ($(jq -r 'map(.key // "MR \(.id)") | join(", ")' <<< "$waiting"))"

# Where it resumes: Await Sequential Merge's top-level group, lifted and checked as a declared step is (fix-resume-step.js).
variation_json="$(variation_field . "$command" "$project" "$key" "$variation")"
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
resume="$(jq -nc --arg project "$project" --arg ticket "$key" --argjson variation "$variation_json" --arg engine "$engine" \
  --argjson files "$(engine_files "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')" \
  '{ project: $project, ticket: $ticket, variation: $variation, engine: $engine, engineFiles: $files, declared: "await-dependencies",
     declaredBy: "Blocked'"'"'s dependency route (ASS-390) declares" }' | node "$here_vm/ticket/fix-resume-step.js")"
[[ "$(jq -r '.["resume-source"]' <<< "$resume")" == declared ]] \
  || no "Await Sequential Merge is no step it can resume at ($(jq -r '[.["resume-ignored"][]?.why] | join("; ") | if . == "" then "not in its engine" else . end' <<< "$resume"))"

name="$(jq -r '"\(.key // "MR \(.id)") (\(.repository), \(.status))"' <<< "$dependency")"
blocked_log "$project" "$key" "$variation" "Wait for the Dependency Merge Request" "The block only waits for the dependency merge request $name, which MR $(jq -r '.["waited-by"]' <<< "$dependency") depends on, to merge: nothing changed; the ticket resumes at $(jq -r '.["resume-at"]' <<< "$resume")'s Await Sequential Merge to wait for it."
jq -c --argjson d "$dependency" '{ "awaits-dependency": true, dependency: $d } + . + { "resume-sub-at": "await-dependencies", "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$resume"
