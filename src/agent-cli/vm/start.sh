#!/usr/bin/env bash
# Description: Start a ticket variation's VM, or take it as it runs, and ready it — vm:start <project> <ticket-key> <variation> [--display]; prints { name, ip, credential-kind }.
set -euo pipefail

# The one way every VM is started (ASS-74): by vm:create, and by whatever
# wakes a VM later (ASS-75, a restart after the Mac's). The VM is the
# variation's (vm.bash vm_name), made by vm:create. In order:
#  1. When it is not running, `limactl start` under a macOS sandbox
#     (sandbox-exec) that the VM's host agent — through which Lima maps the
#     VM's host.lima.internal (192.168.5.2) onto the Mac's loopback — cannot
#     leave: it may reach the Mac only at the forwarder (harness.json's
#     forwarder-port), the project's zot (project.json registry.port), the
#     project's Hindsight memory (hindsight.port, ASS-62: never another
#     project's) and the VM's own ssh port (pinned by vm:create), and nothing beyond the Mac
#     either: the VM's own traffic goes out by vzNAT, where the Mac's pf rules
#     (vm:firewall) keep it off the Mac. The agent in the VM has sudo, so
#     none of this is in the VM (AC6). Started without a display
#     (video.display none), whatever a demo left it with, or with one given
#     --display (vz: a window onto its desktop on the Mac, the Demo action's,
#     ASS-76). A VM running already is taken as it is.
#     Under the project's VM lock (vm.bash lock_vms, ASS-75), so control's
#     start and a step's never race; either way the start is recorded in the
#     project's inventory (vms.json): the VM was accessed now.
#  2. vm:credentials <project> <vm> (ASS-71), always, before anything touches
#     the repositories; a restart has cleared the VM's tmpfs. The kind it
#     printed (claude, anthropic, both — ASS-217 — or none) is recorded on the VM's vms.json
#     row as credential-kind (ASS-215): control compares it with the kind the
#     project declares, and refreshes a running VM through vm:start when they
#     differ.
#  3. A fresh forwarder token: 32 random bytes, sent over stdin to the VM's
#     /run/harness/agent-token (tmpfs, 0600) with the forwarder's URL
#     (/run/harness/agent-url); on the Mac only its SHA-256, with the
#     binding { project, ticket, variation, ticket-folder }, in
#     $HARNESS_HOME/vm-tokens.json (0600), replacing the VM's last.
#  4. agent.sh, the forwarder's client (in-vm/agent.sh), installed at
#     /usr/local/bin/agent.sh, so a new one reaches every VM at its next start.
#  5. Each image of the golden image's images.txt (vm:build-golden) that
#     registry:push has put in the project's zot pulled again in the VM, so a
#     rebuild (a project's dev container) reaches every VM at its next start
#     with no golden image rebuild (ASS-70). Only by tag: an image pinned by
#     digest, or never pushed, stays as the golden image baked it. A pull that
#     fails is reported, and the VM keeps the image it has.
#  6. Its vzNAT address (lima0), printed: { name, ip, credential-kind }
#     (null when it declares neither).
# Fails, naming the step, when the VM is missing or any step but 5 fails.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../registry/registry.bash"

[[ $# -eq 3 || ( $# -eq 4 && "$4" == --display ) ]] || { echo "usage: vm:start <project> <ticket-key> <variation> [--display]" >&2; exit 1; }
display=none; [[ $# -eq 3 ]] || display=vz
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
variation_exists vm:start "$project" "$key" "$variation"
vm="$(vm_name "$key" "$variation")"
status="$(limactl list "$vm" --format '{{.Status}}' 2>/dev/null)" || { echo "vm:start: no VM $vm; vm:create makes it" >&2; exit 1; }
forwarder="$(jq -r '.["forwarder-port"] // empty' "$harness_file")"
[[ "$forwarder" =~ ^[0-9]+$ ]] || { echo "vm:start: harness.json has no forwarder-port" >&2; exit 1; }
zot="$(jq -r '.registry.port // empty' "$projects/$project/project.json")"
memory="$(jq -r '.hindsight.port // empty' "$projects/$project/project.json")"

lock_vms vm:start "$project"
status="$(limactl list "$vm" --format '{{.Status}}' 2>/dev/null)" || { echo "vm:start: no VM $vm; vm:create makes it" >&2; exit 1; }
[[ "$status" == Running ]] || start_sandboxed vm:start "$vm" "$display" "$forwarder" $zot $memory
record_vm "$project" "$vm" "$key" "$variation" Running
unlock_vms

kind="$("$agent" vm:credentials "$project" "$vm")"
[[ "$kind" =~ ^(claude|anthropic|both)?$ ]] || { echo "vm:start: vm:credentials printed no credential kind for $vm: '$kind'" >&2; exit 1; }
lock_vms vm:start "$project"
record_vm "$project" "$vm" "$key" "$variation" Running "$kind"
unlock_vms

token="$(openssl rand -hex 32)"
binding="$(jq -nc --arg p "$project" --arg k "$key" --arg v "$variation" --arg f "$(ticket_folder vm:start "$project" "$key")" \
  --arg h "$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ project: $p, ticket: $k, variation: $v, "ticket-folder": $f, "token-sha256": $h, "issued-at": $at }')"
mkdir -p "$(dirname "$tokens_file")"
(umask 077; update_json --create "$tokens_file" --arg vm "$vm" --argjson b "$binding" '.[$vm] = $b')   # made 0600 when missing
{ printf '%s\n%s\n' "$token" "http://host.lima.internal:$forwarder/run"; cat "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/in-vm/agent.sh"; } \
  | limactl shell "$vm" -- bash -c 'set -e; R="${HARNESS_VM_ROOT-}"; umask 077; IFS= read -r t; IFS= read -r u
      printf "%s\n" "$t" > "$R/run/harness/agent-token"; printf "%s\n" "$u" > "$R/run/harness/agent-url"
      sudo tee "$R/usr/local/bin/agent.sh" >/dev/null; sudo chmod 0755 "$R/usr/local/bin/agent.sh"' \
  || { echo "vm:start: could not give $vm its forwarder token and agent.sh" >&2; exit 1; }

folder="$(jq -r '.["golden-image"].folder // empty' "$projects/$project/project.json")"
[[ -z "$folder" || "$folder" == /* ]] || folder="$root/$folder"
if [[ -n "$zot" && -n "$folder" && -f "$folder/images.txt" ]]; then
  registry_upstream vm:start "$project"
  while IFS= read -r image; do
    [[ "$image" =~ $pushable ]] || continue
    curl -fsI -o /dev/null --max-time 10 -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
      "http://127.0.0.1:$zot/v2/$local_namespace/${BASH_REMATCH[1]}/manifests/${BASH_REMATCH[2]}" || continue
    limactl shell "$vm" -- docker pull -q "$image" </dev/null >/dev/null \
      || echo "vm:start: could not pull $image, pushed to $project's registry, in $vm; it keeps the image it has" >&2
  done < "$folder/images.txt"
fi

ip="$(limactl shell "$vm" -- ip -4 -o addr show lima0 | sed -nE 's/.* inet ([0-9.]+)\/.*/\1/p' | head -n 1)"
[[ -n "$ip" ]] || { echo "vm:start: $vm has no vzNAT address (lima0)" >&2; exit 1; }
jq -nc --arg n "$vm" --arg ip "$ip" --arg k "$kind" '{ name: $n, ip: $ip, "credential-kind": (if $k == "" then null else $k end) }'
