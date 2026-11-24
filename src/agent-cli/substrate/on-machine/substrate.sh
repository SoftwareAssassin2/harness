#!/bin/bash
# The machine's side of the substrate:* commands (ASS-533): run on the machine
# a project's Substrate cluster lives on — the Mac itself, or a workstation or
# cloud VM over its one SSH connection (agent-cli/substrate.bash
# substrate_on) — as that machine's user:
#
#   bash -c "<this script>" substrate <action> [<arg>…]
#
# Actions (each prints one JSON line last on stdout, what it did and what
# failed on stderr too):
#   host-setup         what the cluster needs of the machine outside its kit,
#                      re-applied idempotently: Docker usable; on a workstation,
#                      Docker's data-root under /home; the inotify limits kind
#                      needs; the cluster's node started again after the machine
#                      restarted, and its proxy ARP set. Run by substrate:up, and
#                      by workstation:setup on every start (below).
#                      { ok, did, failed }
#   up                 host-setup, then the kind cluster created (or its node
#                      started), its kubeconfig written, Substrate installed or
#                      upgraded to the pinned release from published images
#                      (ate-setup --image-repo/--image-tag), and the project's
#                      namespace, WorkerPool and atespace made. Idempotent: a
#                      rerun with everything there changes nothing (did empty).
#                      With HARNESS_SUBSTRATE_REPAIR=1 (control's restart of a
#                      broken cluster), pods stuck not ready are deleted too, so
#                      their controllers make them anew. { ok, did, failed, … }
#   health             the cluster checked (below). { ok, state, problems, … }
#   down [--cluster]   the project's namespace, WorkerPool and atespace removed;
#                      the cluster itself deleted when no other project's
#                      namespace is left in it (the Mac's is shared), or with
#                      --cluster. Its kubeconfig file removed. { ok, did, failed }
#   stop               the cluster's node stopped (docker stop), its state kept:
#                      so a cloud VM can stop itself when idle — its idle check
#                      counts the load a running cluster keeps up (about 0.5 on
#                      4 cores) as busy. host-setup, at the next connect's
#                      setup, starts it again. { ok, did, failed }
#   load-image         stdin, an image archive (docker save's), loaded into the
#                      cluster's node (kind load image-archive): the hook for
#                      ASS-534's sandbox images, built on the Mac and sent over
#                      the machine's SSH connection. { ok, did, failed }
#   registry-up        ASS-535: the cluster's image registry (below) running.
#                      { ok, did, failed }
#   sandbox-template <ref> <name>   ASS-535: the project's ActorTemplate <name>
#                      made from the image <ref> (a repository@digest in the
#                      cluster's registry) when missing, and waited for until it
#                      has its golden snapshot (or an error).
#                      { ok, did, failed, template, golden }
#   sandbox-up <actor> <template>   ASS-535: the ticket variation's sandbox
#                      (actor) made from <template> when missing, and resumed
#                      when not running; when no worker has room for it, the
#                      project's WorkerPool grown by one (never shrunk here: an
#                      idle worker costs about 24 MiB) and the resume tried again.
#                      ASS-568: a crashed actor (ACTOR_STATE_CRASHED: its worker
#                      restarted or went away, its snapshot lost — Substrate's
#                      `status.crash.message` says which) is never resumed: it
#                      fails at once, `what` "crashed" (control replaces it).
#                      { ok, did, failed, actor, state, created, worker-pod-uid }
#   sandbox-proxy <actor> <port>    ASS-535: `kubectl ate proxy actor` to it
#                      listening on this machine's 127.0.0.1:<port>, started when
#                      none answers there (its pid under proxies/<project>/).
#                      { ok, did, failed, port }
#   sandbox-stop <actor>            its proxy ended (a proxy resumes a suspended
#                      actor on a connection), the actor suspended (hibernated,
#                      files and processes kept). { ok, did, failed }
#   sandbox-delete <actor>          its proxy ended, the actor deleted. { ok, did, failed }
#   sandbox-state <actor>           { ok, exists, state, worker-pod-uid, proxy (its port, or null),
#                      crash (ASS-568: Substrate's reason for a crashed actor, or null) }
#   sandbox-egress <actor> <set>    ASS-536: stdin, a JSON array of egress rules, kept as the
#                      sandbox's rule set <set> (an empty array removes it); the
#                      actor's egress policy then made the union of all its sets
#                      (below). { ok, did, failed, rules (how many in the policy) }
#   mac-relay <port…>  ASS-536, a workstation's or cloud VM's cluster only: the
#                      way in-cluster to the Mac's services that the machine's SSH
#                      connection reverse-forwards to its loopback — those ports
#                      alone (below). { ok, did, failed, host, address }
#   credentials-apply  ASS-538: stdin, { secrets: [Secret…], policy: { rules } } (substrate:credentials, from the
#                      Mac's keychain: the only action that is given a token, on stdin, never echoed): the project's
#                      Secrets applied in its namespace (labelled harness.dev/credential) and any it no longer
#                      declares deleted; the credential provider's namespace policy granting the project's atespace
#                      its own namespace (the ConfigMap the provider reads only at start, so it is restarted when
#                      that changes: ASS-532); each of the project's sandboxes' rule set `credentials` (the
#                      egress gateway's hosts: sandbox-egress) brought up to date.
#                      { ok, did, failed, secrets, sandboxes }
#   has-kit <sha>      exit 0 when the kit <sha> is installed here
#   install-kit <sha>  stdin, the kit's tarball (substrate.bash substrate_kit),
#                      checked against <sha> and unpacked as the current kit
#
# The machine's own files (AC3, AC7, AC8): everything the harness keeps here is
# under $HOME/.harness/substrate (HARNESS_SUBSTRATE_DIR), which is under /home:
#   kit/<sha>/bin      the pinned kind, kubectl, kubectl-ate and ate-setup
#   kit/<sha>/src      the release's manifests (ate-setup reads them)
#   kit/current        the kit in use (a link)
#   <project>/<machine>.kubeconfig   the cluster's kubeconfig for that project:
#                      every kind, kubectl, kubectl-ate and ate-setup call is
#                      given it (--kubeconfig, KUBECONFIG); ~/.kube/config is
#                      never read or written (operator rule, 2026-11-22: the
#                      operator's other contexts are production clusters)
#   clusters/<cluster>/installed  the release installed (for upgrades)
#   kind-config.yaml, records/, logs/, tmp/
# and the cluster's state — the kind node's container and its /var volume,
# where postgres, rustfs and so Substrate's snapshots (hibernated sandboxes)
# live — is in Docker's data-root, which on a workstation must be under /home
# too: only /home survives a workstation's restart. A workstation whose own
# config starts dockerd with --data-root under /home (Google's images do,
# /home/.docker_data) needs nothing; one whose data-root is elsewhere gets
# /etc/docker/daemon.json's data-root set under /home and Docker restarted —
# outside /home, so re-applied by workstation:setup on every start; one whose
# config passes --data-root outside /home fails host-setup, named: the harness
# never changes how a machine is stood up. A cloud VM keeps its whole disk, so
# its data-root is left as it is. The inotify limits (fs.inotify.
# max_user_watches 524288, max_user_instances 512: kind's known-issues values)
# are raised at runtime (sudo -n sysctl -w) only when lower, never written to
# /etc, so they too are re-applied at each start. Nothing else outside /home
# is touched; the machine's own kind and kubectl (a workstation image may
# carry old ones) are left alone, the kit's first on PATH here only.
#
# ASS-535: the cluster's image registry. Substrate's atelet pulls a sandbox's
# image itself (its own image cache), never from the node's containerd, so an
# image `kind load`ed into the node is not one a template can use; and it
# rewrites an image on localhost to kind-registry:5000 (its
# --localhost-registry-replacement, as Substrate's kind setup has it), pulled
# over plain HTTP. So each machine runs a registry container,
# harness-substrate-registry (registry:3, pinned by digest:
# HARNESS_SUBSTRATE_REGISTRY_IMAGE), on kind's Docker network under the alias
# kind-registry, published on this machine's 127.0.0.1:<registry port>
# (HARNESS_SUBSTRATE_REGISTRY_PORT, 5011): the Mac pushes a project's sandbox
# image to it (substrate:deliver-image: over the SSH connection's forward for
# a remote machine), and a template names the image localhost:<port>/
# sandbox/<project>@<digest>. Its storage is a Docker volume, in Docker's
# data-root (under /home on a workstation, as the cluster's state). The Mac's
# one is shared by every Mac project (one cluster); a remote machine's is its
# project's alone. A sandbox's proxies' pids live under proxies/<project>/.
#
# ASS-536: a sandbox's egress, and its way to the Mac. An actor has one egress
# policy (Substrate's: a singleton, "default", its rules an unordered set of
# allows, everything else denied), but more than one part of the harness gives a
# sandbox rules: this ticket the Mac's forwarder and the project's Hindsight
# (set "mac"), ASS-538 the forges and model API through the egress gateway's
# credentials. So each part keeps its rules as a named set, here, under
# egress/<project>/<actor>/<set>.json, and the actor's policy is always the
# union of its sets: sandbox-egress writes one set and applies the union
# (created, replaced with the stored policy's uid and version, or deleted when
# no set has a rule), changing nothing when the policy holds those rules already.
# Two sets must never name the same host and port (Substrate rejects a tie at
# admission). sandbox-delete removes the actor's sets with it.
#
# The Mac's services from a sandbox. On the Mac's cluster (Docker Desktop), the
# Mac's loopback is host.docker.internal from inside the Docker VM (ASS-532
# section 5), so a rule for that name and a port reaches the Mac's 127.0.0.1 at
# that port: the gateway resolves and dials it. On a workstation's or cloud VM's
# cluster (Linux Docker, no such name), the machine's SSH connection already
# reverse-forwards the forwarder's and Hindsight's ports to the machine's own
# loopback (workstation.bash, ASS-433), which a pod cannot reach; mac-relay
# carries just those ports in: a relay container, harness-substrate-mac-relay
# (socat, pinned by digest: HARNESS_SUBSTRATE_RELAY_IMAGE; host network,
# --restart=always), listening on the kind network's gateway address — the
# machine's side of kind's bridge, reachable from the cluster's pods and
# containers only — at each port, each connection relayed to 127.0.0.1:<port>;
# and a Service with no selector, harness-mac in the project's namespace, whose
# EndpointSlice is that address and those ports, so the name
# harness-mac.<namespace>.svc.cluster.local is what a sandbox's rule allows and
# its agent dials. A port not given is not relayed (the registry's, forwarded
# for the Mac's pushes, never is), and a sandbox reaches the name only at the
# ports its own rules allow. The container is made again when its ports or
# the gateway's address change.
REL="harness-substrate-mac-relay"

