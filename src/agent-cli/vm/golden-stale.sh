#!/usr/bin/env bash
# Description: Whether a project's golden image is stale, and why — vm:golden-stale <project>; prints JSON.
set -euo pipefail

# ASS-149. golden-<project> is stale when the hash its label records
# (golden-image.json, vm:build-golden) is not the hash of its inputs now
# (golden.bash), or it has no label: it was never built. Prints
#   { project, image, stale, hash (the inputs' now), built-hash, built-at, why: [<line>…] }
# — built-hash and built-at null when never built. Why names what changed,
# from the input lines the label records: "added <input>", "removed
# <input>", then "changed <file>" (a file of the definition or the shared
# steps whose sha256 differs), an input a file's path ("definition/<path>",
# "shared/<path>") or the line itself ("repository <url>", a hosts.toml
# line); a label recording no input list, from before ASS-149, says
# "inputs changed since <built-at>; this build recorded no input list"; a
# current image's is empty. Reads, never builds; exits 0 stale or not, and
# fails, naming why, when the project or its definition is missing.
#
# ASS-534: a project declaring a sandbox (data/projects/<project>/sandbox/
# services.yaml) has its Substrate sandbox images read too, one per declared
# architecture (sandbox-image.bash sandbox_stale): any of them stale makes the
# golden environment stale, its reasons added to why as "sandbox-<project>
# (<arch>): <reason>", and the output gains sandbox: [{ arch, stale, hash,
# built-hash, built-at, why }]. The rebuild ticket this raises
# (vm:raise-golden-rebuilds) then rebuilds them with the VM image
# (vm:build-golden). A project declaring none prints as before.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate/sandbox-image.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:golden-stale <project>" >&2; exit 1; }
sandbox_definition vm:golden-stale "$1"
label="$(golden_label "$1")"
[[ -f "$label" ]] || label=/dev/null
vm="$(inputs_stale "$label" "$inputs" "$hash" "golden-$1" | jq -c --arg p "$1" '{ project: $p, image } + del(.image)')"
if [[ "$declared" != true ]]; then echo "$vm"; exit 0; fi
for arch in $architectures; do sandbox_stale "$1" "$arch" | jq -c --arg a "$arch" '{ arch: $a } + del(.image)'; done \
  | jq -sc --argjson vm "$vm" --arg p "$1" '. as $s | $vm + { stale: ($vm.stale or any($s[]; .stale)),
      why: ($vm.why + [$s[] | .arch as $a | .why[] | "sandbox-\($p) (\($a)): \(.)"]), sandbox: $s }'
