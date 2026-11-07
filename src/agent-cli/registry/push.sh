#!/usr/bin/env bash
# Description: Put a locally built image in a project's registry, so every VM gets it at its next start (vm:start) — registry:push <project> <image>.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/registry.bash"

# <image> is the Mac's Docker image under its name in the project's upstream
# (refused for a project with none), for an Artifact Registry upstream, e.g.
# us-central1-docker.pkg.dev/example-project/containers/devcontainer:1.0.0. It
# goes to zot as 0local/<path>:<tag>, which a VM's hosts.toml asks before the
# cache (registry:hosts-toml), so the VM pulls the rebuild under the unchanged
# name — no golden rebuild — until it is pushed again or swept. Through the
# registry's HTTP API with curl: Docker Desktop's daemon runs in its own VM and
# cannot reach the Mac's 127.0.0.1. `docker save` writes an OCI layout, staged
# in <storage>/push and removed after; blobs zot already holds are skipped.
[[ $# -eq 2 ]] || { echo "usage: registry:push <project> <image>" >&2; exit 1; }
registry_config registry:push "$1"
[[ -n "$upstream" ]] || { echo "registry:push: $1's registry has no upstream, so no VM pulls an image through it" >&2; exit 1; }
[[ "$2" =~ $pushable ]] \
  || { echo "registry:push: give an upstream image with a tag, like $upstream/<project>/<repository>/<image>:<tag>; got '$2'" >&2; exit 1; }
repo="$local_namespace/${BASH_REMATCH[1]}" tag="${BASH_REMATCH[2]}"
api="http://127.0.0.1:$port/v2/$repo"

mkdir -p "$storage/push"
dir="$(mktemp -d "$storage/push/image.XXXXXX")"
trap 'rm -rf "$dir"' EXIT
docker save "$2" | tar -x -C "$dir"

for blob in "$dir"/blobs/sha256/*; do
  digest="sha256:$(basename "$blob")"
  curl -fsI -o /dev/null "$api/blobs/$digest" && continue
  location="$(curl -fsS -D - -o /dev/null -X POST "$api/blobs/uploads/" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
  [[ "$location" == http* ]] || location="http://127.0.0.1:$port$location"
  [[ "$location" == *\?* ]] && location+="&" || location+="?"
  curl -fsS -o /dev/null -X PUT -H 'Content-Type: application/octet-stream' --data-binary "@$blob" "${location}digest=$digest"
done

# put <digest> <reference> — PUT a manifest, an index's own manifests first
# (the ones saved: a platform the Mac does not have is not in the layout).
put() {
  local file="$dir/blobs/sha256/${1#sha256:}" child
  for child in $(jq -r '.manifests[]?.digest' "$file"); do
    [[ -f "$dir/blobs/sha256/${child#sha256:}" ]] && put "$child" "$child"
  done
  curl -fsS -o /dev/null -X PUT -H "Content-Type: $(jq -r .mediaType "$file")" --data-binary "@$file" "$api/manifests/$2"
}
top="$(jq -r '.manifests[0].digest' "$dir/index.json")"
put "$top" "$tag"
echo "pushed $2 as $top"
