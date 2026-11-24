#!/usr/bin/env bash
# Description: Build the Substrate kit (pinned ate-setup, kubectl-ate, kind, kubectl and the release's manifests) for a platform ahead of substrate:up — substrate:kit [<platform>]; prints { platform, sha256, tarball, release }.
set -euo pipefail

# ASS-533: substrate.bash substrate_kit, which says what the kit holds and
# where; <platform> darwin-arm64, darwin-amd64, linux-amd64 or linux-arm64 —
# the Mac's own by default. Built once (needs go, git and curl), then reused.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"

command=substrate:kit
[[ $# -le 1 ]] || { echo "usage: $command [<platform>]" >&2; exit 1; }
platform="${1:-$(substrate_platform $(uname -sm))}"
kit="$(substrate_kit "$command" "$platform")"
jq -cn --arg p "$platform" --arg s "${kit%% *}" --arg t "${kit#* }" --arg r "$SUBSTRATE_RELEASE" '{ platform: $p, sha256: $s, tarball: $t, release: $r }'
