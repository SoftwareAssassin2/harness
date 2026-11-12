#!/usr/bin/env bash
# Description: Clear a ticket variation's health, only while it is still the one given — ticket:clear-ai-feedback <project> <ticket-key> <variation> <long>.
set -euo pipefail

# ASS-400: control writes a variation's health (ticket:set-ai-feedback) while
# a rate limit with no API fallback keeps its VM stopped, and clears it here
# once the wait is over. Sets ai-feedback-short and ai-feedback-long to null
# only while ai-feedback-long is still <long> — one written since (a move, a
# step's own reason) is left as it is. Fails, writing nothing, on an unknown
# variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 4 ]] || { echo "usage: ticket:clear-ai-feedback <project> <ticket-key> <variation> <long>" >&2; exit 1; }
update_whole_ticket ticket:clear-ai-feedback "$1" "$2" --arg name "$3" --arg long "$4" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name == $name and (.["is-deleted"] | not) and .["ai-feedback-long"] == $long then .["ai-feedback-short"] = null | .["ai-feedback-long"] = null else . end)'
