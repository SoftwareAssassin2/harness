#!/usr/bin/env bash
# Description: Put a project's current Substrate sandbox image into the image registry of each cluster its dev-environments.substrate.clusters names (the Mac's, each workstation's and cloud VM's, over the harness's SSH connection), only when its digest changed — substrate:deliver-image <project> [<machine>…]; prints JSON.
set -euo pipefail

# ASS-534, ASS-535. Sandbox images are built and kept on the Mac
# (substrate:build-image: the project's zot), never pushed to a cloud
# registry. A cluster's sandboxes are made from its own image registry
# (ASS-535: on-machine/substrate.sh registry-up — Substrate's atelet pulls an
# actor's image itself, from a registry, never from the node's containerd, so
# the `kind load` ASS-534 began with could not serve a template): the image is
# read out of zot as an OCI layout (registry.bash registry_fetch_layout, its
# digest kept) and pushed to the cluster's registry as sandbox/<project>
# (registry_push_layout) — on the Mac to 127.0.0.1:<registry port>, on a
# remote machine through a forward of that port over its one SSH connection
# (workstation.bash: the open master, never a connection of its own;
# `ssh -O forward`, cancelled after). Images already there keep working while
# the Mac is off; a new one reaches a machine the next time it runs.
#
# For each cluster — every machine its dev-environments.substrate.clusters
# names (mac, its workstations and cloud VMs; a gke entry never), or those
# named — with the image of the machine's architecture (the Mac's own: arm64
# on Apple silicon; amd64 for GCP's x86 machines), from that architecture's
# label (sandbox-image-<arch>.json):
#   - skipped, "current", when sandbox-deliveries.json records that digest
#     delivered to it already: each image crosses the operator's upload link
#     once per machine;
#   - skipped, "not connected", when a remote machine's connection is not
#     open — nothing here starts or connects a machine; the next run delivers;
#   - skipped, "no image", when no image is built for its architecture
#     (substrate:build-image <project> --arch <arch>);
#   - else delivered, and recorded in sandbox-deliveries.json
#     { "<machine>": { arch, digest, ref ("sandbox/<project>@<digest>": the
#     repository in the cluster's registry, which a template names), "delivered-at" } }.
# Prints a JSON array, a machine a line:
#   { machine, arch, digest, delivered: true|false, reason?, seconds? }
# and exits 1 when any delivery failed (each said on stderr; the others go on),
# or when an image named machine has none built.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox-image.bash"
source "$here/../json-file.bash"
source "$here/../workstation.bash"
source "$here/../substrate.bash"

# cluster_push <project> <machine> <layout> <tag> — the image in <layout> pushed to the machine's cluster registry as
# sandbox/<project>:<tag> (a remote machine's through a forward over its connection); prints its digest.
cluster_push() {
  local project="$1" machine="$2" layout="$3" tag="$4" rc=0 out
  if [[ "$machine" == mac ]]; then (port="$SUBSTRATE_REGISTRY_PORT"; registry_push_layout "$layout" "sandbox/$project" "$tag"); return; fi
  # ASS-542: the Mac's end of the forward on the registry's own port, else (the Mac's own cluster's registry holds
  # that port on the Mac when the Mac has a cluster too: the forward fails) on a port free on the Mac.
  local here_port="$SUBSTRATE_REGISTRY_PORT" fwd
  fwd() { ssh $(ws_ssh_options "$project" "$machine" | tr '\n' ' ') -O "$1" -L "127.0.0.1:$here_port:127.0.0.1:$SUBSTRATE_REGISTRY_PORT" "workstation-$machine" >/dev/null 2>&1; }
  if ! fwd forward; then
    here_port="$(node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')" && fwd forward \
      || { echo "substrate:deliver-image: could not forward $machine's cluster registry (port $SUBSTRATE_REGISTRY_PORT) over its connection" >&2; return 1; }
  fi
  out="$(port="$here_port"; registry_push_layout "$layout" "sandbox/$project" "$tag")" || rc=$?
  fwd cancel || true
  [[ $rc -eq 0 ]] && echo "$out"
  return "$rc"
}

# arch_of <machine> — the architecture of the images its cluster runs: the Mac's own; amd64 for a remote machine (GCP's are x86).
arch_of() { if [[ "$1" == mac ]]; then case "$(uname -m)" in arm64|aarch64) echo arm64 ;; *) echo amd64 ;; esac; else echo amd64; fi; }

