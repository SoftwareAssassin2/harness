#!/usr/bin/env bash
# Description: Ask a question — question:ask <project> <global|ticket-key> --blocking|--non-blocking <question> <why-asked> <recommended-answer>; appends it "Asked", for the operator to answer.
set -euo pipefail

# The one way an agent asks (ASS-170): a question it writes into the file itself
# can carry a status control never treats as open. Appended to the project's or
# ticket's questions file (question.bash), created when it is not there yet,
# with every field a question has; asked-on-ticket is the ticket, empty for a
# global question.
#
# It says whether it blocks (ASS-248): exactly one of --blocking or
# --non-blocking, anywhere after the ticket, stored as blocking true or false.
# A blocking question holds its ticket — control starts no agent for it — until
# it is answered: a wrong guess would cost rework, be irreversible, or it is a
# product or business call only the operator can make. A non-blocking one
# never holds: the agent goes on with its recommended answer, the assumption,
# so the recommended answer is required.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/question.bash"

usage() { echo "usage: question:ask <project> <global|ticket-key> --blocking|--non-blocking <question> <why-asked> <recommended-answer>" >&2; exit 1; }
[[ $# -ge 2 ]] || usage
args=("$1" "$2") flags=0 blocking=false
for arg in "${@:3}"; do
  case "$arg" in
    --blocking) blocking=true; flags=$((flags + 1)) ;;
    --non-blocking) flags=$((flags + 1)) ;;
    *) args+=("$arg") ;;
  esac
done
[[ ${#args[@]} -eq 5 ]] || usage
[[ $flags -eq 1 ]] || { echo "question:ask: say exactly one of --blocking or --non-blocking — blocking when a wrong guess costs rework, is irreversible, or is the operator's product or business call; else non-blocking, going on with the recommended answer" >&2; exit 1; }
set -- "${args[@]}"
[[ -n "${3//[[:space:]]/}" ]] || { echo "question:ask: the question is empty" >&2; exit 1; }
[[ -n "${5//[[:space:]]/}" ]] || { echo "question:ask: the recommended answer is empty — give the answer you would go on with" >&2; exit 1; }
question_file question:ask "$1" "$2"
on="$2"; [[ "$on" == global ]] && on=""

update_json --create "$file" --arg q "$3" --arg why "$4" --arg rec "$5" --arg on "$on" --argjson blocking "$blocking" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  .list = (.list // []) + [{ question: $q, "recomended-answer": $rec, answer: "", "why-asked": $why, "why-this-answer": "", scope: "",
    "asked-on-ticket": $on, "asked-time-stamp": $at, "answered-time-stamp": "", status: "Asked", "ai-feedback-if-not-accepted": "", blocking: $blocking }]'
