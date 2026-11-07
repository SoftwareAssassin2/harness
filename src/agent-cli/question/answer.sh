#!/usr/bin/env bash
# Description: Answer a question — question:answer <project> <global|ticket-key> <index> <answer> [<why-this-answer>] [<scope>]; marks it "Answered" (a non-blocking one's answer matching its assumption, "Answer Accepted").
set -euo pipefail

# The question is the <index>th (from 0) in its project's or ticket's questions
# file (question.bash). why-this-answer and scope are written when given, even
# empty, and left as they were when not. An "Answer Rejected" question answered
# again is "Answered" again, for the AI to judge again.
#
# A non-blocking question (ASS-248: blocking false) was gone on with its
# recommended answer as the assumption. An answer that matches it — case and
# spacing aside — closes it, "Answer Accepted": nothing changes. One that
# differs is "Answered" and is a requirements change: a line { at, field:
# "question", question, from: the assumption, to: the answer } is added to the
# ticket's requirements-history.jsonl, and a sprint ticket's variations at a
# step flagged for it start the requirements-changed workflow (sprint.bash
# recheck_requirements), whose revising step reads that line; a backlog
# ticket is groomed again for the answer (control's refinementDue).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/question.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

usage() { echo "usage: question:answer <project> <global|ticket-key> <index> <answer> [<why-this-answer>] [<scope>]" >&2; exit 1; }
[[ $# -ge 4 && $# -le 6 ]] || usage
given() { [[ $# -ge "$1" ]] && echo true || echo false; }
set_why="$(given 5 "$@")" set_scope="$(given 6 "$@")"
index="$3" answer="$4"
question_file question:answer "$1" "$2" "$3"
[[ -n "${answer//[[:space:]]/}" ]] || { echo "question:answer: the answer is empty" >&2; exit 1; }

# The same text, case and spacing aside.
same='def norm: ascii_downcase | gsub("\\s+"; " ") | ltrimstr(" ") | rtrimstr(" "); ($a | norm) == ($b | norm)'
update_json "$file" --argjson i "$index" --arg answer "$answer" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson set_why "$set_why" --arg why "${5:-}" --argjson set_scope "$set_scope" --arg scope "${6:-}" "
  def same(\$a; \$b): $same;
  if \$i < (.list | length) then
    .list[\$i] |= (.answer = \$answer | .[\"answered-time-stamp\"] = \$at
      | .status = (if .blocking == false and same(.answer; .[\"recomended-answer\"] // \"\") then \"Answer Accepted\" else \"Answered\" end)
      | if \$set_why then .[\"why-this-answer\"] = \$why else . end
      | if \$set_scope then .scope = \$scope else . end)
  else
    error(\"question:answer: no question \(\$i) in this file\")
  end"

# A non-blocking ticket question answered unlike its assumption: a requirements change.
[[ "$2" != global ]] || exit 0
change="$(jq -c --argjson i "$index" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.list[$i]
  | select(.blocking == false and .status == "Answered") | { at: $at, field: "question", question, from: (.["recomended-answer"] // ""), to: .answer }' "$file")"
[[ -n "$change" ]] || exit 0
append_line "$(dirname "$file")/requirements-history.jsonl" "$change"
echo "question:answer: $2's answer differs from the assumption it went on — a requirements change"
sprint="$(sprint_file question:answer "$1" 2>/dev/null)" || exit 0
! lists "$sprint" "$2" || recheck_requirements question:answer "$1" "$2"
