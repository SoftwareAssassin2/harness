#!/usr/bin/env bash
# Description: Add the variation's latest plan review to its plan objections — plan:record-objections <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-399: grouped-plan's Record the Plan Objections (and Record the
# Objections for a Stronger Plan, Ask the Operator About the Plan) runs it
# each time Review Plan rejects the plan. plan-review-<variation>.md is
# rewritten by every review, so the objections would be lost with it: each is
# kept here, in plan-objections-<variation>.md in the ticket's work folder, as
# "## Review <n>, rejected <UTC time>" and the review beneath it, numbered on
# from the last one there (one when the file is new). Write Execution Plan
# reads it, the stronger re-plan above all: every objection so far is its
# input. A review that is missing or empty is recorded as such. The file is
# the harness's own (work.bash WORK_MANAGED): work:write refuses it, so an
# agent never rewrites the history. Appended under <file>.lock, whole
# (json-file.bash replace_file). Prints the review's number. Fails, adding
# nothing, on a bad name or a ticket with no work folder. PROJECTS_DIR
# overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

[[ $# -eq 3 && "$3" != - ]] || { echo "usage: plan:record-objections <project> <ticket-key> <variation>" >&2; exit 1; }
review="$(work_path plan:record-objections "$1" "$2" "$3" "plan-review-$3.md")"
file="$(work_path plan:record-objections "$1" "$2" "$3" "plan-objections-$3.md")"

lock_on 9 "$file.lock" plan:record-objections "${JSON_LOCK_TIMEOUT:-30}"
n=1
[[ -f "$file" ]] && n=$(( $(grep -c '^## Review [0-9][0-9]*, rejected ' "$file" || true) + 1 ))
body="(no plan review was written)"
[[ -s "$review" ]] && body="$(cat "$review")"
{
  [[ ! -f "$file" ]] || { cat "$file"; echo; }
  printf '## Review %s, rejected %s\n\n%s\n' "$n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$body"
} | replace_file "$file" || { echo "plan:record-objections: the write failed: $file left as it was" >&2; exit 1; }
echo "$n"
