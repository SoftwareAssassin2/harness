#!/usr/bin/env bash
# Description: Reword an acceptance criterion of an off-board ticket — ticket:update-acceptance-criteria <project> <key> <n> <text>.
set -euo pipefail

# Replaces the text of criterion <n> (its line `<n>. <text>` under
# `## Acceptance criteria`) in the ticket's file (see ticket.bash) and stamps
# updated. Prints { key, criteria-number }. Fails, writing nothing, when the
# project is missing or has no off-board work source, the ticket is missing,
# its file is malformed, or it has no criterion <n>.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 4 && "$3" =~ ^[0-9]+$ ]] || { echo "usage: ticket:update-acceptance-criteria <project> <key> <n> <text>" >&2; exit 1; }
file="$(ticket_file ticket:update-acceptance-criteria "$1" "$2")"
key="$(ticket_key "$file")"

rewrite_ticket ticket:update-acceptance-criteria "$file" --arg key "$key" --arg n "$3" --arg text "$4" '
  (ac_start as $s | if $s < 0 then -1 else (.[$s:next_heading($s + 1)] | index_of(test("^\($n)\\. "))) as $i | if $i < 0 then -1 else $s + $i end end) as $i
  | if $i < 0 then error("\($command): no criterion \($n) in \($key)") else .[$i] = "\($n). \($text)" end'
jq -n --arg key "$key" --argjson number "$3" '{ key: $key, "criteria-number": $number }'
