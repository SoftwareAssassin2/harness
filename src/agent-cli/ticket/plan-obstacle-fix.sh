#!/usr/bin/env bash
# Description: Grow a blocked ticket's plan by the fix of the local obstacle in its way — ticket:plan-obstacle-fix <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# The "No" of the operator's decision box (ASS-163 AC3): a failure Blocked
# put in the project's code that the latest master does not show
# (project:check-on-master absent) is our environment or access — VM,
# emulation, timing, cold cache, a missing credential or repository, a stale
# branch. Nothing is raised in the project; it still has to be fixed, so the
# ticket's plan grows by that fix: an "## Obstacle fix" section appended to
# the variation's execution-plan-<variation>.md (its folder's, data/projects/<project>/work/
# <KEY>, ASS-181; made, holding just the section, when the ticket has no plan yet, for
# its planning to take in), from the Blocked run's findings (<run-id>'s
# structured-output: summary, root-cause, master-evidence, missing-repository).
# The step added is the repair grouped-blocked makes next: adding a missing
# repository, else repairing the environment in the ticket's VM, else the
# operator's exact step (Blocked for Human); then the plan's own work carries
# on. No ticket scope is added. Prints { plan-revised, obstacle-fix }.
# ASS-390 AC2: grouped-blocked now runs it only for a project issue (Classify's
# issue project, not the ticket's own branch), whose fix Repair Project makes
# next: the step added says so — the product code in the way fixed in a
# separate small merge request (change/<KEY>-fix-<n>) the ticket waits on,
# never its own branch — instead of the repair; any other run's, as before;
# a missing repository named still first. Which of the three Blocked's repair
# is, it prints as obstacle-repair (add-repository, repair-project or
# repair-environment), for grouped-blocked's exits to route on.
# Fails (1), writing nothing, on a bad variation or an unknown run.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/work.bash"
assignments="${ASSIGNMENTS_FILE:-$here_vm/../../data/assignments.json}"

command=ticket:plan-obstacle-fix
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" id="$4"
variation_exists "$command" "$project" "$key" "$variation"
found="$(jq -c --arg id "$id" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id) | .["structured-output"] // {})' "$assignments")"
[[ -n "$found" ]] || { echo "$command: no run $id" >&2; exit 1; }

repair="$(jq -r 'if (.["missing-repository"] // "-") != "-" then "add-repository" elif .issue == "project" then "repair-project" else "repair-environment" end' <<< "$found")"
step="$(jq -r --arg p "$project" --arg k "$key" 'if (.["missing-repository"] // "-") != "-" then "add \(.["missing-repository"]) to project \($p) and download it into the ticket'"'"'s VM"
  elif .issue == "project" then "Blocked'"'"'s Repair Project fixes the product code in the way in a separate small merge request (change/\($k)-fix-<n>) that this ticket waits on, never in this ticket'"'"'s own branch; else the operator'"'"'s exact step through Blocked for Human"
  else "repair the environment in the ticket'"'"'s VM (its checkouts, dependencies, the project'"'"'s containers), else the operator'"'"'s exact step through Blocked for Human" end' <<< "$found")"
name="execution-plan-$variation.md"
plan="$(ticket_folder "$command" "$project" "$key")/$name"
section="$(jq -r --arg at "$(date -u +%Y-%m-%d)" --arg v "$variation" --arg p "$project" --arg step "$step" '
  "## Obstacle fix (\($at), Blocked, variation \($v))\n",
  "Blocked: \(.summary // "not said"). Cause: \(.["root-cause"] // "not said").",
  "Not on the latest master: \(.["master-evidence"] // "not checked") — \(if .issue == "project" then "not a bug on \($p)'"'"'s master" else "our environment or access, not \($p)'"'"'s code" end): no project bug raised, no ticket scope added.",
  "Step added: \($step); then carry on with this plan'"'"'s own work."' <<< "$found")"
# One locked append (json-file.bash append_line, ASS-179), a blank line first after what is there.
text="$section"
[[ ! -s "$plan" ]] || text=$'\n'"$section"
append_line "$plan" "$text"
blocked_log "$project" "$key" "$variation" "Plan the Obstacle Fix" "Not on the latest master: no project bug raised. Added to $name: $step."
jq -nc --arg s "$step" --arg name "$name" --arg r "$repair" '{ "plan-revised": $name, "obstacle-fix": $s, "obstacle-repair": $r }'
