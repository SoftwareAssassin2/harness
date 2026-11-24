# A ticket variation's Substrate sandbox (ASS-535), for the substrate:sandbox-*
# commands: one sandbox per ticket variation, never shared — a Substrate actor
# in its project's atespace (harness-<project>) on the cluster of the machine
# its seat is on (the Mac's, a workstation's or a cloud VM's; ASS-533), made
# from the project's sandbox image (ASS-534) through a template, reached
# through the image's command server. src/control/machine-substrate.js says the
# whole design; machine-substrate.bash is the machine layer's side.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/sandbox.bash"
#   sandbox_actor <ticket-key> <variation>    # its actor's name: <key>-<variation>, lower case (a k8s-style name)
#   sandbox_of <command> <project> <key> <variation>   # the variation's `sandbox` record, as JSON (null without one)
#   sandbox_set <command> <project> <key> <variation> <json|null>   # the record written (null: removed)
#   sandbox_endpoint <command> <project> <machine> <entry> <actor>   # the sandbox resumed when suspended, its proxy
#                                             # on the cluster's machine, the forward of its port to the Mac (a remote
#                                             # machine's, over its SSH connection), its command server answering;
#                                             # its endpoint file written; prints the port
#   sandbox_ticket_copy <command> <project> <key> <machine-name>   # the ticket folder's read-only copy at /mnt/ticket
#   sandbox_mac_host <project> <machine> <entry>   # ASS-536: the name a sandbox on that cluster reaches the Mac at
#   sandbox_mac_rules <project> <machine> <entry>  # ASS-536: its rule set "mac", a JSON array (the forwarder's and
#                                             # Hindsight's ports alone); the relay first on a remote machine
#   sandbox_token <command> <project> <key> <variation> <machine-name> <host>   # ASS-536: a fresh forwarder token,
#                                             # bound in vm-tokens.json, put in the sandbox with agent.sh
#   sandbox_revoke <machine-name>             # ASS-536: its forwarder binding gone from vm-tokens.json
#
# The variation's record, in its sprint file: `sandbox` { name (the actor),
# project, machine (the cluster's: mac, or a workstation's or cloud VM's id),
# template, image (the digest it was made from), state (running, stopped),
# created-at, at }. machine.bash's $machine_of names its machine
# substrate:<project>:<machine>:<name> while its run target is a substrate one.
#
# The endpoint (sandbox-exec.js reads it): on the Mac,
# <substrate dir>/sandboxes/<project>/<actor>.json { project, machine, actor,
# port }. The port is the Mac's loopback's: a port of SANDBOX_PORTS (18500-18999,
# HARNESS_SANDBOX_PORTS) no other sandbox records and nothing listens on. On
# the Mac's cluster the proxy (`kubectl ate proxy actor`, on-machine
# substrate.sh sandbox-proxy) listens on it itself; on a remote machine it
# listens on the same port there, forwarded to the Mac over the machine's one
# SSH connection (`ssh -O forward -L`: the master's, never a connection of its
# own). A proxy resumes a suspended actor at its first connection, so a stop
# ends it first.
#
# ASS-536: the Mac's forwarder and Hindsight from a sandbox. A sandbox reaches
# the Mac only through its egress policy (default deny), so each gets the rule
# set "mac" (on-machine substrate.sh sandbox-egress, which keeps it apart from
# ASS-538's credential rules): one cleartext http rule for the forwarder's port
# (harness.json forwarder-port) and one for its project's Hindsight port
# (project.json hindsight.port, when it has one: never another project's), on
# the Mac's name as that cluster sees it — host.docker.internal on the Mac's
# cluster, harness-mac.<namespace>.svc.cluster.local on a workstation's or
# cloud VM's, carried over the machine's SSH connection's reverse forwards by
# its relay (on-machine substrate.sh mac-relay). Nothing else of the Mac is
# reachable that way: no other port has a rule, and the relay carries no other
# port. Every process in the Docker VM (or on the remote machine) can reach the
# same ports, as every VM reaches host.lima.internal's, so the forwarder's
# per-sandbox token stays the boundary (ASS-532 section 5): sandbox_token issues
# one at every substrate:sandbox-up, as vm:start does for a VM — 32 random
# bytes in the sandbox's /run/harness/agent-token (0600, the agent user's) with
# the forwarder's URL in /run/harness/agent-url, the forwarder's client
# (vm/in-vm/agent.sh) at /usr/local/bin/agent.sh; on the Mac only its SHA-256,
# bound in $HARNESS_HOME/vm-tokens.json under the sandbox's machine name
# (substrate:<project>:<machine>:<actor>) to { project, ticket, variation,
# ticket-folder } — so the forwarder runs only the allowlisted commands, for
# that ticket variation alone. A hibernated sandbox keeps its files, so its
# token outlives a suspend; substrate:sandbox-delete revokes it (the binding
# removed), as does every sandbox-up (a new token replaces it).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
sandbox_agent="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../agent.sh"

