#!/usr/bin/env bash
# Description: Keep a ticket variation's VM running for the operator working in it by hand, or release it — vm:hold <project> <ticket-key> <variation> on|off [<note>].
set -euo pipefail

# ASS-427 AC7: control's VM lifecycle stops a VM wherever its variation's step
# does not say `vm: running` — at Blocked for Human, and while the ticket is
# paused or worked by hand — so a VM the operator (or Claude acting for them)
# starts there to apply a fix by hand is stopped again within seconds. on
# writes "vm-hold": { by, since, note } on the variation in the project's
# active sprint — by the operator ($USER), since now (UTC), note the <note> or
# null — and the lifecycle (src/control/vm-lifecycle.js) then keeps its VM
# running, as it keeps one an assignment is on, and starts it when it is
# stopped; off removes it, and the VM is left to its step's rules again
# (stopped, where they say so). Each is logged in the variation's change log
# (work.bash blocked_log) and, as control sees it, in control's log; the TUI
# shows the hold on the ticket. Prints { project, ticket, variation, vm,
# hold } (hold the object, or null). Fails, writing nothing, on anything but
# on or off, a note with off, or an unknown ticket or variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/code.bash"
source "$here_vm/work.bash"

command=vm:hold
[[ ( $# -eq 4 && ( "$4" == on || "$4" == off ) ) || ( $# -eq 5 && "$4" == on ) ]] || { echo "usage: $command <project> <ticket-key> <variation> on|off [<note>]" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" on="$4" note="${5:-}"
variation_exists "$command" "$project" "$key" "$variation"
update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --arg on "$on" --arg by "${USER:-operator}" --arg note "$note" '
  .variations |= map(if .name == $name and (.["is-deleted"] | not) then
    (if $on == "on" then .["vm-hold"] = { by: $by, since: $at, note: (if $note == "" then null else $note end) } else del(.["vm-hold"]) end)
  else . end)'
found="$(variation_field . "$command" "$project" "$key" "$variation")"
vm="$(jq -r '.vm.name // empty' <<< "$found")"
if [[ "$on" == on ]]; then
  blocked_log "$project" "$key" "$variation" "VM hold" "vm:hold on by ${USER:-operator}${note:+: $note}: control keeps ${vm:-its VM (none yet)} running, starting it when stopped, until vm:hold $project $key $variation off."
else
  blocked_log "$project" "$key" "$variation" "VM hold" "vm:hold off by ${USER:-operator}: ${vm:-its VM} is left to its step's rules again (stopped where its step needs none)."
fi
jq -c --arg p "$project" --arg k "$key" --arg v "$variation" --arg vm "$vm" '{ project: $p, ticket: $k, variation: $v, vm: (if $vm == "" then null else $vm end), hold: (.["vm-hold"] // null) }' <<< "$found"