[[ $# -ge 1 ]] || { echo "usage: substrate:deliver-image <project> [<machine>…]" >&2; exit 1; }
project="$1"; shift
sandbox_definition substrate:deliver-image "$project"
registry_config substrate:deliver-image "$project"
zot_port="$port"
machines=("$@")
if [[ ${#machines[@]} -eq 0 ]]; then
  mapfile -t machines < <(jq -r '(.["dev-environments"] // {}) as $d
    | (($d.workstations // [] | map(.id)) + ($d["cloud-vms"] // [] | map(.id)) + ["mac"]) as $hosts
    | [($d.substrate.clusters // [])[]? | .machine // empty | select(IN($hosts[]))] | .[]' "$projects/$project/project.json")
  [[ ${#machines[@]} -gt 0 ]] || echo "substrate:deliver-image: $project's dev-environments.substrate.clusters names no cluster: none to deliver to" >&2
fi
deliveries="$projects/$project/sandbox-deliveries.json"
[[ -f "$deliveries" ]] || update_json --create "$deliveries" '{}'

failed=0 lines=() work=""
trap '[[ -z "$work" ]] || rm -rf "$work"' EXIT
line() { jq -nc --arg m "$1" --arg a "$2" --arg d "$3" --arg r "${5:-}" --argjson ok "$4" --argjson s "${6:-null}" '{ machine: $m, arch: $a, digest: (if $d == "" then null else $d end), delivered: $ok } + (if $r == "" then {} else { reason: $r } end) + (if $s == null then {} else { seconds: $s } end)'; }
for id in ${machines[@]+"${machines[@]}"}; do
  [[ "$id" == mac ]] || workstation_settings substrate:deliver-image "$project" "$id" >/dev/null || { failed=1; continue; }
  arch="$(arch_of "$id")" label="$(sandbox_label "$project" "$arch")"
  if [[ ! -f "$label" ]]; then
    echo "substrate:deliver-image: sandbox-$project has no $arch image to deliver: build it (substrate:build-image $project --arch $arch)" >&2
    lines+=("$(line "$id" "$arch" "" false "no image")"); failed=1; continue
  fi
  digest="$(jq -r .digest "$label")" repository="$(jq -r .repository "$label")" tag="$(jq -r .tag "$label")"
  if [[ "$(jq -r --arg m "$id" '.[$m].digest // empty' "$deliveries")" == "$digest" ]]; then lines+=("$(line "$id" "$arch" "$digest" false current)"); continue; fi
  if [[ "$id" != mac ]] && ! workstation_alive "$project" "$id"; then lines+=("$(line "$id" "$arch" "$digest" false "not connected")"); continue; fi
  mkdir -p "$storage/substrate"
  [[ -n "$work" ]] || work="$(mktemp -d "$storage/substrate/deliver.XXXXXX")"
  if [[ ! -f "$work/$arch.done" ]]; then   # each architecture's image read out of zot once for every machine
    (port="$zot_port"; registry_fetch_layout "$repository" "$digest" "$arch" "$work/$arch" >/dev/null) \
      || { echo "substrate:deliver-image: sandbox-$project ($arch) $digest could not be read out of the registry on 127.0.0.1:$zot_port" >&2; exit 1; }
    : > "$work/$arch.done"
  fi
  started=$SECONDS
  if pushed="$(cluster_push "$project" "$id" "$work/$arch" "$tag")" && [[ "$pushed" == "$digest" ]]; then
    update_json "$deliveries" --arg m "$id" --arg a "$arch" --arg d "$digest" --arg r "sandbox/$project@$digest" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.[$m] = { arch: $a, digest: $d, ref: $r, "delivered-at": $at }'
    lines+=("$(line "$id" "$arch" "$digest" true "" "$((SECONDS - started))")")
  else
    echo "substrate:deliver-image: sandbox-$project ($arch) could not be put into $id's cluster registry; the next run tries again" >&2
    lines+=("$(line "$id" "$arch" "$digest" false failed)")
    failed=1
  fi
done
printf '%s\n' ${lines[@]+"${lines[@]}"} | jq -s .
exit "$failed"