sandbox_actor() { tr '[:upper:]' '[:lower:]' <<< "$1-$2" | sed 's/[^a-z0-9-]/-/g'; }

sandbox_of() { variation_field '.sandbox // null' "$@"; }

sandbox_set() {
  local command="$1" project="$2" key="$3" variation="$4" record="$5"
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson r "$record" '
    .variations |= map(if .name == $name and (.["is-deleted"] | not) then (if $r == null then del(.sandbox) else .sandbox = $r end) else . end)'
}

sandbox_endpoint_file() { echo "$substrate_dir/sandboxes/$1/$2.json"; }

# sandbox_listening <port> — something answers TCP on the Mac's 127.0.0.1:<port>.
sandbox_listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# sandbox_port <project> <actor> — its recorded port, else a free one (see the module comment), under a lock.
sandbox_port() {
  local file range p used
  file="$(sandbox_endpoint_file "$1" "$2")"
  p="$(jq -r '.port // empty' "$file" 2>/dev/null || true)"
  [[ "$p" =~ ^[0-9]+$ ]] && { echo "$p"; return 0; }
  range="${HARNESS_SANDBOX_PORTS:-18500-18999}"
  mkdir -p "$substrate_dir/sandboxes" && chmod 700 "$substrate_dir"
  lock_on 5 "$substrate_dir/sandboxes/ports.lock" substrate:sandbox 60 || return 1
  used=" $(cat "$substrate_dir"/sandboxes/*/*.json 2>/dev/null | jq -r '.port // empty' | tr '\n' ' ') "
  for ((p = ${range%-*}; p <= ${range#*-}; p++)); do
    [[ "$used" == *" $p "* ]] && continue
    sandbox_listening "$p" && continue
    mkdir -p "$(dirname "$file")"
    jq -nc --arg p "$1" --arg a "$2" --argjson port "$p" '{ project: $p, actor: $a, port: $port }' | replace_file "$file"
    exec 5>&-
    echo "$p"; return 0
  done
  exec 5>&-
  echo "substrate:sandbox: no free port in $range for a sandbox's endpoint" >&2; return 1
}

sandbox_endpoint() {
  local command="$1" project="$2" machine="$3" entry="$4" actor="$5" port out i
  port="$(sandbox_port "$project" "$actor")" || return 1
  out="$(substrate_on "$project" "$machine" "$entry" sandbox-up "$actor" "" </dev/null)" \
    || { echo "$command: the sandbox $actor on $machine could not be resumed: $(tail -n 1 <<< "$out" | jq -r '.failed | map("\(.what): \(.why)") | join("; ")' 2>/dev/null)" >&2; return 1; }
  out="$(substrate_on "$project" "$machine" "$entry" sandbox-proxy "$actor" "$port" </dev/null)" \
    || { echo "$command: the sandbox $actor's proxy on $machine: $(tail -n 1 <<< "$out" | jq -r '.failed | map("\(.what): \(.why)") | join("; ")' 2>/dev/null)" >&2; return 1; }
  if [[ "$(substrate_host "$entry")" != mac ]]; then
    # The same port on the Mac, over the machine's master (an existing forward answers already).
    sandbox_answers "$port" || ssh $(ws_ssh_options "$project" "$machine" | tr '\n' ' ') -O forward -L "127.0.0.1:$port:127.0.0.1:$port" "workstation-$machine" >/dev/null 2>&1 || true
  fi
  for ((i = 0; i < 50; i++)); do sandbox_answers "$port" && break; sleep 0.2; done
  sandbox_answers "$port" || { echo "$command: the sandbox $actor's command server does not answer on the Mac's 127.0.0.1:$port" >&2; return 1; }
  jq -nc --arg p "$project" --arg m "$machine" --arg a "$actor" --argjson port "$port" '{ project: $p, machine: $m, actor: $a, port: $port }' | replace_file "$(sandbox_endpoint_file "$project" "$actor")"
  echo "$port"
}

sandbox_answers() { curl -fsS -m 3 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; }

# sandbox_forget <project> <machine> <entry> <actor> — its endpoint gone: the Mac's forward cancelled, its file removed.
sandbox_forget() {
  local file port
  file="$(sandbox_endpoint_file "$1" "$4")"
  port="$(jq -r '.port // empty' "$file" 2>/dev/null || true)"
  if [[ -n "$port" && "$(substrate_host "$3")" != mac ]] && workstation_alive "$1" "$2"; then
    ssh $(ws_ssh_options "$1" "$2" | tr '\n' ' ') -O cancel -L "127.0.0.1:$port:127.0.0.1:$port" "workstation-$2" >/dev/null 2>&1 || true
  fi
  rm -f "$file"
}

# sandbox_root <name> <argv…> — argv run as root in the sandbox (machine-substrate.bash's bridge, --root).
sandbox_root() { local name="${1#substrate:}"; shift; sbm_parts "$name" && node "$sbm_exec" --sandbox "$sbm_project:$sbm_machine:$sbm_actor" --root -- "$@"; }

sandbox_ticket_copy() {
  local command="$1" project="$2" key="$3" name="$4" folder
  folder="$projects/$project/work/$(upper "$key")"
  mkdir -p "$folder"
  # Writable again before it goes (ASS-542: a resumed sandbox's copy is replaced; root needs it only where root is not exempt).
  sandbox_root "$name" bash -c 'd="${HARNESS_VM_ROOT-}/mnt/ticket"; [ ! -e "$d" ] || chmod -R u+w "$d"; rm -rf "$d"' </dev/null >/dev/null \
    && machine_copy_in "$name" "$folder" /mnt/ticket \
    && sandbox_root "$name" bash -c 'chmod -R a-w,a+rX "${HARNESS_VM_ROOT-}/mnt/ticket"' </dev/null >/dev/null \
    || { echo "$command: the ticket folder could not be copied into $name's /mnt/ticket" >&2; return 1; }
  # ASS-567: checked, not assumed — an agent that found /mnt/ticket empty asked the operator for its ticket. Every
  # top-level entry of the Mac's folder must be there (4: a harness fault, the step held and tried again).
  local want got
  want="$(find "$folder" -mindepth 1 -maxdepth 1 | wc -l | tr -dc 0-9)"
  got="$(sandbox_root "$name" bash -c 'find "${HARNESS_VM_ROOT-}/mnt/ticket" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l' </dev/null | tr -dc 0-9)"
  (( ${got:-0} >= ${want:-0} )) \
    || { echo "$command: ticket folder empty: $name's /mnt/ticket holds ${got:-0} of the ticket folder's $want entries after the copy" >&2; return 4; }
}

# --- ASS-536: the Mac's forwarder and Hindsight (see the module comment) ----------------------------------------
sandbox_tokens_file="${HARNESS_HOME:-$HOME/.harness}/vm-tokens.json"
sandbox_client="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm/in-vm/agent.sh"

sandbox_mac_host() {
  if [[ "$(substrate_host "$3")" == mac ]]; then echo host.docker.internal; else echo "harness-mac.$(jq -r .namespace <<< "$3").svc.cluster.local"; fi
}

# sandbox_mac_ports <project> — the forwarder's port, then the project's Hindsight's (when it has one).
sandbox_mac_ports() {
  local forwarder
  forwarder="$(jq -r '.["forwarder-port"] // empty' "$ws_harness_file" 2>/dev/null)"
  [[ "$forwarder" =~ ^[0-9]+$ ]] || { echo "harness.json has no forwarder-port" >&2; return 1; }
  { echo "$forwarder"; jq -r '.hindsight.port // empty' "$substrate_projects/$1/project.json"; } | grep -E '^[0-9]+$' | awk '!seen[$0]++'
}

sandbox_mac_rules() {
  local project="$1" machine="$2" entry="$3" host ports out
  ports="$(sandbox_mac_ports "$project")" || return 1
  if [[ "$(substrate_host "$entry")" != mac ]]; then
    # shellcheck disable=SC2086 # one port per word
    out="$(substrate_on "$project" "$machine" "$entry" mac-relay $ports </dev/null | tail -n 1)" \
      || { echo "the relay to the Mac on $machine: $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$out" 2>/dev/null)" >&2; return 1; }
  fi
  host="$(sandbox_mac_host "$project" "$machine" "$entry")"
  jq -nc --arg h "$host" '[$ARGS.positional[] | tonumber | { http: { hostnames: [$h], ports: { numbers: [.] } } }]' --args $ports
}

# sandbox_reach_cluster <command> <project> <machine> <entry> <actor> — the sandbox's rule set "mac" applied (and, on
# a remote machine, the relay up first).
sandbox_reach_cluster() {
  local command="$1" project="$2" machine="$3" entry="$4" actor="$5" rules out
  rules="$(sandbox_mac_rules "$project" "$machine" "$entry")" || { echo "$command: $actor cannot be given its way to the Mac's forwarder and Hindsight" >&2; return 1; }
  out="$(substrate_on "$project" "$machine" "$entry" sandbox-egress "$actor" mac <<< "$rules" | tail -n 1)" \
    || { echo "$command: the sandbox $actor's egress rules to the Mac: $(jq -r '.failed | map("\(.what): \(.why)") | join("; ")' <<< "$out" 2>/dev/null)" >&2; return 1; }
}

sandbox_token() {
  local command="$1" project="$2" key="$3" variation="$4" name="$5" host="$6" token folder binding forwarder
  forwarder="$(sandbox_mac_ports "$project" | head -n 1)" || return 1
  folder="$projects/$project/work/$(upper "$key")"
  mkdir -p "$folder" && folder="$(cd "$folder" && pwd -P)"
  token="$(openssl rand -hex 32)"
  binding="$(jq -nc --arg p "$project" --arg k "$(upper "$key")" --arg v "$variation" --arg f "$folder" \
    --arg h "$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{ project: $p, ticket: $k, variation: $v, "ticket-folder": $f, "token-sha256": $h, "issued-at": $at }')"
  mkdir -p "$(dirname "$sandbox_tokens_file")"
  (umask 077; update_json --create "$sandbox_tokens_file" --arg vm "$name" --argjson b "$binding" '.[$vm] = $b') \
    || { echo "$command: $name's forwarder token could not be recorded" >&2; return 1; }
  # As root: agent.sh installed, /run/harness the agent user's alone (the image's user; the tests' fake has none);
  # then, as that user, the token and URL written there (0600).
  sandbox_root "$name" bash -c 'set -e; R="${HARNESS_VM_ROOT-}"; mkdir -p "$R/run/harness" "$R/usr/local/bin"
      cat > "$R/usr/local/bin/agent.sh"; chmod 0755 "$R/usr/local/bin/agent.sh"
      ! id agent >/dev/null 2>&1 || chown agent:agent "$R/run/harness"; chmod 0700 "$R/run/harness"' < "$sandbox_client" >/dev/null \
    && printf '%s\n%s\n' "$token" "http://$host:$forwarder/run" \
    | machine_run "$name" -- bash -c 'set -e; R="${HARNESS_VM_ROOT-}"; umask 077; IFS= read -r t; IFS= read -r u
        printf "%s\n" "$t" > "$R/run/harness/agent-token"; printf "%s\n" "$u" > "$R/run/harness/agent-url"' \
    || { sandbox_revoke "$name"; echo "$command: could not give $name its forwarder token and agent.sh" >&2; return 1; }
}

sandbox_revoke() { [[ ! -f "$sandbox_tokens_file" ]] || update_json "$sandbox_tokens_file" --arg n "$1" 'del(.[$n])'; }
