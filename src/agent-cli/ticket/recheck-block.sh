#!/usr/bin/env bash
# Description: Re-run the check a blocked ticket variation failed, before any agent troubleshoots it — ticket:recheck-block <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-390 AC4, grouped-blocked's Check First: the first thing Blocked does
# after counting its attempts, so a block that has cleared by itself (a forge
# or VM hiccup, a dependency published since, a flaky suite) costs no agent.
# The step the variation was blocked at, and its command, are recheck-block.js's
# choice (the step it was at when it entered Blocked, read from its state
# changes as control's cameFrom reads them; a script step only — Automated
# Testing's automated-tests:verify-success being the recorded automated tests
# — never one that changes anything outside the ticket). That command is run
# again here, as control ran it: ./agent.sh at the repository's root, on the
# Mac (a step run in the VM is an agent.sh command, which the VM forwards to
# the Mac anyway), its output kept.
#
# Prints and exits:
#   0  it passes now: { needs-fix: false, rechecked: true, recheck-passed:
#      true, summary: "Passed on
#      re-check; nothing to fix", recheck: { at, command, exit } } — Blocked's
#      run is done and the ticket resumes; "Passed on re-check; nothing to
#      fix" goes in its change log;
#   3  it still fails — { rechecked: true, recheck: { at, command, exit,
#      output (its last lines) } } — or there is nothing to re-run
#      ({ rechecked: false, recheck-why }): Troubleshoot goes on as before;
#   1  bad arguments, an unknown ticket or variation.
# Every outcome is logged in the variation's change log (work.bash blocked_log, AC3).
# The passes are counted by ticket:fix-attempts (a run kept in blocks with
# recheck-passed true — a re-check that failed, Troubleshoot then finding
# nothing wrong, is none), so a check that passes only on re-check
# and fails again in the step reaches the operator after 3.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/code.bash"
source "$here_vm/work.bash"

command=ticket:recheck-block
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
variation_exists "$command" "$project" "$key" "$variation"
found="$(variation_field . "$command" "$project" "$key" "$variation")"
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
choice="$(jq -nc --arg project "$project" --arg ticket "$key" --argjson variation "$found" --arg engine "$engine" \
  --argjson files "$(engine_files "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')" \
  '{ project: $project, ticket: $ticket, variation: $variation, engine: $engine, engineFiles: $files }' | node "$here_vm/ticket/recheck-block.js")"

why="$(jq -r '.why // empty' <<< "$choice")"
if [[ -n "$why" ]]; then
  blocked_log "$project" "$key" "$variation" "Check First" "Not re-checked: $why. On to Troubleshoot."
  jq -c '{ rechecked: false, "recheck-why": .why }' <<< "$choice"
  echo "$command: not re-checked: $why" >&2
  exit 3
fi
at="$(jq -r .at <<< "$choice")" line="$(jq -r .command <<< "$choice")"
argv=()
while IFS= read -r word; do argv+=("$word"); done < <(jq -r '.argv[1:][]' <<< "$choice")
code=0
output="$("$here_vm/../../agent.sh" "${argv[@]}" 2>&1 < /dev/null)" || code=$?
if [[ "$code" -eq 0 ]]; then
  blocked_log "$project" "$key" "$variation" "Check First" "Passed on re-check; nothing to fix. Re-ran \`$line\` (the step $at, where it was blocked): exit 0. No agent dispatched; the ticket resumes."
  jq -nc --arg at "$at" --arg line "$line" '{ "needs-fix": false, rechecked: true, "recheck-passed": true, summary: "Passed on re-check; nothing to fix", recheck: { at: $at, command: $line, exit: 0 } }'
  exit 0
fi
tail_lines="$(tail -n 20 <<< "$output" | cut -c 1-300)"
blocked_log "$project" "$key" "$variation" "Check First" "Re-checked the step $at: \`$line\` still fails (exit $code). On to Troubleshoot. Its last lines:"$'\n```\n'"$tail_lines"$'\n```'
jq -nc --arg at "$at" --arg line "$line" --argjson code "$code" --arg tail "$tail_lines" '{ rechecked: true, recheck: { at: $at, command: $line, exit: $code, output: $tail } }'
exit 3
