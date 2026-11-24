#!/usr/bin/env bash
# Description: Make or resume a ticket variation's own Substrate sandbox on the cluster of the machine its seat is on (mac, or a workstation's or cloud VM's id), from the project's sandbox image, reach its command server from the Mac, and give it its forwarder token and egress to the Mac's forwarder and Hindsight (ASS-536) — substrate:sandbox-up <project> <ticket-key> <variation> <machine>; prints JSON.
set -euo pipefail

# ASS-535 AC1 (src/control/machine-substrate.js says the design; control runs
# this for a variation whose step runs on a substrate run target). Under the
# cluster's lock, in order:
#  1. A sandbox the variation has on another machine is refused: control
#     moves its work out first (substrate:sandbox-delete --keep-work).
#  2. The machine's connection must be open (a remote one: control connects
#     it); the image of its architecture is in its cluster's registry
#     (substrate:deliver-image <project> <machine>: nothing when current).
#  3. A new sandbox: the project's template for that image
#     (sandbox-<digest's first 12>, made and its golden snapshot waited for
#     when missing), then the actor <key>-<variation> made from it. An existing
#     one keeps the template it was made from (its files are the ticket's).
#  4. It resumed when suspended (the WorkerPool grown by a worker when none
#     has room), its proxy and endpoint up (sandbox.bash sandbox_endpoint).
#  4a. ASS-536: its way to the Mac — its egress rule set "mac" (the
#     forwarder's port and its project's Hindsight's, on the Mac's name as its
#     cluster sees it; on a workstation or cloud VM the relay over the
#     machine's SSH connection first): sandbox.bash sandbox_reach_cluster;
#     then a fresh forwarder token, bound in vm-tokens.json, and agent.sh put
#     in it (sandbox_token), as vm:start does for a VM.
#  5. The ticket folder's read-only copy at /mnt/ticket; for a new sandbox,
#     the variation's own branches brought in from origin (relay.bash
#     relay_in), so it starts where the ticket's work stands.
# ASS-538: before 1, the cluster's credentials synced when they never were, or
# with another allowlist or declaration (substrate:credentials: the Secrets the
# egress gateway injects from); with 3, the sandbox's egress policy (its host
# allowlist and which header gets which credential: src/substrate/egress.js)
# created or brought up to date, made or not; after 5, its placeholders
# written as root (/etc/profile.d/harness-credentials.sh, /etc/harness/
# gitconfig and npmrc: egress.js placeholderScript) — no token enters it.
# Records the variation's `sandbox` { name, project, machine, template,
# image, state: running, created-at, at } and prints it with its machine
# (substrate:<project>:<machine>:<name>) and port, whether it was made
# (created) or resumed from hibernation (resumed), and how long it took
# (seconds) — ASS-542: substrate:stack-up, run next, records those as the
# ticket's time to first start and to resume.
# ASS-568: a sandbox whose actor has crashed (Substrate's ACTOR_STATE_CRASHED:
# its worker restarted or went away — a Docker restart, a node restart — or
# its snapshot was lost) cannot be resumed: exit 4 (EXIT_CRASHED), saying so
# ("… has crashed (crashed: <Substrate's reason>)"), whether it was seen
# crashed before the resume or the resume found it so. Nothing is changed:
# control replaces it (src/control/sandboxes.js: substrate:sandbox-delete
# --salvage, then a new one at the step's next try).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"
source "$here/relay.bash"
source "$here/egress.bash"

command=substrate:sandbox-up
began=$SECONDS
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <machine>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" machine="$4"
entry="$(substrate_entry "$command" "$project" "$machine")"
[[ "$(substrate_host "$entry")" != gke ]] || { echo "$command: $project's $machine entry is GKE, which the harness never sets up" >&2; exit 2; }
actor="$(sandbox_actor "$key" "$variation")"
record="$(sandbox_of "$command" "$project" "$key" "$variation")" || { echo "$command: no $key variation $variation in $project's sprint" >&2; exit 1; }
was="$(jq -r '.machine // empty' <<< "$record")"
[[ -z "$was" || "$was" == "$machine" ]] || { echo "$command: $key $variation's sandbox is on $was: move its work out first (substrate:sandbox-delete $project $key $variation --keep-work)" >&2; exit 1; }
substrate_connected "$project" "$machine" "$entry" || { echo "$command: $project's $machine has no open connection (control connects it for a step that needs it)" >&2; exit 1; }
decl="$(egress_decl "$command" "$project")"
egress="$(egress_info "$command" "$project" "$decl")"
egress_synced "$project" "$machine" "$(jq -r .hash <<< "$egress")" || "$sandbox_agent" substrate:credentials "$project" "$machine" >/dev/null \
  || { echo "$command: $project's credentials could not be synced into $machine's cluster (substrate:credentials above)" >&2; exit 1; }

