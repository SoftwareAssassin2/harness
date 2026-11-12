#!/usr/bin/env bash
# Description: Ask the operator how a plan rejected even after the stronger re-plan should proceed — plan:ask-about-objections <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-399: grouped-plan's Ask the Operator About the Plan, reached when the
# stronger re-plan was rejected too, instead of the ticket going to Blocked.
# The rejecting review is recorded first (plan:record-objections), then a
# blocking question is asked on the ticket (question:ask --blocking): the
# open objections — that last review, plan-review-<variation>.md, cut at
# MAX_REVIEW characters — and how to proceed, the full history named in why
# it is asked. Blocking, the ticket gets no agent until it is answered; the
# step after this one (Awaiting the Plan Answer) waits for that, then
# Write Execution Plan runs again with the answer. PROJECTS_DIR overrides the
# projects folder, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../work.bash"
MAX_REVIEW=6000

[[ $# -eq 3 && "$3" != - ]] || { echo "usage: plan:ask-about-objections <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
review="$(work_path plan:ask-about-objections "$project" "$key" "$variation" "plan-review-$variation.md")"
n="$("$here/record-objections.sh" "$project" "$key" "$variation")"

objections="(the review wrote none down: see plan-review-$variation.md)"
if [[ -s "$review" ]]; then
  objections="$(cat "$review")"
  (( ${#objections} <= MAX_REVIEW )) || objections="${objections:0:MAX_REVIEW}
… (cut: the whole review is plan-review-$variation.md)"
fi
question="Variation $variation's plan was rejected $n times, the last after a re-plan on a stronger model. The open objections, from the last review:

$objections

How should the plan proceed?"
why="Plan ran out of re-plans: the reviews kept rejecting it, so rather than go to Blocked the ticket waits on you. Every review so far is in plan-objections-$variation.md in the ticket's work folder."
recommended="Say which objections to resolve and how, and which to drop as out of scope; the plan is written again with your answer."
"$here/../question/ask.sh" "$project" "$key" --blocking "$question" "$why" "$recommended"
