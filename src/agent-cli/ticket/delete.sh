#!/usr/bin/env bash
# Description: Soft delete a ticket, stopping its work first, unless its work has merged — ticket:delete <project> <ticket-key>.
set -euo pipefail

# ASS-104. A soft delete, of an off-board or a Jira ticket alike: the ticket
# gets "is-deleted": true and its deleted-timestamp wherever the project lists
# it — its active sprint (see sprint.bash) and backlog.json — and keeps
# everything else, as do its off-board file and its work folder, so
# ticket:restore can bring it back. Control (src/control/state.js) and the
# dashboard (src/tui/load.js) leave a deleted ticket out; ticket:sync keeps
# the mark, so no download brings it back; nothing is deleted or closed in
# Jira. The mark comes first, so control dispatches nothing more on it; then,
# its live variations' (not is-deleted) work is undone, each step below:
# agents and runs stopped, the workspace given back, VMs stopped (kept), open
# merge requests closed unmerged (branches kept), worktrees removed. A step
# that fails stops it there; run again on the deleted ticket, it does what is
# left.
#
# Last, the memories its agents saved are reviewed (ASS-146): what was learnt
# working a deleted ticket may not hold. The project's execution engine's
# check-memory-steps — the check-memory engine control runs daily — started
# with the ticket as its work-item, { trigger: check-memory, work-item }, so
# its clean-memory agent checks that ticket's memories alone (memory:list)
# and writes memory-cleanup.md in the ticket's folder. Not when the engine
# has no such list (the flat engines), nor while one for the ticket runs: a
# review is not the ticket's work, so the stopping above leaves it be.
# ticket:restore starts none, and brings back no memory it removed.
#
# Prints { key, marked: [sprint|backlog…], agents, runs, vms,
# closed-merge-requests (urls), worktrees (folders), memory-review (the
# review's run id, null when none was started) }. Fails, writing nothing,
# on a ticket in neither file, or one whose work has merged (below), naming
# the merge request; or when a worktree is to go and the project has no
# workspace.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../merge-requests.bash"
source "$here/../engine.bash"
agent="$here/../../../agent.sh"
# ASSIGNMENTS_FILE overrides the path, used by tests.
assignments="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

