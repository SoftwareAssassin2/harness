#!/usr/bin/env bash
# Description: Hand a fix only the operator can make to them — self-healing:hand-to-human <project> <ticket-key> <summary> <what-the-operator-must-do>.
set -euo pipefail

# For a fix that needs the operator's own uncommitted work or a credential (a
# token, a re-login): the fix ticket becomes sprint work waiting on them, at
# blocked-for-human (ticket:join-sprint, its paired status set), and every
# live variation's health becomes what the operator must
# do (ai-feedback-short) and why (ai-feedback-long: "<summary>. Needs the
# operator: <what>"). Fails, writing nothing, when what the operator must do
# is empty or the ticket is neither in the sprint nor off-board.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"
agent="$here/../../../agent.sh"

[[ $# -eq 4 ]] || { echo "usage: self-healing:hand-to-human <project> <ticket-key> <summary> <what-the-operator-must-do>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" summary="$3" what="$4"
project="$(home_project self-healing:hand-to-human "$1" "$key")"   # the fix ticket's own project (an ASS-n: the harness's)
[[ -n "${what//[[:space:]]/}" ]] || { echo "self-healing:hand-to-human: what the operator must do is empty" >&2; exit 1; }
"$agent" ticket:join-sprint "$project" "$key" blocked-for-human >/dev/null

update_whole_ticket self-healing:hand-to-human "$project" "$key" --arg short "$what" --arg long "$summary. Needs the operator: $what" '
  .variations |= map(if .["is-deleted"] then . else .["ai-feedback-short"] = $short | .["ai-feedback-long"] = $long end)'
