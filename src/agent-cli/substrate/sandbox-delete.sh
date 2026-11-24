#!/usr/bin/env bash
# Description: Delete a ticket variation's Substrate sandbox (with --keep-work, its own branches pushed to origin through the Mac first; with --salvage, a crashed one's, as far as its files can still be read), forget its endpoint and record, and revoke its forwarder token — substrate:sandbox-delete <project> <ticket-key> <variation> [--keep-work|--salvage]; prints JSON.
set -euo pipefail

# ASS-535 AC1. Control runs it once the ticket is done or set aside, and with
# --keep-work when the variation's seat moved to another machine (its next
# sandbox is made there and brings the branches in again). --keep-work
# resumes it when suspended, then relay.bash relay_out (what is left
# uncommitted committed, each of the variation's branches pushed through the
# Mac); a failure there keeps the sandbox (exit 1). Then: its proxy ended, the
# actor deleted, the Mac's forward and endpoint file gone, the variation's
# `sandbox` removed, and (ASS-536) its forwarder token revoked: its binding
# gone from vm-tokens.json, so the token works no more, nor its egress rule
# sets, which go with the actor. A variation with no sandbox: nothing (exit 0); one whose
# ticket is gone from the sprint: the sandbox named <key>-<variation> on each
# of the project's clusters is deleted all the same.
#
# ASS-568: --salvage, for a sandbox whose actor has crashed (control runs it
# when substrate:sandbox-up exits 4): its work is saved as --keep-work saves
# it, but only as far as it can be — only when its command server still
# answers at its recorded endpoint (it is never resumed: a crashed actor
# cannot be), and a failure there never stops the delete. A crashed actor's
# files usually cannot be read, so this is best effort. Prints, besides,
# `salvaged` (whether its branches were pushed) and `salvage` (why not, when
# they were not).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"
source "$here/relay.bash"

command=substrate:sandbox-delete
[[ $# -eq 3 || ( $# -eq 4 && ( "${4:-}" == --keep-work || "${4:-}" == --salvage ) ) ]] || { echo "usage: $command <project> <ticket-key> <variation> [--keep-work|--salvage]" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" keep="${4:-}"
actor="$(sandbox_actor "$key" "$variation")"
if record="$(sandbox_of "$command" "$project" "$key" "$variation" 2>/dev/null)"; then
  [[ "$record" != null ]] || { echo '{"deleted":false,"reason":"no sandbox"}'; exit 0; }
  machines=("$(jq -r .machine <<< "$record")") actor="$(jq -r .name <<< "$record")"
else
  record=null
  mapfile -t machines < <(node "$here/../substrate.js" "$substrate_projects" "$project" | jq -r 'select(.kind == "kind") | .machine')
fi
moved="" salvaged=false salvage=""
for machine in ${machines[@]+"${machines[@]}"}; do
  entry="$(substrate_entry "$command" "$project" "$machine")"
  if [[ "$keep" == --keep-work && "$record" != null ]]; then
    substrate_connected "$project" "$machine" "$entry" || { echo "$command: $machine is not connected: $key $variation's work cannot be moved out of its sandbox yet" >&2; exit 1; }
    sandbox_endpoint "$command" "$project" "$machine" "$entry" "$actor" >/dev/null
    moved="$(relay_out "$command" "$project" "$key" "$variation" "substrate:$project:$machine:$actor" "its sandbox on $machine")" || exit 1
  elif [[ "$keep" == --salvage && "$record" != null ]]; then
    # ASS-568: best effort, never resuming it (see above).
    port="$(jq -r '.port // empty' "$(sandbox_endpoint_file "$project" "$actor")" 2>/dev/null || true)"
    if [[ ! "$port" =~ ^[0-9]+$ ]]; then salvage="no endpoint to reach its files at"
    elif ! sandbox_answers "$port"; then salvage="its files cannot be read: its command server does not answer"
    else
      errs="$(mktemp)"
      if moved="$(relay_out "$command" "$project" "$key" "$variation" "substrate:$project:$machine:$actor" "its crashed sandbox on $machine" 2>"$errs")"; then salvaged=true
      else moved=""; salvage="its branches could not be pushed: $(grep -v '^[[:space:]]*$' "$errs" | tail -n 1)"; fi
      rm -f "$errs"
    fi
  fi
  substrate_connected "$project" "$machine" "$entry" || { echo "$command: $machine is not connected: $actor not deleted" >&2; exit 1; }
  out="$(substrate_on "$project" "$machine" "$entry" sandbox-delete "$actor" </dev/null | tail -n 1)" \
    || { echo "$command: $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$out" 2>/dev/null)" >&2; exit 1; }
  sandbox_forget "$project" "$machine" "$entry" "$actor"
  sandbox_revoke "substrate:$project:$machine:$actor"   # ASS-536 AC3
done
[[ "$record" == null ]] || sandbox_set "$command" "$project" "$key" "$variation" null
jq -nc --arg a "$actor" --arg moved "$moved" --argjson salvaged "$salvaged" --arg salvage "$salvage" --arg keep "$keep" '{ deleted: true, name: $a, branches: ($moved | split("\n") | map(select(. != "") | split("\t") | { repo: .[0], branch: .[1] })) }
  + (if $keep == "--salvage" then { salvaged: $salvaged, salvage: (if $salvage == "" then null else $salvage end) } else {} end)'
