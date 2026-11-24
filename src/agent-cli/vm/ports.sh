#!/usr/bin/env bash
# Description: Each Lima instance's pinned ssh port and the clashes among them — vm:ports [--fix]; prints { vms: [{ name, port, status }], clashes: [{ port, vms, keeps, reason }], repinned: [{ name, from, to }] }; --fix re-pins the clashing stopped VMs to free ports.
set -euo pipefail

# ASS-467 (and ASS-465). Every instance in every Lima folder in use (ASS-578) whose lima.yaml pins
# ssh.localPort (vm.bash pinned_ports): ticket VMs of every project, golden
# images and vm:test-repos VMs alike, with its status (limactl list). A clash
# is a port pinned by two or more instances (reason "shared"): the one that
# runs keeps it (else the first by name), the others must move; or a stopped
# instance's port something on the Mac listens on now ("held": a golden
# image's automatic port, say), which must move. clashes lists each, with
# the instance that keeps it (keeps, null when none does). Read-only without
# --fix. With --fix each instance that must move and is stopped is re-pinned
# to a free port no other instance pins (vm.bash ssh_repin, under its
# project's VM lock when a project's vms.json has it, so no vm:start races
# it), said on stderr; a running one is left, as Lima only reads lima.yaml as
# it starts. Prints the state after any fix, repinned listing what moved;
# exits 1 while a clash remains. vm:start repairs a clash of its own VM as it
# starts it, so this is for the operator's look across all of them.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 0 || ( $# -eq 1 && "$1" == --fix ) ]] || { echo "usage: vm:ports [--fix]" >&2; exit 1; }

# report — the JSON above but repinned, from lima.yaml, limactl list and the ports in use now.
report() {
  local pins statuses stopped held
  pins="$(pinned_ports)"
  statuses="$(lima_list_all --format '{{.Name}}	{{.Status}}' 2>/dev/null || true)"
  stopped="$(awk -F'\t' 'NR == FNR { if ($2 == "Stopped") s[$1] = 1; next } s[$1] { print $2 }' <(printf '%s\n' "$statuses") <(printf '%s\n' "$pins") | sort -u)"
  # shellcheck disable=SC2086
  held="$(ports_in_use $stopped)"
  jq -n --rawfile pins <(printf '%s\n' "$pins") --rawfile statuses <(printf '%s\n' "$statuses") --rawfile held <(printf '%s\n' "$held") '
    def rows($t): $t | split("\n") | map(select(length > 0) | split("\t"));
    (rows($statuses) | map({ (.[0]): .[1] }) | add // {}) as $status
    | (rows($held) | map(.[0] | tonumber)) as $held
    | (rows($pins) | map({ name: .[0], port: (.[1] | tonumber), status: ($status[.[0]] // "Unknown") }) | sort_by(.port, .name)) as $vms
    | ($vms | group_by(.port) | map(select(length > 1)
        | (map(select(.status == "Running")) + map(select(.status != "Running")))[0].name as $keeps
        | { port: .[0].port, vms: map(.name), keeps: $keeps, reason: "shared" })) as $shared
    | ($shared | map(.port)) as $sharedPorts
    | ($vms | map(select(.status == "Stopped" and (.port | IN($held[])) and (.port | IN($sharedPorts[]) | not))
        | { port, vms: [.name], keeps: null, reason: "held" })) as $heldClashes
    | { vms: $vms, clashes: ($shared + $heldClashes | sort_by(.port)) }'
}

before="$(report)"
repinned='[]'
if [[ "${1-}" == --fix ]]; then
  while IFS=$'\t' read -r vm from; do
    [[ -n "$vm" ]] || continue
    owner=""
    for file in "$projects"/*/vms.json; do
      [[ -f "$file" ]] && jq -e --arg vm "$vm" 'has($vm)' "$file" >/dev/null 2>&1 && { owner="$(basename "$(dirname "$file")")"; break; }
    done
    [[ -z "$owner" ]] || lock_vms vm:ports "$owner" || { echo "vm:ports: $vm left as it is: $owner's VM lock could not be taken" >&2; continue; }
    if [[ "$(machine_status "$vm" 2>/dev/null)" == Stopped ]] && ssh_repin vm:ports "$vm"; then
      to="$(pinned_ports | awk -F'\t' -v vm="$vm" '$1 == vm { print $2 }')"
      [[ "$to" == "$from" ]] || repinned="$(jq -c --arg n "$vm" --argjson f "$from" --argjson t "${to:-null}" '. + [{ name: $n, from: $f, to: $t }]' <<< "$repinned")"
    else
      echo "vm:ports: $vm left on port $from: it is not stopped, or could not be re-pinned" >&2
    fi
    [[ -z "$owner" ]] || unlock_vms
  done < <(jq -r '.vms as $vms | .clashes[] | .port as $p | .keeps as $k | .vms[] | select(. != $k) as $n
    | select(($vms[] | select(.name == $n) | .status) == "Stopped") | "\($n)\t\($p)"' <<< "$before")
fi
after="$(report)"
jq --argjson r "$repinned" '. + { repinned: $r }' <<< "$after"
jq -r '.clashes[] | "vm:ports: port \(.port) clashes (\(.reason)): \(.vms | join(", "))\(if .keeps then "; \(.keeps) keeps it" else "" end)"' <<< "$after" >&2
[[ "$(jq '.clashes | length' <<< "$after")" == 0 ]]
