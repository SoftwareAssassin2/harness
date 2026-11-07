#!/usr/bin/env bash
# Description: Set each backlog ticket's priority to its place in the refinement order — ticket:renumber-backlog <project> --by <control|human>.
set -euo pipefail

# ASS-84: control owns backlog priorities. Each ticket in the project's
# backlog.json that control ranks (not soft deleted, not Done, not in the
# active sprint — ASS-202 isLiveBacklogEntry)
# gets as its priority its manual-backlog-priority when the operator set one
# (ASS-100; never changed here), else its 1-based place in control's
# refinement order (src/control/rank.js rankBacklog, backlogPriorities). A
# ticket in the sprint keeps its last backlog priority, a memory of where it
# sat; a deleted one is left as it is. Deterministic: the same backlog always
# gives the same numbers. --by says who changed the ranking — control (a sync,
# a refinement state change, a ticket joining the sprint) or human
# (ticket:set-manual-backlog-priority); both renumber alike. Every write that
# changes the ranking calls it after its own. Prints { project, by,
# renumbered }; a project without a backlog.json renumbers nothing. Fails,
# writing nothing, without --by control|human or on an invalid project.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

[[ $# -eq 3 && "$2" == --by && ( "$3" == control || "$3" == human ) ]] || { echo "usage: ticket:renumber-backlog <project> --by <control|human>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:renumber-backlog: invalid project '$1'" >&2; exit 1; }
file="$projects/$1/backlog.json"
[[ -f "$file" ]] || { jq -nc --arg p "$1" --arg by "$3" '{ project: $p, by: $by, renumbered: 0 }'; exit 0; }

# backlog.json.lock, every backlog writer's (update_json's), held from the
# read to the write (ASS-179): the ranking is of what every earlier write
# left, and no write lands between the read and this one.
file="$(readlink -f "$file")"
lock_on 8 "$file.lock" ticket:renumber-backlog "${JSON_LOCK_TIMEOUT:-30}"
priorities="$(node "$here/renumber-backlog.js" "$projects/$1")"
write_json "$file" --argjson p "$priorities" '.tickets |= map(.key as $k | if $p | has($k) then .priority = $p[$k] else . end)'
jq -nc --arg p "$1" --arg by "$3" --argjson n "$(jq length <<< "$priorities")" '{ project: $p, by: $by, renumbered: $n }'