substrate_lock "$command" "$project" "$machine" "$entry"
state="$(substrate_on "$project" "$machine" "$entry" sandbox-state "$actor" </dev/null | tail -n 1)"
# crashed_exit <state json> — ASS-568: exit 4 when the sandbox-state says crashed (see above).
crashed_exit() {
  [[ "$(jq -r '.state // empty' <<< "$1" 2>/dev/null)" == crashed ]] || return 0
  echo "$command: the sandbox $actor on $machine has crashed ($(jq -r '"crashed" + (if .crash then ": \(.crash)" else "" end)' <<< "$1")): it cannot be resumed; control replaces it (substrate:sandbox-delete $project $key $variation --salvage, then a new one)" >&2
  exit 4
}
crashed_exit "$state"
resumed=false
[[ "$(jq -r 'if .exists == true and (.state // "") != "running" and (.state // "") != "resuming" then "yes" else "no" end' <<< "$state" 2>/dev/null)" != yes ]] || resumed=true
created=false template="$(jq -r '.template // empty' <<< "$record")" image="$(jq -r '.image // empty' <<< "$record")"
if [[ "$(jq -r .exists <<< "$state")" != true ]]; then
  "$sandbox_agent" substrate:deliver-image "$project" "$machine" >/dev/null \
    || { echo "$command: $project's sandbox image is not in $machine's cluster registry (substrate:deliver-image above)" >&2; exit 1; }
  image="$(jq -r --arg m "$machine" '.[$m].digest // empty' "$projects/$project/sandbox-deliveries.json")"
  [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "$command: no sandbox image delivered to $machine" >&2; exit 1; }
  template="sandbox-${image:7:12}"
  out="$(substrate_on "$project" "$machine" "$entry" sandbox-template "sandbox/$project@$image" "$template" </dev/null | tail -n 1)" \
    || { echo "$command: $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$out" 2>/dev/null)" >&2; exit 1; }
  out="$(substrate_on "$project" "$machine" "$entry" sandbox-up "$actor" "$template" </dev/null | tail -n 1)" \
    || { echo "$command: $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$out" 2>/dev/null)" >&2; exit 1; }
  created="$(jq -r '.created' <<< "$out")"
fi
sandbox_reach_cluster "$command" "$project" "$machine" "$entry" "$actor"   # ASS-536 (step 4a)
# ASS-538: the gateway's hosts and credentials as the sandbox's rule set `credentials`, beside ASS-536's `mac`.
out="$(jq -c .policy.rules <<< "$egress" | substrate_on "$project" "$machine" "$entry" sandbox-egress "$actor" credentials | tail -n 1)" \
  || { echo "$command: the sandbox $actor's egress rules (credentials): $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$out" 2>/dev/null)" >&2; exit 1; }
exec 7>&-
port="$(sandbox_endpoint "$command" "$project" "$machine" "$entry" "$actor")" \
  || { crashed_exit "$(substrate_on "$project" "$machine" "$entry" sandbox-state "$actor" </dev/null | tail -n 1)"; exit 1; }
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record="$(jq -nc --arg a "$actor" --arg p "$project" --arg m "$machine" --arg t "$template" --arg i "$image" --arg at "$now" --argjson was "$record" \
  '{ name: $a, project: $p, machine: $m, template: (if $t == "" then null else $t end), image: (if $i == "" then null else $i end), state: "running",
     "created-at": ($was["created-at"] // $at), at: $at }')"
sandbox_set "$command" "$project" "$key" "$variation" "$record"
name="substrate:$project:$machine:$actor"
sandbox_token "$command" "$project" "$key" "$variation" "$name" "$(sandbox_mac_host "$project" "$machine" "$entry")"   # ASS-536
sandbox_ticket_copy "$command" "$project" "$key" "$name"
egress_placeholders "$command" "$project" "$decl" | sandbox_root "$name" bash -s >/dev/null \
  || { echo "$command: the credential placeholders could not be written in $name" >&2; exit 1; }
moved=""
[[ "$created" != true ]] || moved="$(relay_in "$command" "$project" "$key" "$variation" "$name")"
jq -c --arg n "$name" --argjson port "$port" --argjson c "$created" --argjson r "$resumed" --argjson s "$((SECONDS - began))" --arg moved "$moved" \
  '. + { machine: $n, host: .machine, port: $port, created: $c, resumed: $r, seconds: $s, branches: ($moved | split("\n") | map(select(. != "") | split("\t") | { repo: .[0], branch: .[1] })) }' <<< "$record"
