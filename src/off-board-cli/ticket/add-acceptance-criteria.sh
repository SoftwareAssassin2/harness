#!/usr/bin/env bash
# Description: Add an acceptance criterion to an off-board ticket — ticket:add-acceptance-criteria <project> <key> <text>.
set -euo pipefail

# Appends `<n>. <text>` to the numbered list under `## Acceptance criteria`
# in the ticket's file (see ticket.bash), <n> one past the highest number
# there, creating the section at the end when it is missing. Stamps updated.
# Prints { key, criteria-number }. Fails, writing nothing, when the project
# is missing or has no off-board work source, the ticket is missing, or its
# file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:add-acceptance-criteria <project> <key> <text>" >&2; exit 1; }
file="$(ticket_file ticket:add-acceptance-criteria "$1" "$2")"
lock_store ticket:add-acceptance-criteria "$(dirname "$file")"
number="$(ticket_json ticket:add-acceptance-criteria "$file" | jq '([.["acceptance-criteria"][]["criteria-number"]] | max // 0) + 1')"

rewrite_ticket ticket:add-acceptance-criteria "$file" --arg line "$number. $3" '
  ac_start as $s
  | if $s < 0 then strip_blank + ["", "## Acceptance criteria", "", $line]
    else next_heading($s + 1) as $e | (.[$s:$e] | strip_blank) as $section
    | .[:$s] + $section + (if any($section[]; test("^[0-9]+\\. ")) then [$line] else ["", $line] end) + [""] + .[$e:] end'
jq -n --arg key "$(ticket_key "$file")" --argjson number "$number" '{ key: $key, "criteria-number": $number }'
