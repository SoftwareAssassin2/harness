#!/usr/bin/env bash
# Description: Record a ticket variation's VM — ticket:set-vm <project> <ticket-key> <variation> <vm-name> <ip|""> [recreated].
set -euo pipefail

# Writes the variation's "vm" in the project's active sprint (see
# sprint.bash), next to its build: { name, ip, created-at } (ASS-74), as
# vm:create records it. Control finds the VM by name (limactl shell); the IP
# (vzNAT, reachable from the Mac) is for the demo browser and is re-recorded
# at every start. created-at is kept while the name stays the same, so a VM
# reused keeps its own — unless it was `recreated` (vm:create, ASS-75: deleted
# to make room, and needed again), which sets created-at and recreated-at to
# now, so the lost disk shows. An empty IP records none (or keeps the
# one recorded): vm:create links a VM it has just cloned, before it starts
# (ASS-234). Fails, writing nothing, on an unknown ticket or
# variation, or a name that is no Lima instance name.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 5 || ( $# -eq 6 && "$6" == recreated ) ]] || { echo "usage: ticket:set-vm <project> <ticket-key> <variation> <vm-name> <ip> [recreated]" >&2; exit 1; }
[[ "$4" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || { echo "ticket:set-vm: invalid VM name '$4'" >&2; exit 1; }
[[ "$5" =~ ^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)?$ ]] || { echo "ticket:set-vm: invalid IP '$5'" >&2; exit 1; }

update_whole_ticket ticket:set-vm "$1" "$2" --arg name "$3" --arg vm "$4" --arg ip "$5" --arg recreated "${6:-}" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | (if $ip == "" then {} else { ip: $ip } end) as $ip
  | .variations |= map(if .name != $name then .
      elif $recreated != "" then .vm = { name: $vm } + $ip + { "created-at": $at, "recreated-at": $at }
      elif .vm.name == $vm then .vm += $ip
      else .vm = { name: $vm } + $ip + { "created-at": $at } end)'
