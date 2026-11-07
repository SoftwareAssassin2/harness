#!/usr/bin/env bash
# Description: Accept an operator's answer — question:accept <project> <global|ticket-key> <index>; an "Answered" question becomes "Answer Accepted".
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/question.bash"

[[ $# -eq 3 ]] || { echo "usage: question:accept <project> <global|ticket-key> <index>" >&2; exit 1; }
question_file question:accept "$@"
judge_answer question:accept "$file" "$3" '.status = "Answer Accepted"'
