#!/usr/bin/env bash
# Description: Move a ticket variation's VM's repositories to its branches before one of its steps runs there — vm:step-start <project> <ticket-key> <variation>; prints what it did.
set -euo pipefail

# ASS-468 AC4: in vm+workstation mode a variation's step runs on a
# workstation when one is free, else in its own VM (control,
# src/control/workstation-steps.js), so it may move between the two from
# step to step. Before a step in its VM, the VM's repositories are brought
# to where a workstation step would find them (step-trees.sh start, as
# workstation:claim does there): each fetched, the variation's planned
# repositories on their branches (change/<KEY>-<id>, fast-forwarded to
# GitLab's, made from the planned base when GitLab has none yet), the others
# on master at the latest — as vm:refresh-repositories moves the others —
# and each repository's git hooks set to refuse a commit on master (AC10,
# git-hooks.sh). ASS-480: a stray local branch (another ticket's, or its own
# parted from GitLab's with commits GitLab never had) is set aside under
# refs/harness/stray/ first, never pushed, and listed in the summary's
# set-aside. Every step commits and pushes its own work (AC9); its
# matching vm:step-end commits what a completed step left, pushes and cleans
# at the step's end, so nothing
# a step did is lost wherever the next one runs. The VM must be running.
# Prints the summary step-trees gives (workstation-variation.bash wsv_trees);
# fails when a repository could not be checked out. ASS-503: then each
# repository whose pnpm-lock.yaml changed since its deps were installed gets
# `pnpm install --frozen-lockfile` (vm.bash vm_install_deps), a line on stderr
# for each saying installed or skipped; fails when one could not be, naming it.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

command=vm:step-start
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
vm="$(running_vm "$command" "$project" "$key" "$variation")"
! machine_remote "$vm" || { echo "$command: $key $variation's machine is a workstation's or a cloud VM's ($vm): workstation:claim starts its steps there" >&2; exit 1; }
wsv_trees "$command" "$vm" start "$project" "$key" "$variation" -
vm_install_deps "$command" "$vm" "$project" || exit 1