# egress_rules <actor> — the union of the actor's rule sets, one JSON array.
egress_rules() { local d="$S/egress/$P/$1"; cat "$d"/*.json 2>/dev/null | jq -cs 'add // [] | unique'; }

sandbox_egress() {
  local actor="$1" set="$2" rules want cur uid version out d manifest
  [[ "$actor" =~ ^[a-z0-9-]+$ && "$set" =~ ^[a-z0-9-]+$ ]] || { bad egress "sandbox-egress needs <actor> <set>"; return; }
  rules="$(jq -ce 'if type == "array" then . else error("not an array") end' 2>/dev/null)" || { bad egress "the $set rules on stdin are not a JSON array"; return; }
  actor_json "$actor" >/dev/null || { bad egress "no sandbox $actor"; return; }
  d="$S/egress/$P/$actor"; mkdir -p "$d"
  if [[ "$rules" == "[]" ]]; then rm -f "$d/$set.json"; else printf '%s\n' "$rules" > "$d/$set.json"; fi
  want="$(egress_rules "$actor")"
  cur="$(ate get egress-policy "$actor" -a "$NS" -o json 2>/dev/null)" || cur=""
  if [[ -n "$cur" ]] && [[ "$(jq -cS '.rules // [] | sort_by(tostring)' <<< "$cur")" == "$(jq -cS 'sort_by(tostring)' <<< "$want")" ]]; then return 0; fi
  if [[ "$want" == "[]" ]]; then
    [[ -z "$cur" ]] && return 0
    if out="$(ate delete egress-policy "$actor" -a "$NS" 2>&1)"; then done_ "removed the sandbox $actor's egress policy (no rule set left)"
    else bad egress "kubectl ate delete egress-policy $actor failed: $(first_line "$out")"; fi
    return
  fi
  if [[ -z "$cur" ]]; then
    manifest="$(jq -cn --arg ns "$NS" --argjson r "$want" '{ metadata: { atespace: $ns, name: "default" }, rules: $r }')"
    if out="$(ate create egress-policy "$actor" -a "$NS" -f - <<< "$manifest" 2>&1)"; then done_ "gave the sandbox $actor its egress policy ($(jq length <<< "$want") rules)"
    else bad egress "kubectl ate create egress-policy $actor failed: $(first_line "$out")"; fi
  else
    uid="$(jq -r '.metadata.uid // empty' <<< "$cur")" version="$(jq -r '.metadata.version // empty' <<< "$cur")"
    manifest="$(jq -cn --arg ns "$NS" --arg uid "$uid" --arg v "$version" --argjson r "$want" '{ metadata: { atespace: $ns, name: "default", uid: $uid, version: $v }, rules: $r }')"
    if out="$(ate update egress-policy "$actor" -a "$NS" -f - <<< "$manifest" 2>&1)"; then done_ "updated the sandbox $actor's egress policy ($(jq length <<< "$want") rules)"
    else bad egress "kubectl ate update egress-policy $actor failed: $(first_line "$out")"; fi
  fi
}

# kind_gateway — the kind network's IPv4 gateway on this machine.
kind_gateway() { docker network inspect kind -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$'; }

mac_relay() {
  local gw want have out p ports=() items
  [[ "$HOST" != mac ]] || { bad relay "the Mac's cluster reaches the Mac at host.docker.internal: no relay"; return; }
  for p in "$@"; do [[ "$p" =~ ^[0-9]+$ ]] || { bad relay "mac-relay needs port numbers, not '$p'"; return; }; ports+=("$p"); done
  [[ ${#ports[@]} -gt 0 ]] || { bad relay "mac-relay needs at least one port"; return; }
  gw="$(kind_gateway)" || { bad relay "the kind network has no IPv4 gateway (is the cluster up?)"; return; }
  relay_addr="$gw"
  want="$gw ${ports[*]}"
  have="$(docker inspect -f '{{index .Config.Labels "harness-relay"}}' "$REL" 2>/dev/null)" || have=""
  if [[ "$have" != "$want" ]] || [[ "$(docker inspect -f '{{.State.Running}}' "$REL" 2>/dev/null)" != true ]]; then
    docker rm -f "$REL" >/dev/null 2>&1 || true
    # shellcheck disable=SC2016 # expanded by the relay's own shell
    if out="$(docker run -d --restart=always --name "$REL" --network host --label "harness-relay=$want" --entrypoint sh \
        "${HARNESS_SUBSTRATE_RELAY_IMAGE:-alpine/socat}" -c 'gw="$1"; shift; for p; do socat "TCP-LISTEN:$p,bind=$gw,reuseaddr,fork" "TCP:127.0.0.1:$p" & done; wait' relay "$gw" "${ports[@]}" 2>&1)"; then
      done_ "started the relay to the Mac's services ($REL: $gw:{${ports[*]}} to this machine's loopback, the SSH connection's forwards)"
    else bad relay "$REL could not be started: $(first_line "$out")"; return; fi
  fi
  items="$(jq -cn --arg ns "$NS" --arg gw "$gw" --args '[$ARGS.positional[] | tonumber] as $p | { apiVersion: "v1", kind: "List", items: [
    { apiVersion: "v1", kind: "Service", metadata: { name: "harness-mac", namespace: $ns, labels: { "app.kubernetes.io/managed-by": "harness" } },
      spec: { ports: [$p[] | { name: "p\(.)", port: ., targetPort: ., protocol: "TCP" }] } },
    { apiVersion: "discovery.k8s.io/v1", kind: "EndpointSlice", metadata: { name: "harness-mac", namespace: $ns,
        labels: { "kubernetes.io/service-name": "harness-mac", "endpointslice.kubernetes.io/managed-by": "harness" } },
      addressType: "IPv4", ports: [$p[] | { name: "p\(.)", port: ., protocol: "TCP" }], endpoints: [{ addresses: [$gw] }] } ] }' "${ports[@]}")"
  if out="$(kc apply -f - <<< "$items" 2>&1)"; then
    grep -q -v unchanged <<< "$out" && done_ "the Service harness-mac.$NS: the Mac's ports ${ports[*]} at $gw"
  else bad relay "the Service harness-mac could not be applied: $(first_line "$out")"; fi
  return 0
}

# health checks, each problem { what, why, repair } — repair true when
# substrate:up (control's restart) can fix it:
#   docker       answering; its memory at least HARNESS_SUBSTRATE_NEED_MEMORY
#                bytes (the Mac: Docker Desktop's VM); its containers' memory
#                use under 90% of it; a remote machine's MemAvailable at least
#                1 GiB (from /proc/meminfo)
#   node         the cluster's node container there and running, its proxy ARP on
#   api          the API server ready (/readyz)
#   pods         every pod of the system namespaces and the project's ready
#   rustfs       its /health answering ok (through the API server's service proxy)
#   postgres     pg_isready in postgres-0
#   release      the pinned release installed
#   workers      the project's WorkerPool ready, its atespace there
# ASS-538: and, reported as `egress` (no problem: substrate:credentials repairs it, and project:credentials-status
# says what is missing): the credential provider's deployment ready, the namespace policy granting the project's
# atespace its namespace, the project's credential Secrets there (names only), and the gateway's recent refusals of
# the project's sandboxes (its ext-proc's "egress denied" lines naming the atespace, the last
# HARNESS_SUBSTRATE_DENIALS_SINCE: 10m).
#   templates    each of the project's actor templates with its golden snapshot
#                (a template error shows only in ate-api-server's log, ASS-532:
#                its last line naming the template is the why); one still
#                building within HARNESS_SUBSTRATE_TEMPLATE_GRACE (600 s) is not
#                a problem yet
# The node started (or the cluster created) within HARNESS_SUBSTRATE_GRACE
# seconds (300; Substrate takes about 2.5 minutes to come back after a node
# restart) with only pods, rustfs or postgres not ready is `starting`, not
# broken. state: healthy, starting, broken, missing (no cluster) or
# docker-down. usage: the node container's memory and CPU (docker stats) and
# the project's active sandboxes (actors resuming, running or suspending), and ASS-535 AC3's sandbox-use: each
# sandbox's state, memory (its worker pod's cgroup, rootfs writes included) and CPU (measure_sandboxes). ASS-537 AC3:
# also each sandbox's snapshot-bytes (the disk its hibernation snapshots take, whatever its state: measure_snapshots),
# usage.snapshot-bytes (the project's: its sandboxes' and its templates' golden snapshots), usage.disk (the node's
# /var — where the snapshots live — total and free bytes) and usage.workers (its WorkerPool's workers and each one's
# memory request: a warm worker reserves its request even empty, ASS-532 section 6).
#
# Settings come in the environment, from substrate.bash: HARNESS_SUBSTRATE_HOST
# (mac, workstation or cloud-vm), _PROJECT, _MACHINE, _NAMESPACE, _CLUSTER,
# _RELEASE, _IMAGE_REPO, _WORKER_IMAGE, _NODE_IMAGE, _WARM_WORKERS,
# _WORKER_MEMORY_MI, _WORKER_CPUS, _NEED_MEMORY. Tests stand a folder in for
# the machine: HARNESS_SUBSTRATE_ROOT (its /: etc/docker/daemon.json,
# proc/sys, proc/meminfo), HARNESS_SUBSTRATE_PERSIST (its /home) and
# HARNESS_SUBSTRATE_DOCKERD_ARGS (dockerd's command line); a real session
# never carries them.
set -uo pipefail
umask 077
action="${1:-}"; [[ $# -gt 0 ]] && shift
S="${HARNESS_SUBSTRATE_DIR:-$HOME/.harness/substrate}"
HOST="${HARNESS_SUBSTRATE_HOST:-mac}"
ROOT="${HARNESS_SUBSTRATE_ROOT:-}"
PERSIST="${HARNESS_SUBSTRATE_PERSIST:-/home}"
C="${HARNESS_SUBSTRATE_CLUSTER:-harness-substrate}"
NODE="$C-control-plane"
P="${HARNESS_SUBSTRATE_PROJECT:-}" M="${HARNESS_SUBSTRATE_MACHINE:-}" NS="${HARNESS_SUBSTRATE_NAMESPACE:-}"
KC="$S/$P/$M.kubeconfig"
GRACE="${HARNESS_SUBSTRATE_GRACE:-300}" TEMPLATE_GRACE="${HARNESS_SUBSTRATE_TEMPLATE_GRACE:-600}"
export PATH="$S/kit/current/bin:$HOME/harness/bin:$PATH"
# AC8: whatever runs here sees the cluster's own kubeconfig, never ~/.kube/config.
export KUBECONFIG="$KC"
did=() failed=()
done_() { did+=("$1"); }
bad() { failed+=("$1"$'\t'"$2"); echo "substrate: $1: $2" >&2; }
has() { command -v "$1" >/dev/null 2>&1; }
first_line() { local l; l="$(printf '%s\n' "$1" | grep -m1 -v '^[[:space:]]*$')"; printf '%s' "${l:0:300}"; }
now() { date +%s; }

# finish [<json object of extra fields>] — the JSON line { ok, did, failed, …extra }; exits 0 when nothing failed, else 1.
finish() {
  local extra="${1:-{\}}" dj='[]' fj='[]'
  [[ ${#did[@]} -eq 0 ]] || dj="$(printf '%s\n' "${did[@]}" | jq -Rsc 'split("\n")[:-1]')"
  [[ ${#failed[@]} -eq 0 ]] || fj="$(printf '%s\n' "${failed[@]}" | jq -Rsc 'split("\n")[:-1] | map(split("\t") | { what: .[0], why: (.[1:] | join(" ")) })')"
  jq -cn --argjson d "$dj" --argjson f "$fj" --argjson extra "$extra" '{ ok: ($f | length == 0), did: $d, failed: $f } + $extra'
  [[ ${#failed[@]} -eq 0 ]]
  exit
}

for c in jq docker; do has "$c" || { echo "{\"ok\":false,\"did\":[],\"failed\":[{\"what\":\"$c\",\"why\":\"not installed on this machine\"}]}"; exit 1; }; done
[[ "$action" == has-kit || "$action" == install-kit || "$action" == host-setup || "$action" == load-image || "$action" == stop || "$action" == registry-up ]] || {
  [[ "$P" =~ ^[A-Za-z0-9_-]+$ && "$M" =~ ^[A-Za-z0-9_-]+$ && "$NS" =~ ^[a-z0-9-]+$ ]] || { bad settings "HARNESS_SUBSTRATE_PROJECT, _MACHINE and _NAMESPACE must name the project, the machine and its namespace"; finish; }
}
# AC8: the cluster's kubeconfig is its own file under ~/.harness, never the operator's.
case "$KC" in "$HOME/.kube/"*) bad kubeconfig "$KC is under ~/.kube, which the harness never touches"; finish ;; esac

kc() { kubectl --kubeconfig "$KC" --request-timeout=20s "$@"; }
ate() { kubectl-ate --kubeconfig "$KC" "$@" 2> >(grep -v '^Warning: no --token-file' >&2); }
docker_ok() { docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; }
node_exists() { docker inspect -f '{{.State.Running}}' "$NODE" >/dev/null 2>&1; }
node_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$NODE" 2>/dev/null)" == true ]]; }
# node_started_at — the node's last start, in seconds since the epoch (0 when unknown).
node_started_at() { local s; s="$(docker inspect -f '{{.State.StartedAt}}' "$NODE" 2>/dev/null)"; s="${s:0:19}"; date -u -d "${s}Z" +%s 2>/dev/null || TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "$s" +%s 2>/dev/null || echo 0; }
proxy_arp_on() { [[ "$(docker exec "$NODE" cat /proc/sys/net/ipv4/conf/all/proxy_arp 2>/dev/null | tr -d '[:space:]')" == 1 ]]; }

# set_proxy_arp — kind's node needs proxy ARP for gVisor's loopback pod-to-pod networking (Substrate's
# hack/create-kind-cluster.sh); it lives in the node's network namespace, so a node restart loses it.
set_proxy_arp() {
  proxy_arp_on && return 0
  if out="$(docker exec "$NODE" sysctl -w net.ipv4.conf.all.proxy_arp=1 2>&1)"; then
    docker exec "$NODE" sysctl -e -w net.ipv6.conf.all.proxy_ndp=1 >/dev/null 2>&1
    done_ "set proxy ARP on the cluster's node $NODE (lost when it restarts)"
  else bad "proxy ARP" "could not be set on $NODE: $(first_line "$out")"; fi
}

# start_node — the node's container started when it is there and stopped (the machine restarted, or Docker did).
start_node() {
  node_exists || return 0
  if ! node_running; then
    if out="$(docker start "$NODE" 2>&1)"; then done_ "started the cluster's node $NODE (it had stopped: the machine or Docker restarted)"
    else bad "cluster node" "$NODE could not be started: $(first_line "$out")"; return; fi
  fi
  set_proxy_arp
}

# host_setup — see the header.
host_setup() {
  local out root args want have k f cfg
  if ! out="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then bad docker "not usable (docker info failed): $(first_line "$out")"; return; fi
  if [[ "$HOST" == workstation ]]; then
    root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
    case "$root/" in
      "${PERSIST%/}"/*) ;;
      *)
        args="${HARNESS_SUBSTRATE_DOCKERD_ARGS-$(ps -o args= -C dockerd 2>/dev/null | head -n 1)}"
        if [[ "$args" == *--data-root* ]]; then
          bad "docker data-root" "Docker keeps its data in $root, outside $PERSIST, and the workstation's own config starts dockerd with --data-root, which the harness does not change: the cluster would not survive a restart"
          return
        fi
        cfg="$ROOT/etc/docker/daemon.json"
        want="${PERSIST%/}/.docker_data"
        if ! out="$(sudo -n mkdir -p "${cfg%/*}" 2>&1 && { cat "$cfg" 2>/dev/null || echo '{}'; } | jq --arg r "$want" '. + { "data-root": $r }' | sudo -n tee "$cfg.harness-new" 2>&1 >/dev/null && sudo -n mv -f "$cfg.harness-new" "$cfg" 2>&1)"; then
          bad "docker data-root" "could not write $cfg (sudo -n): $(first_line "$out")"; return
        fi
        if ! out="$(sudo -n service docker restart 2>&1 || sudo -n systemctl restart docker 2>&1)"; then bad "docker data-root" "Docker could not be restarted to use $want: $(first_line "$out")"; return; fi
        for ((k = 0; k < 60; k++)); do docker_ok && break; sleep 1; done
        root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
        case "$root/" in "${PERSIST%/}"/*) done_ "moved Docker's data-root to $root ($cfg, outside /home: re-applied at every start)" ;;
          *) bad "docker data-root" "still ${root:-unknown} after setting $cfg and restarting Docker"; return ;; esac ;;
    esac
  fi
  if [[ "$HOST" != mac ]]; then
    for k in fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512; do
      want="${k#*=}" k="${k%%=*}" f="$ROOT/proc/sys/${k//.//}"
      have="$(cat "$f" 2>/dev/null | tr -d '[:space:]')"
      [[ "$have" =~ ^[0-9]+$ && "$have" -ge "$want" ]] && continue
      if out="$(sudo -n sysctl -w "$k=$want" 2>&1)"; then done_ "raised $k from ${have:-unknown} to $want (sudo sysctl -w: not kept across a restart, so set again at every start)"
      else bad "$k" "is ${have:-unknown}, below the $want kind needs, and could not be raised (sudo -n sysctl -w): $(first_line "$out")"; fi
    done
  fi
  start_node
  # ASS-535: the cluster's registry too, when it is there and stopped (its restart policy starts it with Docker; a
  # machine restarted under another data-root, or a node started by hand, may leave it stopped).
  if docker inspect -f '{{.State.Running}}' harness-substrate-registry >/dev/null 2>&1 && [[ "$(docker inspect -f '{{.State.Running}}' harness-substrate-registry 2>/dev/null)" != true ]]; then
    if out="$(docker start harness-substrate-registry 2>&1)"; then done_ "started the cluster's registry harness-substrate-registry (it had stopped)"; else bad registry "harness-substrate-registry could not be started: $(first_line "$out")"; fi
  fi
}

# kit_ok — the kit's tools on PATH.
kit_ok() {
  local t
  for t in kind kubectl kubectl-ate ate-setup; do has "$t" || { bad kit "$t is not in $S/kit/current/bin: substrate:up sends the kit first"; return 1; }; done
  [[ -f "$S/kit/current/src/go.mod" ]] || { bad kit "$S/kit/current/src has no go.mod: the kit is incomplete"; return 1; }
}

write_kind_config() {
  local tmp
  mkdir -p "$S" && tmp="$(mktemp "$S/kind-config.XXXXXX")" || return 1
  # As Substrate's hack/create-kind-cluster.sh writes it for gVisor (no KVM, no local registry).
  cat > "$tmp" <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
featureGates:
  ClusterTrustBundle: true
  ClusterTrustBundleProjection: true
  PodCertificateRequest: true
runtimeConfig:
  "certificates.k8s.io/v1beta1": "true"
networking:
  ipFamily: ipv4
kubeadmConfigPatches:
- |
  kind: KubeletConfiguration
  serializeImagePulls: false
  maxParallelImagePulls: 4
EOF
  if cmp -s "$tmp" "$S/kind-config.yaml"; then rm -f "$tmp"; else mv -f "$tmp" "$S/kind-config.yaml"; fi
}

# write_kubeconfig — the cluster's kubeconfig (kind get kubeconfig: printed, nothing else written) kept as the
# project's own file, when it differs.
write_kubeconfig() {
  local tmp out
  mkdir -p "$S/$P" && chmod 700 "$S" "$S/$P"
  tmp="$(mktemp "$KC.XXXXXX")" || return 1
  if ! out="$(kind get kubeconfig --name "$C" 2>&1 > "$tmp")" || [[ ! -s "$tmp" ]]; then rm -f "$tmp"; bad kubeconfig "kind get kubeconfig --name $C failed: $(first_line "$out")"; return 1; fi
  chmod 600 "$tmp"
  if cmp -s "$tmp" "$KC"; then rm -f "$tmp"; else mv -f "$tmp" "$KC"; done_ "wrote the cluster's kubeconfig ($KC)"; fi
}

wait_api() {
  local i
  for ((i = 0; i < ${1:-120}; i += 2)); do kc get --raw /readyz >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

installed_release() { cat "$S/clusters/$C/installed" 2>/dev/null; }
wanted_release() { printf '%s %s\n' "${HARNESS_SUBSTRATE_IMAGE_REPO:-}" "${HARNESS_SUBSTRATE_RELEASE:-}"; }

# install — Substrate installed or upgraded to the pinned release from published images (never a source build), when
# the recorded release differs or its API server is missing; its output kept in logs/.
install() {
  local log out
  if [[ "$(installed_release)" == "$(wanted_release)" ]] && kc -n ate-system get deployment ate-api-server >/dev/null 2>&1; then return 0; fi
  mkdir -p "$S/logs" "$S/records" "$S/clusters/$C"
  log="$S/logs/ate-setup-$C-$(date -u +%Y%m%dT%H%M%SZ).log"
  if (cd "$S/kit/current/src" && ate-setup --kubeconfig "$KC" --context "kind-$C" --kind --kind-cluster-name "$C" \
      --image-repo "$HARNESS_SUBSTRATE_IMAGE_REPO" --image-tag "$HARNESS_SUBSTRATE_RELEASE" --record-dir "$S/records" \
      deploy ate-system --sandbox-classes=gvisor --credential-provider='{"name":"k8s.io"}' \
      --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/ate-system/sa/atenet-client) > "$log" 2>&1; then
    local was; was="$(installed_release)"
    wanted_release > "$S/clusters/$C/installed"
    done_ "$( [[ -n "$was" ]] && echo "upgraded Substrate from ${was##* } to" || echo "installed Substrate" ) ${HARNESS_SUBSTRATE_RELEASE} from ${HARNESS_SUBSTRATE_IMAGE_REPO} (ate-setup, $log)"
  else
    out="$(grep -v '^[[:space:]]*$' "$log" | tail -n 3 | tr '\n' ' ')"
    bad "Substrate install" "ate-setup deploy ate-system failed (its output: $log): ${out:0:300}"
    return 1
  fi
}

# project_parts — the project's namespace, WorkerPool (its warm gVisor workers) and atespace, made when missing.
project_parts() {
  local manifest out n
  # ASS-535: the pool grows with the project's sandboxes (sandbox-up), so a rerun never lowers it below what it has.
  n="$(kc -n "$NS" get workerpool "$NS" -o json 2>/dev/null | jq -r '.spec.replicas // 0' 2>/dev/null)"
  [[ "$n" =~ ^[0-9]+$ && "$n" -gt "${HARNESS_SUBSTRATE_WARM_WORKERS:-1}" ]] || n="${HARNESS_SUBSTRATE_WARM_WORKERS:-1}"
  manifest="$(jq -cn --arg ns "$NS" --arg p "$P" --arg img "$HARNESS_SUBSTRATE_WORKER_IMAGE" --argjson n "$n" \
    --arg mem "${HARNESS_SUBSTRATE_WORKER_MEMORY_MI:-4096}Mi" --arg cpu "${HARNESS_SUBSTRATE_WORKER_CPUS:-4}" '{
    apiVersion: "v1", kind: "List", items: [
      { apiVersion: "v1", kind: "Namespace", metadata: { name: $ns, labels: { "harness.dev/project": $p } } },
      { apiVersion: "ate.dev/v1", kind: "WorkerPool", metadata: { name: $ns, namespace: $ns, labels: { workload: $ns, "harness.dev/project": $p } },
        spec: { replicas: $n, workerImage: $img, sandboxClasses: [{ name: "gvisor" }],
          template: { resources: { limits: { cpu: $cpu, memory: $mem }, requests: { cpu: "100m", memory: "256Mi" } } } } } ] }')"
  if ! out="$(kc apply -f - <<< "$manifest" 2>&1)"; then bad "project ${P}'s workers" "kubectl apply of its namespace and WorkerPool failed: $(first_line "$out")"; return 1; fi
  grep -qE '(created|configured)$' <<< "$out" && done_ "applied ${P}'s namespace and WorkerPool $NS ($(grep -E '(created|configured)$' <<< "$out" | tr '\n' ';' | sed 's/;$//'))"
  if ! ate get atespace "$NS" >/dev/null 2>&1; then
    if out="$(ate create atespace "$NS" 2>&1)"; then done_ "created ${P}'s atespace $NS"; else bad "project ${P}'s atespace" "kubectl ate create atespace $NS failed: $(first_line "$out")"; return 1; fi
  fi
}

# unstick — HARNESS_SUBSTRATE_REPAIR: pods of the system namespaces and the project's not ready for GRACE seconds
# deleted, so their controllers make them anew.
unstick() {
  local pods name
  pods="$(kc get pods -A -o json 2>/dev/null)" || return 0
  while IFS=$'\t' read -r ns name; do
    [[ -n "$name" ]] || continue
    kc -n "$ns" delete pod "$name" --wait=false >/dev/null 2>&1 && done_ "deleted pod $ns/$name, not ready for over ${GRACE}s, for its controller to make anew"
  done < <(jq -r --arg ns "$NS" --argjson grace "$GRACE" --argjson now "$(now)" '.items[]
    | select(.metadata.namespace | IN("ate-system", "kube-system", "otel-system", "podcertificate-controller-system", "local-path-storage", $ns))
    | select(.status.phase != "Succeeded")
    | select(([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 0)
    | select((.metadata.creationTimestamp | fromdateiso8601) < $now - $grace)
    | [.metadata.namespace, .metadata.name] | @tsv')
}

up() {
  local out
  host_setup
  [[ ${#failed[@]} -eq 0 ]] || return
  kit_ok || return
  write_kind_config || { bad "kind config" "could not be written in $S"; return; }
  if ! node_exists; then
    mkdir -p "$S/$P" && chmod 700 "$S" "$S/$P"
    if out="$(kind create cluster --name "$C" --kubeconfig "$KC" --config "$S/kind-config.yaml" --image "$HARNESS_SUBSTRATE_NODE_IMAGE" --wait 120s 2>&1)"; then
      chmod 600 "$KC" 2>/dev/null
      done_ "created the kind cluster $C (${HARNESS_SUBSTRATE_NODE_IMAGE%%@*})"
      rm -f "$S/clusters/$C/installed"
    else
      bad "kind cluster" "kind create cluster --name $C failed: $(first_line "$(grep -iE 'error|fail' <<< "$out" || echo "$out")")"; return
    fi
    set_proxy_arp
  fi
  write_kubeconfig || return
  wait_api 180 || { bad "API server" "the cluster $C's API server is not ready after 180 s"; return; }
  [[ "${HARNESS_SUBSTRATE_REPAIR:-}" != 1 ]] || unstick
  install || return
  # After a restart or an install, ate-api-server takes a while to answer; the atespace needs it.
  kc -n ate-system rollout status deployment/ate-api-server --timeout=300s >/dev/null 2>&1 \
    || { bad "ate-api-server" "not ready within 300 s: $(first_line "$(kc -n ate-system get pods 2>&1 | grep -v Running | tail -n 3)")"; return; }
  project_parts
  registry_up
}

# --- ASS-535: the cluster's registry and the project's sandboxes -------------------------------------------------
REG=harness-substrate-registry
RP="${HARNESS_SUBSTRATE_REGISTRY_PORT:-5011}"
registry_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$REG" 2>/dev/null)" == true ]]; }

# registry_up — the registry container running on kind's network as kind-registry (see the header).
registry_up() {
  local out
  registry_running && return 0
  if docker inspect -f '{{.State.Running}}' "$REG" >/dev/null 2>&1; then
    if out="$(docker start "$REG" 2>&1)"; then done_ "started the cluster's registry $REG"; else bad registry "$REG could not be started: $(first_line "$out")"; fi
    return
  fi
  if out="$(docker run -d --restart=always --name "$REG" --network kind --network-alias kind-registry -p "127.0.0.1:$RP:5000" \
      -v harness-substrate-registry:/var/lib/registry "${HARNESS_SUBSTRATE_REGISTRY_IMAGE:-registry:3}" 2>&1)"; then
    done_ "started the cluster's registry $REG (kind-registry on kind's network, 127.0.0.1:$RP on this machine)"
  else bad registry "$REG could not be started: $(first_line "$out")"; fi
}

# actor_json <actor> — the actor as kubectl-ate prints it, or nothing when there is none.
actor_json() { ate get actor "$1" -a "$NS" -o json 2>/dev/null | jq -ce 'select(.metadata.name != null)' 2>/dev/null; }
actor_state() { jq -r '.status.state // "" | sub("^ACTOR_STATE_"; "") | ascii_downcase' <<< "$1"; }
# ASS-568: "crashed", then Substrate's reason (status.crash.message) when the actor JSON has one: "crashed: <why>".
crashed_why() { local c; c="$(jq -r '.status.crash.message // ""' <<< "${1:-null}" 2>/dev/null | head -n 1)"; printf 'crashed%s' "${c:+: ${c:0:300}}"; }
proxy_dir() { echo "$S/proxies/$P"; }
proxy_pid() { local f; f="$(proxy_dir)/$1.pid"; [[ -f "$f" ]] && awk 'NR == 1' "$f"; }
proxy_port() { local f; f="$(proxy_dir)/$1.pid"; [[ -f "$f" ]] && awk 'NR == 2' "$f"; }
proxy_alive() { local pid; pid="$(proxy_pid "$1")"; [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; }
answers() { curl -fsS -m 3 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; }
proxy_down() {
  local pid; pid="$(proxy_pid "$1")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; done_ "ended the proxy to $1 (pid $pid)"; fi
  rm -f "$(proxy_dir)/$1.pid"
}

sandbox_template() {
  local ref="$1" name="$2" manifest out t i golden="" err="" mem cpu
  [[ "$ref" =~ ^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ && "$name" =~ ^[a-z0-9-]+$ ]] || { bad template "sandbox-template needs <repository@sha256:…> <name>"; return; }
  if ! ate get actor-template "$name" -a "$NS" -o json >/dev/null 2>&1; then
    # A worker's limit, less 1/8: an actor as large as its worker never places (ASS-532 section 1).
    mem="$(( ${HARNESS_SUBSTRATE_WORKER_MEMORY_MI:-4096} * 1048576 * 7 / 8 ))" cpu="$(awk -v c="${HARNESS_SUBSTRATE_WORKER_CPUS:-4}" 'BEGIN { printf "%d", c * 1000 }')"
    manifest="$(jq -cn --arg ns "$NS" --arg name "$name" --arg img "localhost:$RP/$ref" --arg mem "$mem" --arg cpu "$cpu" '{
      metadata: { atespace: $ns, name: $name }, workerSelector: { matchLabels: { workload: $ns } },
      containers: [{ name: "sandbox", image: $img, env: [{ name: "PORT", value: "80" }],
        securityContext: { capabilities: { add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "SETFCAP", "SETPCAP", "SYS_CHROOT"] } },
        volumeMounts: [{ name: "egress-trust", mountPath: "/run/ate/egress-trust-bundle" }] }],
      volumes: [{ name: "egress-trust", systemInfo: { dataSources: [{ trustBundle: { names: ["egress-mitm.ate.dev", "system-roots.ate.dev"], path: "trust-bundle.pem" } }] } }],
      resources: { limits: { cpuMillicores: $cpu, memoryBytes: $mem } },
      snapshotConfig: { preferredFidelity: "SNAPSHOT_FIDELITY_MEMORY" } }')"
    if out="$(ate create actor-template -f - <<< "$manifest" 2>&1)"; then done_ "created ${P}'s sandbox template $name ($ref)"
    else bad template "kubectl ate create actor-template $name failed: $(first_line "$out")"; return; fi
  fi
  for ((i = 0; i < ${HARNESS_SUBSTRATE_TEMPLATE_WAIT:-300}; i += 2)); do
    t="$(ate get actor-template "$name" -a "$NS" -o json 2>/dev/null)"
    golden="$(jq -r '.status.goldenSnapshotStatus.goldenTag.name // empty' <<< "$t" 2>/dev/null)"
    err="$(jq -r '.status.goldenSnapshotStatus.errorMessage // empty' <<< "$t" 2>/dev/null)"
    [[ -n "$golden" || -n "$err" ]] && break
    sleep 2
  done
  [[ -z "$err" ]] || { bad template "template $name has no golden snapshot: $err"; return; }
  [[ -n "$golden" ]] || bad template "template $name has no golden snapshot after ${HARNESS_SUBSTRATE_TEMPLATE_WAIT:-300} s (ate-api-server's log says why)"
}

sandbox_up() {
  local actor="$1" template="$2" a state out i n running
  [[ "$actor" =~ ^[a-z0-9-]+$ ]] || { bad sandbox "invalid sandbox name '$actor'"; return; }
  if ! a="$(actor_json "$actor")"; then
    [[ "$template" =~ ^[a-z0-9-]+$ ]] || { bad sandbox "no sandbox $actor, and no template to make it from"; return; }
    if out="$(ate create actor "$actor" -a "$NS" --template "$template" 2>&1)"; then done_ "created the sandbox $actor from $template"; created=true
    else bad sandbox "kubectl ate create actor $actor failed: $(first_line "$out")"; return; fi
    a="$(actor_json "$actor")"
  fi
  state="$(actor_state "$a")"
  # ASS-568: a crashed actor cannot be resumed (FailedPrecondition, "want ACTOR_STATE_SUSPENDED"): said at once.
  [[ "$state" != crashed ]] || { bad crashed "the sandbox $actor has crashed ($(crashed_why "$a"))"; return; }
  if [[ "$state" != running ]]; then
    for ((i = 0; i < ${HARNESS_SUBSTRATE_RESUME_WAIT:-120}; i++)); do
      if out="$(ate resume actor "$actor" -a "$NS" 2>&1)"; then done_ "resumed the sandbox $actor (it was ${state:-new})"; break; fi
      if grep -qE 'ACTOR_STATE_CRASHED|is CRASHED' <<< "$out"; then
        # It crashed between the read above and the resume (or Substrate crashed it for a lost snapshot on resuming).
        a="$(actor_json "$actor" || true)"
        bad crashed "the sandbox $actor has crashed ($(crashed_why "$a")): $(first_line "$out")"; return
      fi
      if grep -q 'no worker has room' <<< "$out"; then
        # One more worker for it: the pool's replicas, at least the running sandboxes and this one.
        running="$(ate get actor -a "$NS" -o json 2>/dev/null | jq '[.actors[]? | select(.status.state | IN("ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING"))] | length')"
        n="$(kc -n "$NS" get workerpool "$NS" -o json 2>/dev/null | jq -r '.spec.replicas // 0')"
        if [[ "$n" =~ ^[0-9]+$ && "$n" -lt $(( ${running:-0} + 1 )) ]]; then
          if kc -n "$NS" patch workerpool "$NS" --type merge -p "{\"spec\":{\"replicas\":$(( ${running:-0} + 1 ))}}" >/dev/null 2>&1; then done_ "grew ${P}'s WorkerPool to $(( ${running:-0} + 1 )) workers for $actor"; fi
        fi
      elif [[ $i -ge 5 ]]; then bad sandbox "kubectl ate resume actor $actor failed: $(first_line "$out")"; return; fi
      sleep 1
    done
    a="$(actor_json "$actor")"; state="$(actor_state "$a")"
    [[ "$state" == running || "$state" == resuming ]] || { bad sandbox "the sandbox $actor is ${state:-gone}, not running, after ${HARNESS_SUBSTRATE_RESUME_WAIT:-120} s: $(first_line "${out:-}")"; return; }
  fi
}

sandbox_proxy() {
  local actor="$1" port="$2" i
  [[ "$actor" =~ ^[a-z0-9-]+$ && "$port" =~ ^[0-9]+$ ]] || { bad proxy "sandbox-proxy needs <actor> <port>"; return; }
  if proxy_alive "$actor" && [[ "$(proxy_port "$actor")" == "$port" ]] && answers "$port"; then return 0; fi
  proxy_down "$actor"
  mkdir -p "$(proxy_dir)" "$S/logs"
  nohup kubectl-ate --kubeconfig "$KC" proxy actor "$actor" "$port:80" -a "$NS" > "$S/logs/proxy-$P-$actor.log" 2>&1 < /dev/null &
  printf '%s\n%s\n' "$!" "$port" > "$(proxy_dir)/$actor.pid"
  for ((i = 0; i < 150; i++)); do answers "$port" && { done_ "started the proxy to $actor on 127.0.0.1:$port"; return 0; }; kill -0 "$!" 2>/dev/null || break; sleep 0.2; done
  bad proxy "the sandbox $actor's command server does not answer on 127.0.0.1:$port: $(first_line "$(tail -n 3 "$S/logs/proxy-$P-$actor.log" 2>/dev/null)")"
}

sandbox_stop() {
  local actor="$1" a state out
  proxy_down "$actor"
  a="$(actor_json "$actor")" || return 0
  state="$(actor_state "$a")"
  [[ "$state" == running || "$state" == resuming ]] || return 0
  if out="$(ate suspend actor "$actor" -a "$NS" 2>&1)"; then done_ "suspended the sandbox $actor (hibernated: its files and processes kept)"
  else bad sandbox "kubectl ate suspend actor $actor failed: $(first_line "$out")"; fi
}

sandbox_delete() {
  local actor="$1" out
  proxy_down "$actor"
  [[ ! "$actor" =~ ^[a-z0-9-]+$ ]] || rm -rf "$S/egress/$P/$actor"   # ASS-536: its rule sets go with it
  actor_json "$actor" >/dev/null || return 0
  if out="$(ate delete actor "$actor" -a "$NS" 2>&1)"; then done_ "deleted the sandbox $actor"
  else bad sandbox "kubectl ate delete actor $actor failed: $(first_line "$out")"; fi
}

# --- ASS-538: credentials through the egress gateway (src/substrate/egress.js says the design) ---------------------
PROVIDER=k8s-credential-provider
NSPOLICY=k8s-credential-provider-namespace-policy

# policies_of <configmap json> — its namespace policy's `policies` list as JSON: the harness writes it as JSON (valid
# YAML) after a comment; the install's own (comments and `policies: []`) reads as []. Fails on anything else.
policies_of() {
  local text body
  text="$(jq -r '.data["namespace-policy.yaml"] // ""' <<< "$1")" || return 1
  body="$(grep -v '^[[:space:]]*#' <<< "$text" | grep -v '^[[:space:]]*$')"
  if [[ -z "$body" || "$body" =~ ^policies:[[:space:]]*\[\][[:space:]]*$ ]]; then echo '[]'; return 0; fi
  jq -ce '.policies | arrays' <<< "$body" 2>/dev/null
}

# credentials_apply — see the header. The input holds tokens: it lives in a variable, goes to kubectl on stdin, and
# nothing of it but Secret names is ever printed.
credentials_apply() {
  local in policy names list out cm pols want stale a actors
  in="$(cat)"
  # printf into a pipe, never a here-string (which bash may back with a temporary file).
  policy="$(printf '%s' "$in" | jq -c '.policy // empty' 2>/dev/null)"
  names="$(printf '%s' "$in" | jq -r '.secrets[]?.metadata.name' 2>/dev/null)" || { bad credentials "the input is not { secrets, policy } JSON"; return; }
  kc get namespace "$NS" >/dev/null 2>&1 || { bad credentials "${P}'s namespace $NS is missing: substrate:up first"; return; }
  if [[ -n "$names" ]]; then
    if out="$(printf '%s' "$in" | jq -c --arg ns "$NS" '{ apiVersion: "v1", kind: "List", items: [.secrets[] | .metadata.namespace = $ns] }' | kc apply -f - 2>&1)"; then
      grep -qE '(created|configured)$' <<< "$out" && done_ "applied ${P}'s credential Secrets ($(grep -E '(created|configured)$' <<< "$out" | tr '\n' ';' | sed 's/;$//'))"
    else
      # Its output is not passed on: an error may quote the object, the token with it.
      bad credentials "kubectl apply of ${P}'s credential Secrets failed (its output is not shown: it may quote a Secret)"; return
    fi
  fi
  unset in
  if list="$(kc -n "$NS" get secrets -l harness.dev/credential -o json 2>/dev/null)"; then
    for stale in $(jq -r '.items[].metadata.name' <<< "$list"); do
      grep -qxF "$stale" <<< "$names" && continue
      if kc -n "$NS" delete secret "$stale" >/dev/null 2>&1; then done_ "deleted the Secret $stale (its credential is no longer declared)"; else bad credentials "the Secret $stale could not be deleted"; fi
    done
  fi
  if ! cm="$(kc -n ate-system get configmap "$NSPOLICY" -o json 2>/dev/null)"; then bad credentials "the credential provider's namespace policy ($NSPOLICY in ate-system) is missing: is Substrate installed with --credential-provider k8s.io?"
  elif ! pols="$(policies_of "$cm")"; then bad credentials "the credential provider's namespace policy is not one the harness can read (JSON, or the install's empty one); fix $NSPOLICY in ate-system"
  else
    want="$(jq -c --arg ns "$NS" '[.[] | select(.atespace != $ns)] + [{ atespace: $ns, allowedNamespaces: [$ns] }] | sort_by(.atespace)' <<< "$pols")"
    if [[ "$(jq -cS 'sort_by(.atespace)' <<< "$pols")" != "$(jq -cS '.' <<< "$want")" ]]; then
      if out="$(jq -c --argjson w "$want" '.data["namespace-policy.yaml"] = ("# Written by the harness (ASS-538, substrate:credentials): each project'"'"'s atespace may resolve its own namespace'"'"'s Secrets only.\n" + ({ policies: $w } | tojson) + "\n") | del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.managedFields)' <<< "$cm" | kc apply -f - 2>&1)"; then
        done_ "granted ${P}'s atespace $NS its own namespace's Secrets in the credential provider's namespace policy"
        # The provider reads the policy only at start (ASS-532): restarted for it.
        if kc -n ate-system rollout restart "deployment/$PROVIDER" >/dev/null 2>&1 && kc -n ate-system rollout status "deployment/$PROVIDER" --timeout=180s >/dev/null 2>&1; then done_ "restarted the credential provider $PROVIDER (it reads its namespace policy only at start)"
        else bad credentials "the credential provider $PROVIDER did not come back after its restart: $(first_line "$(kc -n ate-system get pods 2>&1 | grep "$PROVIDER")")"; fi
      else bad credentials "the credential provider's namespace policy could not be written: $(first_line "$out")"; fi
    fi
  fi
  applied=()
  if [[ -n "$policy" ]] && actors="$(ate get actor -a "$NS" -o json 2>/dev/null)"; then
    for a in $(jq -r '.actors[]?.metadata.name' <<< "$actors"); do
      # ASS-536's named sets: this ticket's rules are the set `credentials` (the forwarder's are `mac`).
      sandbox_egress "$a" credentials < <(jq -c '.rules' <<< "$policy")   # not a pipe: its did and failed are this shell's
      applied+=("$a")
    done
  fi
  credential_names="$names"
}

# egress_status — health's `egress` object (see the header), into egress_json.
egress_status() {
  local d ready=false why="" cm pols granted=false secrets='[]' denied='[]' logs
  if d="$(kc -n ate-system get deployment "$PROVIDER" -o json 2>/dev/null)"; then
    if jq -e '(.status.readyReplicas // 0) >= 1' <<< "$d" >/dev/null 2>&1; then ready=true; else why="$(jq -r '"\(.status.readyReplicas // 0) of \(.spec.replicas // 1) ready"' <<< "$d")"; fi
  else why="no deployment $PROVIDER in ate-system (Substrate installed without --credential-provider k8s.io?)"; fi
  if cm="$(kc -n ate-system get configmap "$NSPOLICY" -o json 2>/dev/null)" && pols="$(policies_of "$cm")"; then
    jq -e --arg ns "$NS" 'any(.[]; .atespace == $ns and ((.allowedNamespaces // []) | index($ns)))' <<< "$pols" >/dev/null 2>&1 && granted=true
  fi
  secrets="$(kc -n "$NS" get secrets -l harness.dev/credential -o json 2>/dev/null | jq -c '[.items[].metadata.name] | sort' 2>/dev/null)" || secrets='[]'
  [[ -n "$secrets" ]] || secrets='[]'
  if logs="$(kc -n ate-system logs deployment/atenet-egress -c ext-proc --since="${HARNESS_SUBSTRATE_DENIALS_SINCE:-10m}" 2>/dev/null)"; then
    # Its lines are JSON ({ time, msg, actor: { atespace, name }, host, dialedPort, … }, seen on the real gateway);
    # one that is not is kept as it is.
    denied="$(grep 'egress denied' <<< "$logs" | grep -F "$NS" | tail -n 20 | jq -Rsc 'split("\n") | map(select(. != "") | . as $l | (try fromjson catch null) as $j
      | if ($j | type) == "object" then { at: $j.time, actor: $j.actor.name, host: $j.host,
          line: "\($j.msg) (sandbox \($j.actor.name // "?"), \($j.host // "?")\(if $j.dialedPort then ", port \($j.dialedPort)" else "" end))" }
        else { at: null, line: $l[0:400] } end)')" || denied='[]'
  fi
  egress_json="$(jq -cn --argjson r "$ready" --arg why "$why" --argjson g "$granted" --argjson s "$secrets" --argjson d "${denied:-[]}" --arg ns "$NS" \
    '{ provider: { ready: $r, why: (if $why == "" then null else $why end) }, policy: { atespace: $ns, granted: $g }, secrets: $s, denied: $d }')"
}

# problem <what> <why> <repair: true|false>
problems=()
problem() { problems+=("$(jq -cn --arg w "$1" --arg y "$2" --argjson r "$3" '{ what: $w, why: $y, repair: $r }')"); }
bytes() {   # docker's "1.5GiB" → bytes
  awk -v s="$1" 'BEGIN { n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
    m = (u == "KiB" ? 1024 : u == "MiB" ? 1048576 : u == "GiB" ? 1073741824 : u == "TiB" ? 1099511627776 : u == "kB" ? 1e3 : u == "MB" ? 1e6 : u == "GB" ? 1e9 : 1)
    printf "%d", n * m }'
}

health() {
  local state=healthy info mem cpus need started=0 young=false stats used cpu sandboxes=null pods templates tpl api=false rel
  local avail="" node=false
  if ! info="$(docker info --format '{{.MemTotal}} {{.NCPU}}' 2>&1)"; then
    problem docker "not answering (docker info: $(first_line "$info"))" false
    report docker-down; return
  fi
  read -r mem cpus <<< "$info"
  need="${HARNESS_SUBSTRATE_NEED_MEMORY:-0}"
  if [[ "$mem" =~ ^[0-9]+$ && "$need" =~ ^[0-9]+$ && "$need" -gt 0 && "$mem" -lt "$need" ]]; then
    problem "docker memory" "Docker has $(awk -v b="$mem" 'BEGIN { printf "%.1f", b / 1073741824 }') GiB, the cluster needs at least $(awk -v b="$need" 'BEGIN { printf "%.1f", b / 1073741824 }') GiB$( [[ "$HOST" == mac ]] && echo ' (Docker Desktop: Settings, Resources, Memory)')" false
  fi
  used="$(docker stats --no-stream --format '{{.MemUsage}}' 2>/dev/null | awk '{ print $1 }' | while read -r u; do bytes "$u"; echo; done | awk '{ s += $1 } END { printf "%d", s }')"
  if [[ "$mem" =~ ^[0-9]+$ && "$mem" -gt 0 && "${used:-0}" -gt $((mem * 9 / 10)) ]]; then
    problem "docker memory" "Docker's containers use $(awk -v b="$used" 'BEGIN { printf "%.1f", b / 1073741824 }') of its $(awk -v b="$mem" 'BEGIN { printf "%.1f", b / 1073741824 }') GiB, over 90%" false
  fi
  if [[ "$HOST" != mac ]]; then
    avail="$(awk '$1 == "MemAvailable:" { print $2 * 1024 }' "$ROOT/proc/meminfo" 2>/dev/null)"
    [[ -z "$avail" || "$avail" -ge 1073741824 ]] || problem "host memory" "the machine has only $(awk -v b="$avail" 'BEGIN { printf "%.2f", b / 1073741824 }') GiB available" false
  fi
  if ! node_exists; then
    problem cluster "there is no kind cluster $C on this machine" true
    report missing; return
  fi
  if ! node_running; then problem node "the cluster's node $NODE is not running" true; report broken; return; fi
  node=true
  started="$(node_started_at)"
  [[ "$started" =~ ^[0-9]+$ && "$started" -gt 0 && $(( $(now) - started )) -lt "$GRACE" ]] && young=true
  proxy_arp_on || problem "proxy ARP" "is off on the cluster's node $NODE (its sandboxes cannot reach each other)" true
  stats="$(docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' "$NODE" 2>/dev/null)"
  usage_mem="$(bytes "$(awk '{ print $1 }' <<< "$stats")")"; usage_cpu="$(awk '{ gsub(/%/, "", $NF); print $NF + 0 }' <<< "$stats")"
  if ! kc get --raw /readyz >/dev/null 2>&1; then
    problem api "the cluster's API server is not ready" true
    report "$(settle)"
    return
  fi
  api=true
  rel="$(installed_release)"
  [[ "$rel" == "$(wanted_release)" ]] || problem release "Substrate ${rel:+${rel##* }}${rel:-is not recorded as installed}${rel:+ is installed}; ${HARNESS_SUBSTRATE_RELEASE:-?} is pinned" true
  if pods="$(kc get pods -A -o json 2>/dev/null)"; then
    while IFS=$'\t' read -r ns name why; do
      [[ -n "$name" ]] && problem pods "$ns/$name is not ready ($why)" true
    done < <(jq -r --arg ns "$NS" '.items[]
      | select(.metadata.namespace | IN("ate-system", "kube-system", "otel-system", "podcertificate-controller-system", "local-path-storage", $ns))
      | select(.status.phase != "Succeeded")
      | select(([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 0)
      | [.metadata.namespace, .metadata.name, (([.status.containerStatuses[]?.state.waiting.reason // empty] | first) // .status.phase // "unknown")] | @tsv' <<< "$pods")
  else problem pods "kubectl get pods failed" true; fi
  if ! out="$(kc get --raw '/api/v1/namespaces/ate-system/services/http:rustfs:9000/proxy/health' 2>&1)" || [[ "$(jq -r '.status // empty' <<< "$out" 2>/dev/null)" != ok ]]; then
    problem rustfs "its /health did not answer ok (Substrate's snapshots live there): $(first_line "$out")" true
  fi
  if ! out="$(kc -n ate-system exec postgres-0 -c postgres -- pg_isready 2>&1)"; then problem postgres "pg_isready in postgres-0: $(first_line "$out")" true; fi
  if ! out="$(kc -n "$NS" get workerpool "$NS" -o json 2>&1)"; then problem workers "${P}'s WorkerPool $NS is missing: $(first_line "$out")" true
  else
    # ASS-537 AC3: its workers and each one's memory request (a Kubernetes quantity: 256Mi, 1Gi, 500M…) in bytes.
    workers="$(jq -c 'def qty: tostring | capture("^(?<n>[0-9.]+)(?<u>[A-Za-z]*)$") as $q
        | ($q.n | tonumber) * ({ "": 1, Ki: 1024, Mi: 1048576, Gi: 1073741824, Ti: 1099511627776, k: 1000, M: 1e6, G: 1e9, T: 1e12 }[$q.u] // 1);
      { replicas: (.status.replicas // .spec.replicas // null), "memory-request-bytes": ((.spec.template.resources.requests.memory // null) | if . == null then null else (qty? // null) end) }' <<< "$out" 2>/dev/null)"
    if ! jq -e '(.status.readyReplicas // 0) >= (.spec.replicas // 0)' <<< "$out" >/dev/null 2>&1; then
      problem workers "${P}'s WorkerPool $NS has $(jq -r '.status.readyReplicas // 0' <<< "$out") of $(jq -r '.spec.replicas // 0' <<< "$out") workers ready" true
    fi
  fi
  if ! out="$(ate get atespace "$NS" 2>&1)"; then
    # One the API server does not answer for is not missing: it is the API server that is not ready (yet).
    if grep -qiE 'failed to connect|no ready api pods|unavailable|deadline' <<< "$out"; then problem api "ate-api-server does not answer: $(first_line "$out")" true
    else problem atespace "${P}'s atespace $NS is missing" true; fi
  else
    if templates="$(ate get actor-template -a "$NS" -o json 2>/dev/null)"; then
      # \x1f between the fields, not a tab: read collapses tabs, and an empty golden tag must stay a field.
      while IFS=$'\x1f' read -r tpl golden err age; do
        [[ -n "$tpl" && -z "$golden" ]] || continue
        atespace_tpl="\"$NS\",\"name\":\"$tpl\""
        if [[ -n "$err" ]]; then problem templates "template $tpl has no golden snapshot: $err" false
        elif [[ "$age" =~ ^[0-9]+$ && "$age" -ge "$TEMPLATE_GRACE" ]]; then
          why="$(kc -n ate-system logs deployment/ate-api-server --all-containers --since=24h 2>/dev/null | grep -F -e "$atespace_tpl" -e "$NS/$tpl" | grep -iE 'error|fail|cannot|larger' | tail -n 1)"
          # Its log lines are JSON ({ msg, err, … }): the err says why.
          j="$(jq -Rr 'fromjson? | (.err // .msg // empty)' <<< "$why" 2>/dev/null)"; [[ -z "$j" ]] || why="$j"
          problem templates "template $tpl has had no golden snapshot for $((age / 60)) minutes${why:+; ate-api-server says: ${why:0:300}}" false
        fi
      done < <(jq -r --argjson now "$(now)" '.actorTemplates[]? | select(.snapshotConfig.goldenSnapshotConfig.mode != "GOLDEN_SNAPSHOT_MODE_DISABLED")
        | [.metadata.name, (.status.goldenSnapshotStatus.goldenTag.name // ""), (.status.goldenSnapshotStatus.errorMessage // ""),
           ($now - ((.metadata.createTime // "1970-01-01T00:00:00Z") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) | floor | tostring)] | join("\u001f")' <<< "$templates")
    else problem templates "kubectl ate get actor-template -a $NS failed" true; fi
    if out="$(ate get actor -a "$NS" -o json 2>/dev/null)"; then
      sandboxes="$(jq '[.actors[]? | select(.status.state | IN("ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING", "ACTOR_STATE_SUSPENDING"))] | length' <<< "$out")"
      each="$(measure_sandboxes "$out")"
      measure_snapshots "$out"   # ASS-537 AC3
    fi
    egress_status   # ASS-538
  fi
  # ASS-535: the cluster's registry (sandbox images come from it).
  registry_running || problem registry "the cluster's image registry $REG is not running (sandboxes cannot be made from their images)" true
  report "$(settle)"
}

# measure_sandboxes <actors json> — ASS-535 AC3: each of the project's sandboxes, { "<actor>": { state, memory-bytes,
# cpu-percent } }: an active one's memory is its worker pod's cgroup's memory.current, read inside the node — the
# gVisor sandbox's own memory, its rootfs writes included (they live in the Sentry's memory: ASS-532 section 6) —
# and its CPU the pod's usage since the last check (records/usage-<namespace>.json), in percent of one core; a
# suspended one (hibernated) uses neither, 0.
measure_sandboxes() {
  local list uid actor state mem usec prev="$S/records/usage-$NS.json" now_ms lines="" was
  now_ms="$(( $(now) * 1000 ))"
  mkdir -p "$S/records"
  was="$(cat "$prev" 2>/dev/null || echo '{}')"
  list="$(jq -r '.actors[]? | [.metadata.name, (.status.state // "" | sub("^ACTOR_STATE_"; "") | ascii_downcase), (.status.workerAssignment.workerPodUid // "-")] | @tsv' <<< "$1")"
  while IFS=$'\t' read -r actor state uid; do
    [[ -n "$actor" ]] || continue
    mem=0 usec=""
    if [[ "$state" == running || "$state" == resuming || "$state" == suspending ]] && [[ "$uid" != - ]]; then
      read -r mem usec < <(docker exec "$NODE" bash -c 'd=$(find /sys/fs/cgroup/kubelet.slice -maxdepth 3 -type d -name "*pod${1//-/_}.slice" 2>/dev/null | head -n 1); [ -n "$d" ] || exit 1; echo "$(cat "$d/memory.current") $(awk '"'"'$1 == "usage_usec" { print $2 }'"'"' "$d/cpu.stat")"' _ "$uid" 2>/dev/null || echo "0 ")
    fi
    lines+="$(jq -cn --arg a "$actor" --arg s "$state" --arg m "${mem:-0}" --arg u "${usec:-}" --argjson t "$now_ms" --argjson was "$was" '
      ($was[$a] // null) as $p
      | { ($a): { state: $s, "memory-bytes": ($m | tonumber? // 0), usec: ($u | tonumber? // null), at: $t,
          "cpu-percent": (if ($u | tonumber? // null) != null and $p != null and $p.usec != null and $t > $p.at and ($u | tonumber) >= $p.usec
            then ((($u | tonumber) - $p.usec) / 1000 / ($t - $p.at) * 100 * 10 | round / 10) else 0 end) } }')"$'\n'
  done <<< "$list"
  printf '%s' "$lines" | jq -sc 'add // {}' | tee "$prev.new" | jq -c 'map_values(del(.usec, .at))'
  mv -f "$prev.new" "$prev" 2>/dev/null
}

# measure_snapshots <actors json> — ASS-537 AC3: the disk the project's hibernation snapshots take, and the room left
# for them. Substrate keeps an actor's snapshots on the node under /var/lib/ate/snapshots/<actor uid> (kept while it
# runs again: the latest is its next resume's) and their durable copies in rustfs's volume, under
# ate-snapshots/atespaces/<atespace>/actors/<actor uid>; its templates' golden snapshots under …/<atespace>/tags
# (found on the real cluster, 2026-11-22). Sets `snapshots` ({ "<actor>": bytes }), `snapshot_total` (those and the
# atespace's tags) and `disk` ({ total-bytes, free-bytes } of the node's /var, the filesystem they live on).
measure_snapshots() {
  local pairs out
  pairs="$(jq -r '.actors[]? | select(.metadata.uid != null) | "\(.metadata.name)=\(.metadata.uid)"' <<< "$1" 2>/dev/null | tr '\n' ' ')"
  # shellcheck disable=SC2016,SC2086 # expanded in the node; one name=uid per word
  out="$(docker exec "$NODE" sh -c 'ns="$1"; shift; r="$(ls -d /var/local-path-provisioner/*rustfs-data 2>/dev/null | head -n 1)"
    size() { [ $# -gt 0 ] || { echo 0; return; }; du -sk "$@" 2>/dev/null | awk "{ s += \$1 } END { printf \"%.0f\", s * 1024 }"; }
    for p in "$@"; do a="${p%%=*}" u="${p#*=}"; echo "snap $a $(size /var/lib/ate/snapshots/$u ${r:+$r/ate-snapshots/atespaces/$ns/actors/$u})"; done
    echo "tags $(size ${r:+$r/ate-snapshots/atespaces/$ns/tags})"
    df -Pk /var | awk "NR == 2 { printf \"disk %.0f %.0f\\n\", \$2 * 1024, \$4 * 1024 }"' _ "$NS" $pairs 2>/dev/null)" || out=""
  snapshots="" snapshot_total="" disk=""
  [[ -n "$out" ]] || return 0
  snapshots="$(awk '$1 == "snap" { print $2 "\t" $3 }' <<< "$out" | jq -Rsc 'split("\n") | map(select(. != "") | split("\t") | { (.[0]): (.[1] | tonumber? // 0) }) | add // {}')"
  snapshot_total="$(awk '$1 == "snap" || $1 == "tags" { s += $NF } END { printf "%.0f", s }' <<< "$out")"
  disk="$(awk '$1 == "disk" { printf "{\"total-bytes\":%.0f,\"free-bytes\":%.0f}", $2, $3 }' <<< "$out")"
}

# settle — health's state from its problems: healthy with none; starting while the node is young (GRACE) and every
# problem is one a start goes through (the API server, pods, rustfs, postgres, the workers not ready yet); else broken.
settle() {
  if [[ ${#problems[@]} -eq 0 ]]; then echo healthy
  elif [[ "${young:-false}" == true ]] && ! printf '%s\n' "${problems[@]}" | jq -e 'select(.what | IN("api", "pods", "rustfs", "postgres", "workers") | not)' >/dev/null; then echo starting
  else echo broken; fi
}

# report <state> — health's JSON line.
report() {
  local list
  list="$(printf '%s\n' "${problems[@]+"${problems[@]}"}" | jq -sc '[.[] | select(. != null)]')"
  jq -cn --arg state "$1" --argjson problems "$list" --arg host "$HOST" --arg cluster "$C" --arg kc "$KC" \
    --arg mem "${mem:-}" --arg cpus "${cpus:-}" --arg avail "${avail:-}" --arg um "${usage_mem:-}" --arg uc "${usage_cpu:-}" \
    --argjson node "${node:-false}" --arg started "${started:-0}" --arg sandboxes "${sandboxes:-null}" --argjson each "${each:-null}" --arg rel "$(installed_release)" \
    --argjson egress "${egress_json:-null}" \
    --argjson snaps "${snapshots:-null}" --arg snapt "${snapshot_total:-}" --argjson disk "${disk:-null}" --argjson workers "${workers:-null}" '
    def num: if . == "" or . == "null" then null else tonumber end;
    { ok: ($problems | length == 0), state: $state, problems: $problems, host: $host, cluster: $cluster, kubeconfig: $kc,
      release: (if $rel == "" then null else ($rel | split(" ") | last) end),
      docker: { "memory-bytes": ($mem | num), cpus: ($cpus | num) },
      "host-available-bytes": ($avail | num),
      node: { running: $node, "started-at": (if ($started | num) > 0 then ($started | tonumber | todate) else null end) },
      usage: { "memory-bytes": ($um | num), "cpu-percent": ($uc | num), sandboxes: ($sandboxes | num),
        "sandbox-use": (if $each == null or $snaps == null then $each else ($each | with_entries(.value += { "snapshot-bytes": ($snaps[.key] // 0) })) end),
        "snapshot-bytes": ($snapt | num), disk: $disk, workers: $workers } }
    + (if $egress == null then {} else { egress: $egress } end)'
  exit 0
}

down() {
  local out others
  if node_running && { [[ -f "$KC" ]] || write_kubeconfig; }; then
    if ate get atespace "$NS" >/dev/null 2>&1; then
      if out="$(ate delete atespace "$NS" 2>&1)"; then done_ "deleted ${P}'s atespace $NS"; else echo "substrate: atespace $NS not deleted: $(first_line "$out")" >&2; fi
    fi
    if kc get namespace "$NS" >/dev/null 2>&1; then
      if out="$(kc delete namespace "$NS" --wait=false 2>&1)"; then done_ "deleted ${P}'s namespace $NS (its WorkerPool with it)"; else bad "namespace $NS" "not deleted: $(first_line "$out")"; fi
    fi
    others="$(kc get namespaces -o json 2>/dev/null | jq -r --arg ns "$NS" '[.items[].metadata | select(.name | startswith("harness-")) | select(.name != $ns) | select(.deletionTimestamp == null) | .name] | join(", ")')"
  fi
  if node_exists && { [[ "${1:-}" == --cluster ]] || [[ -z "${others:-}" ]]; }; then
    if out="$(kind delete cluster --name "$C" --kubeconfig "$KC" 2>&1)"; then done_ "deleted the kind cluster $C"; rm -rf "$S/clusters/$C"
    else bad "kind cluster" "kind delete cluster --name $C failed: $(first_line "$out")"; fi
  elif node_exists; then done_ "kept the kind cluster $C: other projects use it ($others)"
  fi
  if [[ -f "$KC" ]]; then rm -f "$KC" && done_ "removed ${P}'s kubeconfig $KC"; fi
}

load_image() {
  local tmp out
  node_running || { bad "load image" "the cluster's node $NODE is not running: substrate:up first"; return; }
  mkdir -p "$S/tmp" && tmp="$(mktemp "$S/tmp/image.XXXXXX")" || { bad "load image" "no room in $S/tmp"; return; }
  cat > "$tmp"
  [[ -s "$tmp" ]] || { rm -f "$tmp"; bad "load image" "no image archive on stdin"; return; }
  if out="$(kind load image-archive "$tmp" --name "$C" 2>&1)"; then done_ "loaded an image archive ($(wc -c < "$tmp" | tr -d ' ') bytes) into $NODE"
  else bad "load image" "kind load image-archive failed: $(first_line "$out")"; fi
  rm -f "$tmp"
}

sha256() { if has sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

case "$action" in
  host-setup) host_setup; finish ;;
  up) up; finish "$(jq -cn --arg c "$C" --arg kc "$KC" --arg r "${HARNESS_SUBSTRATE_RELEASE:-}" '{ cluster: $c, kubeconfig: $kc, release: $r }')" ;;
  health) health ;;
  down) down "${1:-}"; finish ;;
  load-image) load_image; finish ;;
  registry-up) registry_up; finish ;;
  sandbox-template) sandbox_template "${1:-}" "${2:-}"; finish "$(jq -cn --arg t "${2:-}" --arg g "${golden:-}" '{ template: $t, golden: (if $g == "" then null else $g end) }')" ;;
  sandbox-up)
    created=false
    sandbox_up "${1:-}" "${2:-}"
    a="$(actor_json "${1:-}" 2>/dev/null || echo '{}')"
    finish "$(jq -c --arg actor "${1:-}" --argjson c "$created" '{ actor: $actor, created: $c, state: (.status.state // "" | sub("^ACTOR_STATE_"; "") | ascii_downcase),
      "worker-pod-uid": (.status.workerAssignment.workerPodUid // null) }' <<< "${a:-{\}}")" ;;
  sandbox-proxy) sandbox_proxy "${1:-}" "${2:-}"; finish "$(jq -cn --arg p "${2:-}" '{ port: ($p | tonumber? // null) }')" ;;
  sandbox-stop) sandbox_stop "${1:-}"; finish ;;
  sandbox-delete) sandbox_delete "${1:-}"; finish ;;
  sandbox-egress) sandbox_egress "${1:-}" "${2:-}"; finish "$(jq -cn --argjson n "$(egress_rules "${1:-x}" | jq length)" '{ rules: $n }')" ;;
  mac-relay) relay_addr=""; mac_relay "$@"; finish "$(jq -cn --arg ns "$NS" --arg a "$relay_addr" '{ host: "harness-mac.\($ns).svc.cluster.local", address: (if $a == "" then null else $a end) }')" ;;
  credentials-apply)
    applied=() credential_names=""
    credentials_apply
    finish "$(jq -cn --arg s "$credential_names" '{ secrets: ($s | split("\n") | map(select(. != ""))), sandboxes: $ARGS.positional }' --args "${applied[@]+"${applied[@]}"}")" ;;
  sandbox-state)
    a="$(actor_json "${1:-}" 2>/dev/null || true)"
    p=null; proxy_alive "${1:-}" && p="$(proxy_port "${1:-}")"
    jq -cn --argjson a "${a:-null}" --arg p "$p" '{ ok: true, exists: ($a != null), state: (if $a == null then null else ($a.status.state // "" | sub("^ACTOR_STATE_"; "") | ascii_downcase) end),
      "worker-pod-uid": ($a.status.workerAssignment.workerPodUid // null), proxy: ($p | tonumber? // null),
      crash: (if $a == null then null else ($a.status.crash.message // null) end) }'
    exit 0 ;;
  stop)
    if node_running; then
      if out="$(docker stop "$NODE" 2>&1)"; then done_ "stopped the cluster's node $NODE (its state kept: the next setup starts it) so the machine can stop itself when idle"
      else bad "cluster node" "$NODE could not be stopped: $(first_line "$out")"; fi
    fi
    finish ;;
  has-kit) [[ "${1:-}" =~ ^[0-9a-f]{64}$ && -f "$S/kit/$1/ready" ]]; exit ;;
  install-kit)
    sha="${1:-}"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { bad kit "install-kit needs the kit's sha256"; finish; }
    mkdir -p "$S/kit" && chmod 700 "$S" && tmp="$(mktemp "$S/kit/incoming.XXXXXX")" || { bad kit "no room in $S/kit"; finish; }
    cat > "$tmp"
    [[ "$(sha256 "$tmp")" == "$sha" ]] || { rm -f "$tmp"; bad kit "the kit received does not match its sha256 $sha"; finish; }
    rm -rf "$S/kit/$sha.part" && mkdir -p "$S/kit/$sha.part" && tar -xzf "$tmp" -C "$S/kit/$sha.part" || { rm -rf "$tmp" "$S/kit/$sha.part"; bad kit "could not be unpacked"; finish; }
    rm -f "$tmp"; rm -rf "$S/kit/$sha"; mv "$S/kit/$sha.part" "$S/kit/$sha" && : > "$S/kit/$sha/ready"
    ln -sfn "$sha" "$S/kit/current"
    for old in "$S/kit"/*; do n="${old##*/}"; [[ "$n" =~ ^[0-9a-f]{64}$ && "$n" != "$sha" ]] && rm -rf "$old"; done
    done_ "installed the Substrate kit ${sha:0:12} in $S/kit"
    finish ;;
  *) echo "usage: substrate host-setup|up|health|down [--cluster]|stop|load-image|registry-up|sandbox-template <ref> <name>|sandbox-up <actor> <template>|sandbox-proxy <actor> <port>|sandbox-stop <actor>|sandbox-delete <actor>|sandbox-state <actor>|sandbox-egress <actor> <set>|mac-relay <port…>|credentials-apply|has-kit <sha>|install-kit <sha>" >&2; exit 2 ;;
esac
