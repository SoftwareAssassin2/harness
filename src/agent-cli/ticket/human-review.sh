#!/usr/bin/env bash
# Description: Record a human's choice at a human gate — ticket:human-review <project> <ticket-key> <variation> <state> <decision> <to-state> [<reason> [<return-to>]].
set -euo pipefail

# Writes "human-review": { state, decision, timestamp } on the variation in the
# project's active sprint (see sprint.bash), replacing any earlier choice.
# <state> is the step the choice was made at; it fails, writing nothing, unless
# the variation is still there. The choice is the work done there: given a
# <to-state> (the step the choice's exit leads to), the variation moves on, as
# sprint.bash's move_to does, and the ticket system follows the new step's
# paired-ticket-system-status (sync_paired_status); given "", the choice is
# only recorded, <state> the variation's detailed step (sprint.bash
# update_ticket_at_detail) — for a human step inside a sub-engine run
# (ASS-67) that step, and control moves the run by the exit the choice meets.
# Given a <reason> (ASS-118: why it was rejected at Human Review), it is kept
# in the choice and as the variation's "rejection-reason", which stays until
# another reason replaces it: the next Explain the Change reads it in
# ticket.json and says how that pass answers it.
# Given a <return-to> too (ASS-228: the step a Human Review rejection sends the
# ticket back to — write-execution-plan, write-test-plan or generate-solution),
# it is kept in the choice, where the step's move-to-state-from-human-review
# exit reads it, and the reason is appended, a dated section naming the step,
# to the variation's operator-review-<variation>.md in the ticket's work folder
# under the file's lock (json-file.bash append_line) — after the choice, so a
# refused choice adds nothing. Nothing overwrites that file, and no agent
# writes it (work.bash WORK_MANAGED); every later grouped prompt reads it.
#
# At a backlog ticket's human step (ASS-144: the TUI's Accept and Reject of a
# refinement engine's step) the choice is recorded in the project's
# backlog.json the same way, and the move to <to-state> is ticket:change-state's,
# checked against the ticket's own engine. That move is the operator's
# (ASS-42): its entry in the backlog variation's state-changes carries cause
# "operator", and a <reason> as its "reason" (sprint.bash MOVE_CAUSE). The
# choice is written first (ASS-178): a stop before the move leaves the
# variation at <state>, so choosing again records it again and makes the move.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"
source "$here/../work.bash"

[[ $# -ge 6 && $# -le 8 ]] || { echo "usage: ticket:human-review <project> <ticket-key> <variation> <state> <decision> <to-state> [<reason> [<return-to>]]" >&2; exit 1; }
[[ -n "${5//[[:space:]]/}" ]] || { echo "ticket:human-review: the decision is empty" >&2; exit 1; }
[[ $# -eq 6 || -n "${7//[[:space:]]/}" ]] || { echo "ticket:human-review: the reason is empty" >&2; exit 1; }
[[ $# -lt 8 || "$8" =~ ^(write-execution-plan|write-test-plan|generate-solution)$ ]] || { echo "ticket:human-review: the return step must be write-execution-plan, write-test-plan or generate-solution, not '$8'" >&2; exit 1; }
reason="${7:-}" return_to="${8:-}"
# The choice, its return step, and its reason kept as the variation's rejection-reason.
CHOICE='.["human-review"] = ({ state: $state, decision: $decision, timestamp: $at } + if $reason == "" then {} else { reason: $reason } end
    + if $return_to == "" then {} else { "return-to": $return_to } end)
  | if $reason == "" then . else .["rejection-reason"] = $reason end'

if [[ -n "$6" ]] && in_backlog ticket:human-review "$1" "$2"; then
  update_variation ticket:human-review "$1" "$2" "$3" "$4" --arg decision "$5" --arg reason "$reason" --arg return_to "$return_to" "$CHOICE"
  MOVE_CAUSE="$(jq -nc --arg reason "$reason" '{ cause: "operator" } + if $reason == "" then {} else { reason: $reason } end')" exec "$here/change-state.sh" "$1" "$2" "$3" "$4" "$6"
fi
# note — the reason appended to the variation's operator-review-<variation>.md, given a return step.
note() {
  [[ -n "$return_to" ]] || return 0
  append_line "$(work_path ticket:human-review "$1" "$2" "$3" "operator-review-$3.md")" "## $(date -u +%Y-%m-%dT%H:%M:%SZ) — return to $return_to"$'\n\n'"$reason"$'\n'
}
if [[ -z "$6" ]]; then
  update_ticket_at_detail ticket:human-review "$1" "$2" "$3" "$4" --arg decision "$5" --arg reason "$reason" --arg return_to "$return_to" "
    .variations |= map(if .name == \$name then $CHOICE else . end)"
  note "$@"
  exit 0
fi
update_variation ticket:human-review "$1" "$2" "$3" "$4" --arg decision "$5" --arg to "$6" --arg reason "$reason" --arg return_to "$return_to" "$CHOICE | move_to(\$to)"
note "$@"
sync_paired_status ticket:human-review "$1" "$2" "$3"
