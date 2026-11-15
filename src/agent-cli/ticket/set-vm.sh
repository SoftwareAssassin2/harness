#!/usr/bin/env bash
# Description: Record a ticket variation's VM, or its workstation — ticket:set-vm <project> <ticket-key> <variation> <vm-name|workstation-id> <ip|""> [recreated] [--kind workstation --folder <folder>].
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
#
# ASS-435: with --kind workstation --folder <folder>, a placement on one of
# the project's GCP workstations (vm:create, workstation-variation.bash):
# { name: <workstation id>, kind: workstation, project: <project>, folder:
# <the variation's folder there, absolute>, created-at } — the machine layer
# names it workstation:<project>:<id>:<folder> (machine.bash $machine_of), and
# control's workstation phase keeps that workstation connected while the
# variation needs it (src/control/workstations.js). No IP (it is reached over
# the workstation's connection), so "" is the only one taken. A VM records no
# kind, as before: one without a kind is a Lima VM. A variation keeps where it
# started (operator decision, 2026-11-14): created-at is kept while the name
# and kind stay the same.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

usage='usage: ticket:set-vm <project> <ticket-key> <variation> <vm-name|workstation-id> <ip|""> [recreated] [--kind workstation --folder <folder>]'
kind="" folder="" args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; kind="$2"; shift 2 ;;
    --folder) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; folder="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"
[[ $# -eq 5 || ( $# -eq 6 && "$6" == recreated ) ]] || { echo "$usage" >&2; exit 1; }
if [[ -n "$kind" || -n "$folder" ]]; then
  [[ "$kind" == workstation ]] || { echo "ticket:set-vm: invalid kind '$kind' (workstation, or none for a VM)" >&2; exit 1; }
  [[ "$folder" == /*/harness/* && "$folder" != *:* ]] || { echo "ticket:set-vm: invalid workstation folder '$folder' (absolute, under ~/harness)" >&2; exit 1; }
  [[ "$4" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:set-vm: invalid workstation id '$4'" >&2; exit 1; }
  [[ -z "$5" ]] || { echo "ticket:set-vm: a workstation records no IP" >&2; exit 1; }
else
  [[ "$4" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || { echo "ticket:set-vm: invalid VM name '$4'" >&2; exit 1; }
  [[ "$5" =~ ^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)?$ ]] || { echo "ticket:set-vm: invalid IP '$5'" >&2; exit 1; }
fi

update_whole_ticket ticket:set-vm "$1" "$2" --arg name "$3" --arg vm "$4" --arg ip "$5" --arg recreated "${6:-}" --arg kind "$kind" --arg folder "$folder" --arg wsproject "$1" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | (if $ip == "" then {} else { ip: $ip } end) as $ip
  | (if $kind == "" then { name: $vm } else { name: $vm, kind: $kind, project: $wsproject, folder: $folder } end) as $id
  | .variations |= map(if .name != $name then .
      elif $recreated != "" then .vm = $id + $ip + { "created-at": $at, "recreated-at": $at }
      elif .vm.name == $vm and (.vm.kind // "") == $kind and (.vm.folder // "") == $folder then .vm += $ip
      else .vm = $id + $ip + { "created-at": $at } end)'
