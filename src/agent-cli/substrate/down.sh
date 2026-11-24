#!/usr/bin/env bash
# Description: Tear down a project's part of its Substrate cluster (namespace, WorkerPool, atespace, kubeconfig file), and the cluster itself once no other project uses it or with --cluster — substrate:down <project> [<machine>] [--cluster]; prints what it did.
set -euo pipefail

# ASS-533: on-machine/substrate.sh down on the cluster's machine, under its
# lock. The Mac's cluster is shared by every Mac project: it is deleted only
# when no other project's namespace is left in it (or with --cluster). kind
# deletes the cluster's entry from the project's own kubeconfig file, which
# is then removed; ~/.kube/config is never read or written. A remote machine
# with no open connection fails (connect it first: down never starts one).
# The machine's entry is removed from data/projects/<project>/substrate.json.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"

command=substrate:down
cluster=""
args=()
for a in "$@"; do if [[ "$a" == --cluster ]]; then cluster=--cluster; else args+=("$a"); fi; done
set -- "${args[@]+"${args[@]}"}"
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: $command <project> [<machine>] [--cluster]" >&2; exit 1; }
project="$1" machine="${2:-mac}"
entry="$(substrate_entry "$command" "$project" "$machine")"
[[ "$(substrate_host "$entry")" != gke ]] || { echo "$command: $project's $machine entry is GKE, which the harness never set up" >&2; exit 2; }
substrate_lock "$command" "$project" "$machine" "$entry"
substrate_connected "$project" "$machine" "$entry" || { echo "$command: $project's $machine has no open connection: workstation:connect $project $machine first" >&2; exit 1; }
rc=0
out="$(substrate_on "$project" "$machine" "$entry" down $cluster </dev/null)" || rc=$?
result="$(tail -n 1 <<< "$out")"
jq -e 'type == "object" and has("ok")' <<< "$result" >/dev/null 2>&1 \
  || result="$(jq -cn --arg why "it exited $rc and printed no result" '{ ok: false, did: [], failed: [{ what: "substrate:down", why: $why }] }')"
if [[ "$(jq -r .ok <<< "$result")" == true ]]; then
  update_json --create "$substrate_projects/$project/substrate.json" --arg m "$machine" 'del(.[$m])'
fi
printf '%s\n' "$result"
[[ "$(jq -r .ok <<< "$result")" == true ]] || { echo "$command: $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$result")" >&2; exit 1; }
