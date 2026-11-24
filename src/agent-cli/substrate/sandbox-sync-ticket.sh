#!/usr/bin/env bash
# Description: Bring a ticket variation's Substrate sandbox's read-only copy of the ticket folder (/mnt/ticket) up to date — substrate:sandbox-sync-ticket <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-535: a sandbox has no mount of the Mac's ticket folder (a VM's
# /mnt/ticket), so control copies it in before each agent and in-machine
# script there (src/control/sandboxes.js), as it copies a workstation's
# (ASS-435). Fails when the variation has no sandbox (1), when its sandbox is
# hibernated (3), or the copy fails (1) or leaves /mnt/ticket short (4).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"

command=substrate:sandbox-sync-ticket
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
record="$(sandbox_of "$command" "$project" "$key" "$variation")" || { echo "$command: no $key variation $variation in $project's sprint" >&2; exit 1; }
[[ "$record" != null ]] || { echo "$command: $key $variation has no sandbox" >&2; exit 1; }
# ASS-567: never into a hibernated sandbox (a copy made as it was suspended was lost); substrate:sandbox-up copies the
# folder as it resumes it. A copy that leaves /mnt/ticket short exits 4 (sandbox_ticket_copy).
[[ "$(jq -r '.state // "running"' <<< "$record")" == running ]] || { echo "$command: $key $variation's sandbox is $(jq -r .state <<< "$record") (hibernated): substrate:sandbox-up resumes it and copies the ticket folder" >&2; exit 3; }
sandbox_ticket_copy "$command" "$project" "$key" "substrate:$(jq -r '"\(.project):\(.machine):\(.name)"' <<< "$record")"
