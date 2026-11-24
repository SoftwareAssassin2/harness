#!/usr/bin/env bash
# Description: Create or connect to a project's Substrate cluster (kind, gVisor) on the Mac or on its named workstation or cloud VM, and install or upgrade Substrate to the pinned release from published images; idempotent — substrate:up <project> [<machine>]; prints what it did.
set -euo pipefail

# ASS-533 AC2. <machine> is its dev-environments.substrate.clusters entry's: mac (the
# default: the kind cluster every Mac project shares, harness-substrate), or
# one of the project's workstations or cloud VMs (its own kind cluster, on
# it). A gke entry is refused (exit 2) until the operator approves GKE (AC1).
# Under the cluster's lock (substrate.bash substrate_lock), in order:
#  1. A remote machine's connection opened when it is not
#     (workstation:connect: which starts a stopped machine).
#  2. The kit for the machine's platform built on the Mac when missing, and
#     sent to the machine when it has not got it (substrate.bash).
#  3. on-machine/substrate.sh up there: the machine's host setup, the kind
#     cluster created (or its node started), its kubeconfig written to the
#     project's own file under ~/.harness/substrate (never ~/.kube/config),
#     Substrate installed or upgraded to the pinned release, and the project's
#     namespace, WorkerPool and atespace made.
# A rerun with everything there changes nothing. Records the run as the
# machine's `up` in data/projects/<project>/substrate.json; prints the JSON
# line { ok, did, failed, cluster, kubeconfig, release }; fails (1) when
# anything failed, naming it. HARNESS_SUBSTRATE_REPAIR=1 (control's restart
# of a broken cluster) also deletes pods stuck not ready.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"

command=substrate:up
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: $command <project> [<machine>]" >&2; exit 1; }
project="$1" machine="${2:-mac}"
entry="$(substrate_entry "$command" "$project" "$machine")"
if [[ "$(substrate_host "$entry")" == gke ]]; then
  substrate_record "$project" "$machine" '. + { state: "refused", problems: [], "checked-at": $at }' || true
  echo "$command: $project's $machine entry: $(jq -r .refused <<< "$entry")" >&2
  exit 2
fi
substrate_lock "$command" "$project" "$machine" "$entry"
if ! substrate_connected "$project" "$machine" "$entry"; then
  # ASS-542: without the cluster lock (descriptor 7): the SSH master it opens outlives this command and would hold it.
  "$here_substrate/workstation/connect.sh" "$project" "$machine" >/dev/null 7>&- || { echo "$command: could not connect to $project's $machine" >&2; exit 1; }
fi
substrate_ensure_kit "$command" "$project" "$machine" "$entry"
rc=0
out="$(substrate_on "$project" "$machine" "$entry" up </dev/null)" || rc=$?
result="$(tail -n 1 <<< "$out")"
jq -e 'type == "object" and has("ok")' <<< "$result" >/dev/null 2>&1 \
  || result="$(jq -cn --arg why "it exited $rc and printed no result" '{ ok: false, did: [], failed: [{ what: "substrate:up", why: $why }] }')"
substrate_record "$project" "$machine" --argjson r "$result" '.up = { ok: $r.ok, at: $at, did: $r.did, failed: $r.failed, release: $r.release } | .kubeconfig = ($r.kubeconfig // .kubeconfig)'
printf '%s\n' "$result"
if [[ "$(jq -r .ok <<< "$result")" != true ]]; then
  echo "$command: $project's cluster on $machine: $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$result")" >&2
  exit 1
fi
