#!/usr/bin/env bash
# Description: The Demo action at human review — vm:demo <project> <ticket-key> <variation>: the variation's VM up with a window onto its desktop, its demo plan's setup run and ready-check passed, its tool open; prints { name, ip, view, look-at }.
set -euo pipefail

# ASS-76 AC2, AC3. The operator triggers it on the ticket screen at Human
# Review (its human actions offer Demo when the plan has demo: true). In order:
#  1. The variation's demo plan (ticket:demo-plan): one with demo: false, or
#     none, fails.
#  2. The variation's VM (recorded on it, vm:create) running with a display:
#     video.display vz, which opens a window onto the VM's desktop on the Mac.
#     One running without it is stopped and started again with it (vm:start
#     --display: sandboxed, logged in, its token and agent.sh fresh — and the
#     start recorded in the inventory, so a demo counts as an access for the
#     least-recently-used deletion, ASS-75). Under the project's VM lock
#     throughout, so control — which starts a stopped VM whose step says `vm:
#     running`, as Review's does — waits, then finds it running and leaves
#     it be. Every other start (vm:start) is without a display, so a VM a
#     demo left with one, once stopped (Release, Done) or closed, comes back
#     without.
#  3. Each of the plan's setup commands, in order, with bash in /repos/; then
#     its ready-check, every DEMO_READY_INTERVAL seconds (5) until it exits 0
#     or DEMO_READY_TIMEOUT seconds (300) have passed. A setup command that
#     fails, or a ready-check that never passes, blocks the ticket: it moves
#     to the engine's blocked state (is-blocked-state, Blocked for Human), the
#     command and its (last) output its ai-feedback, and this fails saying so.
#     Each runs detached from this shell's output, so a server it starts in
#     the background does not hold it. Closing the VM's window on the Mac
#     stops the VM (its host agent exits); one that stops during the demo
#     fails it, blocking nothing, and control starts it again, without a
#     display, while its step says `vm: running`.
#  4. Only then the desktop: lightdm started and the plan's tool opened on it
#     (in-vm/demo-desktop.sh) — the browser at the address, a terminal at
#     /repos/ with the commands — and { name, ip, view, look-at } printed: the
#     demo is ready.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 3 ]] || { echo "usage: vm:demo <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
plan="$("$agent" ticket:demo-plan "$project" "$key" "$variation")"
[[ "$(jq -r .demo <<<"$plan")" == true ]] || { echo "vm:demo: $key $variation has no demo: $(jq -r .why <<<"$plan")" >&2; exit 1; }
vm="$(recorded_vm vm:demo "$project" "$key" "$variation")"

lock_vms vm:demo "$project"
[[ "$(limactl list "$vm" --format '{{.Status}} {{.Config.Video.Display}}' 2>/dev/null)" != "Running none" ]] \
  || limactl stop "$vm" >/dev/null 2>&1 || { echo "vm:demo: $vm would not stop to start with a display" >&2; exit 1; }
ip="$(VM_LOCK_HELD=1 "$agent" vm:start "$project" "$key" "$variation" --display | jq -r .ip)"
unlock_vms

# in_vm <command> — runs it with bash in the VM's /repos/, its output (both streams) printed once it ends.
in_vm() {
  limactl shell --workdir /repos "$vm" -- bash -c 'log="$(mktemp)"; bash -c "$1" >"$log" 2>&1 </dev/null; s=$?; cat "$log"; rm -f "$log"; exit $s' - "$1" </dev/null 2>&1
}

# running — fails the demo, blocking nothing, once the VM has stopped: its window closed on the Mac, which stops it.
running() { [[ "$(limactl list "$vm" --format '{{.Status}}' 2>/dev/null)" == Running ]] || { echo "vm:demo: $vm stopped during the demo (its window closed?); nothing is blocked: Demo again" >&2; exit 1; }; }

# block <short> <long> — the ticket to the blocked state, <long> its reason; fails (unless the VM stopped: running).
block() {
  local from to
  running
  from="$(variation_status vm:demo "$project" "$key" "$variation" | head -n 1 | cut -f 2)"
  to="$(engine_steps vm:demo "$project" | jq -r 'first(.[] | select(.["is-blocked-state"] == true) | .id) // empty')"
  if [[ -n "$to" && "$from" != "$to" ]]; then
    "$agent" ticket:change-state "$project" "$key" "$variation" "$from" "$to" >/dev/null
    "$agent" ticket:set-ai-feedback "$project" "$key" "$variation" "$1" "$2"
  fi
  echo "vm:demo: $2" >&2
  exit 1
}

while IFS= read -r command; do
  out="$(in_vm "$command")" || block "Demo setup failed" "the demo's setup command \`$command\` failed in $vm's /repos/: $(tail -n 40 <<<"$out")"
done < <(jq -r '.setup[]' <<<"$plan")

check="$(jq -r '.["ready-check"]' <<<"$plan")"
interval="${DEMO_READY_INTERVAL:-5}" timeout="${DEMO_READY_TIMEOUT:-300}"
deadline=$(( SECONDS + ${timeout%.*} ))
until out="$(in_vm "$check")"; do
  running
  (( SECONDS < deadline )) || block "Demo not ready" "the demo's ready-check \`$check\` did not pass within ${timeout}s of its setup in $vm; its last output: $(tail -n 40 <<<"$out")"
  sleep "$interval"
done

mapfile -t view < <(jq -r '.view | .with, (.address // empty), (.commands // [] | .[])' <<<"$plan")
limactl shell --workdir / "$vm" -- bash -s "${view[@]}" < "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/in-vm/demo-desktop.sh" \
  || { echo "vm:demo: $vm is ready, but its desktop and ${view[0]} would not open" >&2; exit 1; }
jq -c --arg n "$vm" --arg ip "$ip" '{ name: $n, ip: $ip, view, "look-at": .["look-at"] }' <<<"$plan"
