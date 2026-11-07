#!/usr/bin/env bash
# Description: A project's VMs and their disk use, against its limit — vm:inventory <project>; prints { project, limit-bytes, use-bytes, golden-bytes, golden-built-at, vms: [{ name, ticket, variation, state, disk-bytes, last-accessed, deletable, credential-kind?, golden-built-at, old-generation }] }, oldest access first (credential-kind the one vm:credentials last injected, 'claude' or 'anthropic', absent when the project declares neither; ASS-215).
set -euo pipefail

# The inventory (data/projects/<project>/vms.json, ASS-75) reconciled with limactl
# list and the active sprint first, under the project's VM lock: see vm.bash
# reconcile_vms. Fails on an unknown project, or without harness.json's
# vm-disk-limit-gb.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:inventory <project>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "vm:inventory: no project '$1'" >&2; exit 1; }
lock_vms vm:inventory "$1"
reconcile_vms vm:inventory "$1"
