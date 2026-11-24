#!/usr/bin/env bash
# Description: Where a project's Substrate sandbox images stand, per architecture — current, building, stale or failed, with digest and log — substrate:image-status <project> [--arch amd64|arm64]; prints JSON.
set -euo pipefail

# ASS-534. sandbox-image.bash sandbox_status, for each architecture the project's
# sandbox/services.yaml declares (or the one given): a JSON object
#   { <arch>: { image, arch, status, hash, built-hash, built-at, digest, ref, exit-code, log, why }, … }
# — why vm:golden-stale's reasons for that image (empty when current).
# {} for a project declaring no sandbox, unless an architecture is given.
# vm:golden-status prints the same as its sandbox-images. Reads, never builds.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/sandbox-image.bash"

[[ $# -eq 1 || ( $# -eq 3 && "$2" == --arch && ( "$3" == amd64 || "$3" == arm64 ) ) ]] \
  || { echo "usage: substrate:image-status <project> [--arch amd64|arm64]" >&2; exit 1; }
sandbox_definition substrate:image-status "$1"
[[ $# -eq 1 ]] || architectures="$3"
for arch in $architectures; do
  jq -c --argjson s "$(sandbox_stale "$1" "$arch")" '. + { why: $s.why }' <<<"$(sandbox_status "$1" "$arch")"
done | jq -s 'map({ (.arch): . }) | add // {}'