[[ $# -eq 2 ]] || { echo "usage: ticket:delete <project> <ticket-key>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "ticket:delete: no project '$project'" >&2; exit 1; }

sprint="$(sprint_file ticket:delete "$project" 2>/dev/null || true)"
backlog="$projects/$project/backlog.json"
# listed <file> — whether the file lists the ticket.
listed() { [[ -f "$1" ]] && jq -e --arg k "$key" 'any((.features, .bugs, .spikes, .tickets) // [] | .[]; .key | ascii_upcase == $k)' "$1" >/dev/null; }
listed "$sprint" || listed "$backlog" || { echo "ticket:delete: no $key in $project's sprint or backlog" >&2; exit 1; }
# ticket <file> — the ticket as the file lists it, its soft-deleted variations left out (as good as missing); nothing when it is not there.
ticket() { [[ -f "$1" ]] && jq -c --arg k "$key" 'first((.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | ascii_upcase == $k)) | .variations = [.variations // [] | .[] | select(.["is-deleted"] | not)]' "$1"; }
# The ticket where it is worked on: the sprint's, else the backlog's ($home, the file).
home="$sprint" found="$(ticket "$sprint" || true)"
[[ -n "$found" ]] || { home="$backlog" found="$(ticket "$backlog")"; }

# Its work has merged: a merge request Merged (its build-status, or its status as the forge last said) on a live variation.
merged="$(jq -r 'first(.variations[] | .name as $v | .["merge-request"] // [] | .[] | select(.["build-status"] == "Merged" or .status == "Merged")
  | "variation \($v), \([.key, .url] | map(select(.)) | join(" "))") // empty' <<< "$found")"
[[ -z "$merged" ]] || { echo "ticket:delete: $key's work has merged ($merged); it is not deleted" >&2; exit 1; }

# Each live variation's worktree on the Mac; the workspace they belong to, found before anything is written.
worktrees="$(jq -c '[.variations[] | .build["worktree-folder"] // empty]' <<< "$found")"
worktrees="$(while IFS= read -r folder; do if [[ -d "$folder" ]]; then printf '%s\n' "$folder"; fi; done < <(jq -r '.[]' <<< "$worktrees") | jq -Rsc 'split("\n") | map(select(. != ""))')"
[[ "$worktrees" == '[]' ]] || workspace="$(workspace_of ticket:delete "$project")"

# The mark, in each file that lists the ticket; a ticket marked already keeps
# its deleted-timestamp. The sprint is chosen again, and written, inside the
# project's tickets.lock (ASS-179, sprint.bash lock_tickets), let go before the
# commands below run.
marked=()
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
lock_tickets ticket:delete "$project"
sprint="$(sprint_file ticket:delete "$project" 2>/dev/null || true)"
for where in sprint backlog; do
  file="${!where}"
  listed "$file" || continue
  update_json "$file" --arg k "$key" --arg at "$at" '
    ((.features, .bugs, .spikes, .tickets) // empty) |= map(if .key | ascii_upcase == $k then .["is-deleted"] = true | .["deleted-timestamp"] //= $at else . end)'
  marked+=("$where")
done
exec 3>&-
# update_home [jq options…] <filter> — update_json on the ticket's file where it is worked on (the active sprint's when it lists it, else the backlog), chosen inside the tickets lock.
update_home() {
  local file="$backlog" active
  lock_tickets ticket:delete "$project" || return 1
  active="$(sprint_file ticket:delete "$project" 2>/dev/null || true)"
  ! listed "$active" || file="$active"
  update_json "$file" "$@" || { exec 3>&-; return 1; }
  exec 3>&-
}

# Its work stopped, as control stops it: its transient runs (those whose
# parent is the ticket, and theirs in turn) and every agent on the ticket or
# on one of them — killed (agent:kill) and its assignment removed
# (assignments:remove), no graceful shut-down: the ticket is going. Then the
# runs are removed (transient-state-engine:remove). A memory review of the
# ticket (below) is not its work and is left be.
runs="$(jq -c --arg p "$project" --arg k "$key" '
  (.["transient-state-engines"] // []) as $all
  | def children($ids): [$all[] | select((.parent["transient-state-engine"] // null) as $q | $q != null and ($ids | index([$q])) and ($ids | index([.id]) | not)) | .id];
  [$all[] | select(.project == $p and ((.parent["work-item"] // "") | ascii_upcase) == $k and .parent.trigger != "check-memory") | .id]
  | until(children(.) == []; . + children(.))' "$assignments")"
agents="$(jq -c --arg p "$project" --arg k "$key" --argjson runs "$runs" '
  [.assignments // [] | .[] | select(.project == $p and ((((.["work-item"] // "") | ascii_upcase) == $k) or (.["transient-state-engine"] as $r | $r != null and ($runs | index([$r]))))) | .["agent-name"]]' "$assignments")"
# One control ended meanwhile (no assignment, no run any more) is passed over.
while IFS= read -r name; do
  "$agent" agent:kill "$name" 2>/dev/null || continue
  "$agent" assignments:remove "$name" >/dev/null
done < <(jq -r '.[]' <<< "$agents")
while IFS= read -r id; do "$agent" transient-state-engine:remove "$id" >/dev/null 2>&1 || true; done < <(jq -r '.[]' <<< "$runs")
# The workspace given back (code:release-workspace) when a variation of the sprint ticket holds it.
held="$(jq -r 'first(.["local-environments"][]? | select(.type == "local-pc") | .["active-branch"]) // empty' "$projects/$project/project.json")"
if [[ -n "$held" && "$home" != "$backlog" ]]; then
  while IFS= read -r name; do "$agent" code:release-workspace "$project" "$key" "$name" >/dev/null; done \
    < <(jq -r --arg b "$held" '.variations[] | select(.build.branch == $b) | .name' <<< "$found")
fi

# Each live variation's VM stopped (vm:stop; one stopped already is left as
# it is) and kept: a restored ticket's work runs in it again.
vms="$(jq -c '[.variations[] | .vm.name // empty]' <<< "$found")"
while IFS= read -r vm; do "$agent" vm:stop "$project" "$vm"; done < <(jq -r '.[]' <<< "$vms")

# Each open merge request of a live variation (status Open, with a url)
# closed on its forge without merging (mr_close, merge-requests.bash) and
# recorded Closed. Its branch, local and remote, is kept.
closed="$(jq -c '[.variations[] | .["merge-request"] // [] | .[] | select(.status == "Open" and .url != null) | .url]' <<< "$found")"
while IFS= read -r url; do
  mr_close ticket:delete "$url"
  update_home --arg k "$key" --arg url "$url" '
    ((.features, .bugs, .spikes, .tickets) // empty) |= map(if .key | ascii_upcase == $k then
      .variations |= map(if .["is-deleted"] then . else .["merge-request"] |= (if . == null then . else map(if .url == $url then .status = "Closed" else . end) end) end)
    else . end)'
done < <(jq -r '.[]' <<< "$closed")

# Each worktree removed (git worktree remove --force: what was not committed
# goes with it; the branch stays), and the variation's build.worktree and
# worktree-folder cleared.
while IFS= read -r folder; do
  git -C "$workspace" worktree remove --force "$folder"
  update_home --arg k "$key" --arg f "$folder" '
    ((.features, .bugs, .spikes, .tickets) // empty) |= map(if .key | ascii_upcase == $k then
      .variations |= map(if .build["worktree-folder"] == $f then .build.worktree = null | .build["worktree-folder"] = null else . end)
    else . end)'
done < <(jq -r '.[]' <<< "$worktrees")

# The memory review: the run going for the ticket, else one started at the list's first step.
review=""
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
first="$( { [[ -n "$engine" ]] && engine_steps_of ticket:delete "$engine/check-memory-steps" "$project" 2>/dev/null; } | jq -r 'sort_by(.sequence) | .[0].id // empty' || true)"
if [[ -n "$first" ]]; then
  review="$(jq -r --arg p "$project" --arg k "$key" 'first(.["transient-state-engines"] // [] | .[] | select(.project == $p and .parent.trigger == "check-memory" and .parent["work-item"] == $k) | .id) // empty' "$assignments")"
  [[ -n "$review" ]] || review="$("$agent" transient-state-engine:create "$project" "$engine/check-memory-steps" "$first" "$(jq -nc --arg k "$key" '{ trigger: "check-memory", "work-item": $k }')" | jq -r .id)"
fi

jq -nc --arg key "$key" --arg review "$review" --argjson agents "$agents" --argjson runs "$runs" --argjson vms "$vms" --argjson closed "$closed" --argjson worktrees "$worktrees" --args '
  { key: $key, marked: $ARGS.positional, agents: $agents, runs: $runs, vms: $vms, "closed-merge-requests": $closed, worktrees: $worktrees, "memory-review": (if $review == "" then null else $review end) }' "${marked[@]}"
