#!/usr/bin/env bash
# Description: Set the run targets a project has and allows, in its default order (ASS-540): local-substrate, workstation-substrate, cloud-vm-substrate, local-vm, workstation, cloud-vm, workstation-worktree, cloud-vm-worktree (ASS-553), local-worktree, local-workspace — project:set-run-targets <project> <target>…; validated, written to dev-environments.run-targets (its mode removed).
set -euo pipefail

# Writes data/projects/<project>/project.json's dev-environments.run-targets
# (PROJECTS_DIR overrides the projects folder, used by tests): the targets in
# the order given, which is the project's default order (a step with no
# run-targets of its own takes the first of them with a free seat; one with
# its own list takes the first of those the project also lists). It replaces
# dev-environments.mode, which is removed. The whole file is rewritten under
# its lock (json-file.bash: lock_on, then write_json), checked first by
# control's own rules (src/control/run-targets.js, dev-environments.js):
# fails, writing nothing and naming each field, on an unknown or repeated
# target, workstation (or workstation-substrate, workstation-worktree) with no workstation listed,
# cloud-vm (or cloud-vm-substrate, cloud-vm-worktree) with no cloud VM, or a substrate target
# with no cluster declared on that kind of host (dev-environments.substrate
# .clusters). Control rereads project.json every tick: no restart needed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

command=project:set-run-targets
[[ $# -ge 2 ]] || { echo "usage: $command <project> <target>…" >&2; exit 1; }
project="$1"; shift
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "$command: invalid project '$project'" >&2; exit 1; }
file="$(readlink -f "$projects/$project/project.json")"
lock_on 9 "$file.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}"
next="$(node "$here/run-targets.js" set "$file" "$@" 2> >(sed "s/^/$command: /" >&2))" || exit 1
write_json "$file" --argjson next "$next" '$next'
echo "$project: run targets $*"
