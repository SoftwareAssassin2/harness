#!/usr/bin/env bash
# Description: Move a ticket variation built in a worktree to a full machine, once and for good — ticket:escalate-work-mode <project> <ticket-key> <variation> tests|review|ci <why>.
set -euo pipefail

# ASS-556: one-way escalation to full, called by an agent whose prompt's
# {work-mode-rule} says when (prompt.bash): tests — tests that cannot run in
# the worktree (Generate Solution, Generate Automated Tests, Test); review —
# a code or security review flags risk a worktree cannot check (Code Review,
# Security Review); ci — the merge request's CI failed for a reason that
# needs the stack (Address Merge Request Feedback). A variation in worktree
# mode becomes full, by escalation (work-mode.bash write_work_mode), the
# escalation { trigger, why, step (its detailed step), memory? } kept and
# logged by control (work-mode.js workModeNews); its next steps take full
# machines (run-targets.js candidates). Nothing moves it back but the
# operator (ticket:set-work-mode). A variation not in worktree mode is left as
# it is: once escalated, a second call changes nothing. ci also retains a
# Hindsight memory of why (work-mode.bash retain_memory, document
# work-mode-ci-<key>-<variation>), for the next Choose Where to Work to recall
# — its result, retained or not retained, kept on the escalation; Hindsight
# not answering never fails the escalation. Prints { escalated, work-mode,
# trigger, why[, memory] }. Exit 1 on bad arguments or an unknown ticket or
# variation.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../work-mode.bash"

[[ $# -eq 5 && ( "$4" == tests || "$4" == review || "$4" == ci ) && -n "$5" ]] || { echo "usage: ticket:escalate-work-mode <project> <ticket-key> <variation> tests|review|ci <why>" >&2; exit 1; }
found="$(jq -c --arg key "$2" --arg name "$3" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | { key, title: (.title // .summary // ""), variation: first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) }' "$(sprint_file ticket:escalate-work-mode "$1")")"
[[ -n "$found" && "$(jq -r '.variation != null' <<< "$found")" == true ]] || { echo "ticket:escalate-work-mode: no $2 variation $3" >&2; exit 1; }
key="$(jq -r .key <<< "$found")" mode="$(jq -r '.variation["work-mode"].mode // "unset"' <<< "$found")"
if [[ "$mode" != worktree ]]; then
  jq -nc --arg mode "$mode" --arg t "$4" '{ escalated: false, "work-mode": $mode, trigger: $t, why: "not built in a worktree: nothing to escalate" }'
  exit 0
fi
step="$(jq -r '.variation["harness-status"] | [recurse(.["sub-status"] // empty) | .state // empty] | last // ""' <<< "$found")"
memory=
if [[ "$4" == ci ]]; then
  files="$(jq -r '.variation["work-mode"].files // [] | .[:12] | join(", ")' <<< "$found")"
  content="$key ($(jq -r .title <<< "$found")) was built in a worktree, and its merge request's CI failed on something the worktree could not catch: $5.${files:+ The plan touched $files.} It was moved to a full machine. Weigh this when choosing where to build a similar ticket."
  doc="work-mode-ci-$(tr '[:upper:]' '[:lower:]' <<< "$key")-$(tr '[:upper:]' '[:lower:]' <<< "$3")"
  if retain_memory "$1" "$doc" "$key" "$content"; then memory=retained; else memory="not retained: $1's Hindsight did not answer"; echo "ticket:escalate-work-mode: $memory" >&2; fi
fi
write_work_mode ticket:escalate-work-mode "$1" "$key" "$3" "$(jq -nc --arg t "$4" --arg why "$5" --arg step "$step" --arg memory "$memory" \
  '{ mode: "full", by: "escalation", reasons: ["\($t): \($why)"], escalation: ({ trigger: $t, why: $why, from: "worktree", step: (if $step == "" then null else $step end) } + (if $memory == "" then {} else { memory: $memory } end)) }')"
jq -nc --arg t "$4" --arg why "$5" --arg memory "$memory" '{ escalated: true, "work-mode": "full", trigger: $t, why: $why } + (if $memory == "" then {} else { memory: $memory } end)'
