#!/usr/bin/env bash
# Description: Delete a project's VMs cloned from an older golden image, which pin its deleted blocks — vm:reclaim <project> [--dry-run]; prints { project, golden-built-at, dry-run, deleted, kept }.
set -euo pipefail

# ASS-287 AC1: vm:build-golden deletes them once it has swapped a new image in;
# this does the same at any time — for the VMs kept then, once their variations
# have ended, and for those a build left before ASS-287. Under the project's VM
# lock: see vm.bash reclaim_generations. Only the project's VMs (its inventory,
# or recorded on its active sprint's variations) whose golden-image.json's
# built-at is not golden-<project>'s, and only those stopped whose variation
# is not in flight; a running or in-flight one is listed as kept, with why.
# --dry-run deletes nothing, listing what it would.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 1 || ( $# -eq 2 && "$2" == --dry-run ) ]] || { echo "usage: vm:reclaim <project> [--dry-run]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "vm:reclaim: no project '$1'" >&2; exit 1; }
lock_vms vm:reclaim "$1"
reclaim_generations vm:reclaim "$1" ${2:+dry-run}
