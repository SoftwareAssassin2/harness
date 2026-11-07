#!/usr/bin/env bash
# Description: Set an off-board ticket's priority — ticket:update-priority <project> <key> <priority|none>.
set -euo pipefail

# Rewrites the priority line of the ticket's front matter (see ticket.bash),
# adding one after its status when it has none; `none` removes it, the
# unprioritised state. The priority is one of ticket.bash's $priorities, the
# names the ranking orders by. A value it already has writes nothing and
# stamps nothing, as ticket:update-points. Prints { key, priority }. Fails,
# writing nothing, on any other name, when the project is missing or has no
# off-board work source, the ticket is missing, or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:update-priority <project> <key> <priority|none>" >&2; exit 1; }
if [[ "$3" == none ]]; then priority=null; else priority="$(priority_name ticket:update-priority "$3" ' or none' | jq -R .)"; fi
file="$(ticket_file ticket:update-priority "$1" "$2")"
key="$(ticket_key "$file")"

if [[ "$(ticket_json ticket:update-priority "$file" | jq -c '.priority')" != "$priority" ]]; then
  rewrite_ticket ticket:update-priority "$file" --argjson priority "$priority" '
    close as $c | (.[:$c] | index_of(startswith("priority:"))) as $i
    | (.[:$c] | index_of(startswith("status:"))) as $s
    | if $priority == null then (if $i < 0 then . else del(.[$i]) end)
      elif $i >= 0 then .[$i] = "priority: \($priority)"
      elif $s >= 0 then .[:$s + 1] + ["priority: \($priority)"] + .[$s + 1:]
      else .[:$c] + ["priority: \($priority)"] + .[$c:] end'
fi
jq -n --arg key "$key" --argjson priority "$priority" '{ key: $key, priority: $priority }'
