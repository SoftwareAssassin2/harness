#!/usr/bin/env bash
# Description: Record a notice about a ticket variation from outside its own flow, beside its health — ticket:add-ai-notice <project> <ticket-key> <variation> <source> <short> <long>.
set -euo pipefail

# ASS-510: appends { timestamp, source, short, long } to the variation's
# ai-notices in the project's active sprint (see sprint.bash), never touching
# its ai-feedback-short/long: a notice from outside the variation's own flow
# (control's stray-branch set-aside, workstation-steps.js setAside) is shown
# after its feedback, marked as a notice, so it never hides why the variation
# is blocked. One rule at any state: a notice never overwrites feedback. A move
# clears the notices with the feedback (move_to). Fails, writing nothing, on an
# empty <short> or an unknown variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 6 ]] || { echo "usage: ticket:add-ai-notice <project> <ticket-key> <variation> <source> <short> <long>" >&2; exit 1; }
[[ -n "${5//[[:space:]]/}" ]] || { echo "ticket:add-ai-notice: the notice is empty" >&2; exit 1; }
update_whole_ticket ticket:add-ai-notice "$1" "$2" --arg name "$3" --arg source "$4" --arg short "$5" --arg long "$6" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name == $name and (.["is-deleted"] | not) then .["ai-notices"] = ((.["ai-notices"] // []) + [{ timestamp: $at, source: $source, short: $short, long: $long }]) else . end)'
