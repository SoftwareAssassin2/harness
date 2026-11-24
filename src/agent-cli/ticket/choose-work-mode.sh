#!/usr/bin/env bash
# Description: Record where a ticket variation is built, worktree or full, from Choose Where to Work's answer and the project's forced rules — ticket:choose-work-mode <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# ASS-556: Record Where to Work, on the host, after Choose Where to Work (the
# shipped grouped-plan and v2-plan). The plan run <run-id> holds the AI's
# answer in its structured-output — work-mode (worktree or full),
# work-mode-reasons, work-mode-files (the files the plan touches). With the
# files execution-plan-<variation>.md names, the ticket's points and
# project.json, work-mode.js decides (work-mode.js decideWorkMode, through
# ticket/work-mode.js): full when the project lists no worktree run target;
# an escalated variation kept full, an operator's choice kept; else a
# matching full-forcing rule (project.json work-mode.force-full: paths
# globs, min-points), else work-mode.force, else the AI's mode, else full.
# Written on the variation as "work-mode" (work-mode.bash write_work_mode:
# mode, by, reasons, the AI's own choice, the forced rules that matched, the
# files, its history), and printed. Exit 1 on an unknown run, ticket or
# variation.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../work-mode.bash"
assignments="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

[[ $# -eq 4 ]] || { echo "usage: ticket:choose-work-mode <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
output="$(jq -c --arg id "$4" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id)) // error("no run \($id)") | .["structured-output"] // {}' "$assignments" 2>&1)" \
  || { echo "ticket:choose-work-mode: ${output#jq: error (at *): }" >&2; exit 1; }
found="$(jq -c --arg key "$2" --arg name "$3" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | { key, points: (.points // null), variation: first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) }' "$(sprint_file ticket:choose-work-mode "$1")")"
[[ -n "$found" && "$(jq -r '.variation != null' <<< "$found")" == true ]] || { echo "ticket:choose-work-mode: no $2 variation $3" >&2; exit 1; }
key="$(jq -r .key <<< "$found")"
plan="$projects/$1/work/$key/execution-plan-$3.md"
decided="$(jq -nc --argjson output "$output" --argjson found "$found" --rawfile plan <(cat "$plan" 2>/dev/null || true) --slurpfile json "$projects/$1/project.json" \
  '{ output: $output, plan: $plan, points: (if ($found.points | type) == "number" then $found.points else null end), json: $json[0], current: ($found.variation["work-mode"] // null) }' \
  | node "$here/work-mode.js" decide)"
write_work_mode ticket:choose-work-mode "$1" "$key" "$3" "$(jq -c '{ mode, by, reasons, ai: (.ai + { at: (now | todate) }), forced, files }' <<< "$decided")"
jq -c '{ "work-mode": .mode, by, reasons, ai, forced }' <<< "$decided"
