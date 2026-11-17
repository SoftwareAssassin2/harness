#!/usr/bin/env bash
# Description: End a ticket variation's step in its VM — a completed step's leftovers committed, the rest discarded, committed work pushed, master at the latest — vm:step-end <project> <ticket-key> <variation> [--completed <step>]; prints what it did.
set -euo pipefail

# ASS-468 AC4, AC9, AC10: the end of a step a variation of a project in
# vm+workstation mode ran in its own VM (vm:step-start), as
# workstation:release ends one on a workstation (step-trees.sh end): with
# --completed "<the step>" (its agent's turn ended without error, its script
# exited 0) what it left uncommitted is committed on its branch with a
# message naming the ticket and step, else discarded, each file named; its
# planned branch's commits GitLab lacks pushed to that branch (ASS-478: only
# its own, never one GitLab deleted after its merge; never forced,
# never master: a local master ahead of GitLab's reset to it, its commits
# named; ASS-480: another's parted branch set aside under
# refs/harness/stray/), master checked out at the latest. The VM is kept.
# ASS-480: control keeps the VM — never stopped, deleted or reclaimed,
# started for this — until this has succeeded (src/control/step-ends.js). Prints the
# summary (workstation-variation.bash wsv_trees); fails (1) when a tree could
# not be made clean, or the VM is not running.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

command=vm:step-end
[[ $# -eq 3 || ( $# -eq 5 && "$4" == --completed && -n "$5" ) ]] || { echo "usage: $command <project> <ticket-key> <variation> [--completed <step>]" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" completed=incomplete message=""
[[ $# -eq 3 ]] || { completed=completed message="$key $variation $5: what the step left uncommitted, committed by the harness at its end (ASS-468)"; }
vm="$(running_vm "$command" "$project" "$key" "$variation")"
! machine_remote "$vm" || { echo "$command: $key $variation's machine is a workstation's or a cloud VM's ($vm): workstation:release ends its steps there" >&2; exit 1; }
wsv_trees "$command" "$vm" end "$project" "$key" "$variation" "$completed" "$message"
