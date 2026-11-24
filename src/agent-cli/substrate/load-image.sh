#!/usr/bin/env bash
# Description: Load an image archive (docker save's) into a project's Substrate cluster, on the Mac or sent over its workstation's or cloud VM's SSH connection — substrate:load-image <project> <machine> <archive|->; prints what it did.
set -euo pipefail

# ASS-533: the hook ASS-534's sandbox images come in by. They are built and
# kept on the Mac (operator decision, 2026-11-22), and a remote cluster gets
# one over the machine's existing SSH connection — the archive streamed to
# on-machine/substrate.sh load-image there, which loads it into the kind node
# (kind load image-archive), so the cluster never pulls it from a registry and
# the machine needs no registry login. - reads the archive from stdin (e.g.
# docker save <image> | agent.sh substrate:load-image p m -). Under the
# cluster's lock; the cluster must be up (substrate:up).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"

command=substrate:load-image
[[ $# -eq 3 ]] || { echo "usage: $command <project> <machine> <archive|->" >&2; exit 1; }
project="$1" machine="$2" archive="$3"
entry="$(substrate_entry "$command" "$project" "$machine")"
[[ "$(substrate_host "$entry")" != gke ]] || { echo "$command: $project's $machine entry is GKE, which the harness never set up" >&2; exit 2; }
[[ "$archive" == - || -f "$archive" ]] || { echo "$command: no archive $archive" >&2; exit 1; }
substrate_lock "$command" "$project" "$machine" "$entry"
substrate_connected "$project" "$machine" "$entry" || { echo "$command: $project's $machine has no open connection: workstation:connect $project $machine first" >&2; exit 1; }
if [[ "$archive" == - ]]; then substrate_on "$project" "$machine" "$entry" load-image
else substrate_on "$project" "$machine" "$entry" load-image < "$archive"; fi
