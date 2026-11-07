#!/usr/bin/env bash
# Description: Reject an operator's answer — question:reject <project> <global|ticket-key> <index> <why>; an "Answered" question becomes "Answer Rejected", the why in ai-feedback-if-not-accepted, back to the operator to answer again.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/question.bash"

[[ $# -eq 4 ]] || { echo "usage: question:reject <project> <global|ticket-key> <index> <why>" >&2; exit 1; }
[[ -n "${4//[[:space:]]/}" ]] || { echo "question:reject: the why is empty" >&2; exit 1; }
question_file question:reject "$1" "$2" "$3"
judge_answer question:reject "$file" "$3" '.status = "Answer Rejected" | .["ai-feedback-if-not-accepted"] = $why' --arg why "$4"
