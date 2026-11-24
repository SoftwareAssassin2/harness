# The registry commands' shared setup (ASS-70). Each project runs its own zot
# (project-zot) on the Mac: a cache of its upstream that VMs pull through,
# which also holds images built locally. registry_config <command> <project>
# reads the project's "registry" object from data/projects/<project>/project.json —
#   { "storage-path": "projects/<project>/registry", "max-size-gb": <n>, "port": <n>,
#     "upstream": { "host": "<host>", "credentials": "gcloud" } }
# storage-path relative to the data folder (data/), upstream optional (registry_upstream)
# — and sets:
#   $storage   the project's registry folder: images/ (zot's storage), config.json,
#              credentials.json, zot.log, zot.out, last-pulls.json
#   $port      the port zot listens on, at 127.0.0.1 (VMs: host.lima.internal)
#   $max_gb    the soft cap registry:sweep holds the images to
#   $zot_pid_file  where registry:up keeps the pid of the project's zot
# PROJECTS_DIR overrides the projects folder (its parent, $root, is the data folder),
# ZOT_DIR where zot is installed, ZOT_URL and ZOT_SHA256 the download,
# ZOT_UPSTREAM_URL the registry zot's sync fetches from; all for tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"   # replace_file (registry_fetch_layout)
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"
root="$(cd "$projects/.." && pwd -P)"
agent="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../agent.sh"

# zot's release, pinned: the darwin binary from GitHub (not Homebrew's unrelated
# "zot" formula), checked against the sha256 the release published.
zot_version=v2.1.22
zot_url="${ZOT_URL:-https://github.com/project-zot/zot/releases/download/$zot_version/zot-darwin-arm64}"
zot_sha256="${ZOT_SHA256:-24abc467dcd02247eae1ed66022f8e712cafadae26edbad1e9463b8aa0791bbf}"
# Outside the checkout, so every worktree of the harness shares the one binary.
zot_bin="${ZOT_DIR:-$HOME/Library/Application Support/harness/zot}/zot-$zot_version"

# The namespace locally built images are pushed under in zot. It starts with a
# digit, which no GCP project id can, so the sync's content rule ("[a-z]*/**")
# never sends it upstream and a pushed image is never replaced by Artifact
# Registry's image of the same name. registry:arm64-build (ASS-466) puts its
# multi-arch variants there too.
local_namespace=0local

# registry_upstream <command> <project> — the registry zot's sync fetches from,
# from the project's registry.upstream (ASS-134): e.g. Artifact
# Registry, us-central1-docker.pkg.dev (its images and the dev container live
# there), logged in with the Mac's gcloud, the only credential source. Sets:
#   $upstream      its host; empty when the project has none (the harness): its
#                  zot then has no sync, and nothing calls gcloud for it
#   $upstream_url  what zot's sync fetches from
#   $pushable      an upstream image by tag, no digest: what registry:push takes,
#                  and what vm:start pulls again once pushed. BASH_REMATCH[1]
#                  its path, [2] its tag. Matches nothing with no upstream.
registry_upstream() {
  local command="$1" project="$2" config
  config="$(jq -c '.registry.upstream // empty' "$projects/$project/project.json")"
  upstream="" upstream_url="" pushable='^$.'
  [[ -n "$config" ]] || return 0
  jq -e '(.host | type == "string" and test("^[A-Za-z0-9.-]+(:[0-9]+)?$")) and .credentials == "gcloud"' <<<"$config" >/dev/null 2>&1 \
    || { echo "$command: $project's registry upstream in project.json must be { \"host\": \"<host>\", \"credentials\": \"gcloud\" }, or absent for none" >&2; return 1; }
  upstream="$(jq -r .host <<<"$config")"
  upstream_url="${ZOT_UPSTREAM_URL:-https://$upstream}"
  pushable="^${upstream//./\\.}/([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9_][A-Za-z0-9._-]*)\$"
}

registry_config() {
  local command="$1" project="$2" config
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  [[ -f "$projects/$project/project.json" ]] || { echo "$command: no project $project" >&2; return 1; }
  config="$(jq -c '.registry // empty' "$projects/$project/project.json")"
  jq -e '(.["storage-path"] | type == "string" and length > 0) and (.["max-size-gb"] | type == "number" and . > 0) and (.port | type == "number")' <<<"${config:-null}" >/dev/null 2>&1 \
    || { echo "$command: $project has no registry in project.json — add { \"storage-path\": \"projects/$project/registry\", \"max-size-gb\": <n>, \"port\": <n> }" >&2; return 1; }
  storage="$(jq -r '.["storage-path"]' <<<"$config")"
  [[ "$storage" == /* ]] || storage="$root/$storage"
  port="$(jq -r .port <<<"$config")"
  max_gb="$(jq -r '.["max-size-gb"]' <<<"$config")"
  zot_pid_file="${zot_bin%/*}/$project.pid"
  registry_upstream "$command" "$project"
}

# registry_push_layout <layout> <repository> <tag> — the image an OCI layout
# folder holds (its index.json's first manifest: an image, or an index and the
# images of it the layout has) put in the project's zot (registry_config's
# $port) as <repository>:<tag>, over its HTTP API with curl: Docker Desktop's
# daemon runs in its own VM and cannot reach the Mac's 127.0.0.1. Blobs zot
# holds already are skipped; children go before the tag, so nothing answers
# for the tag until it is whole. Prints the pushed manifest's digest.
# registry:push's (a `docker save`d image) and substrate:build-image's (ASS-534: buildx's OCI output).
registry_push_layout() {
  local dir="$1" api="http://127.0.0.1:$port/v2/$2" blob digest location top
  for blob in "$dir"/blobs/sha256/*; do
    digest="sha256:$(basename "$blob")"
    curl -fsI -o /dev/null "$api/blobs/$digest" && continue
    location="$(curl -fsS -D - -o /dev/null -X POST "$api/blobs/uploads/" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
    [[ "$location" == http* ]] || location="http://127.0.0.1:$port$location"
    [[ "$location" == *\?* ]] && location+="&" || location+="?"
    curl -fsS -o /dev/null -X PUT -H 'Content-Type: application/octet-stream' --upload-file "$blob" "${location}digest=$digest" || return 1
  done
  top="$(jq -r '.manifests[0].digest' "$dir/index.json")"
  registry_put_manifest "$dir" "$api" "$top" "$3" || return 1
  echo "$top"
}

# registry_put_manifest <layout> <api> <digest> <reference> — PUT a manifest, an index's own manifests first
# (the ones in the layout: a platform the Mac does not have is not in a `docker save`).
registry_put_manifest() {
  local file="$1/blobs/sha256/${3#sha256:}" child
  for child in $(jq -r '.manifests[]?.digest' "$file"); do
    [[ -f "$1/blobs/sha256/${child#sha256:}" ]] && { registry_put_manifest "$1" "$2" "$child" "$child" || return 1; }
  done
  curl -fsS -o /dev/null -X PUT -H "Content-Type: $(jq -r '.mediaType // "application/vnd.oci.image.manifest.v1+json"' "$file")" --data-binary "@$file" "$2/manifests/$4"
}

# registry_fetch_layout <repository> <reference> <arch> <layout> [<name>] — the
# linux/<arch> image of <repository>:<reference> (a tag or digest) in the
# project's zot fetched into the OCI layout folder <layout> (made when
# missing; blobs it has already are kept, each fetched one checked against its
# digest): an index is resolved to its linux/<arch> manifest. Through zot, so
# an image of the upstream comes through its cache (on-demand sync) with zot's
# own credentials, and nothing asks the Mac's Docker to log in. The layout's
# index.json lists the image (annotated with <name> when given, as the image's
# name for `ctr images import` / `kind load image-archive`). Prints its
# manifest's digest; fails, saying why, when the image or the platform is
# missing (ASS-534).
registry_fetch_layout() {
  local repo="$1" ref="$2" arch="$3" dir="$4" name="${5-}" api="http://127.0.0.1:$port/v2/$1" accept tmp type digest size blob
  accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
  mkdir -p "$dir/blobs/sha256"
  [[ -f "$dir/oci-layout" ]] || echo '{"imageLayoutVersion":"1.0.0"}' | replace_file "$dir/oci-layout"
  [[ -f "$dir/index.json" ]] || echo '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}' | replace_file "$dir/index.json"
  tmp="$(mktemp "$dir/manifest.XXXXXX")"
  if ! curl -fsS -H "Accept: $accept" -o "$tmp" "$api/manifests/$ref" 2>/dev/null; then
    rm -f "$tmp"; echo "$repo:$ref is not in the registry on 127.0.0.1:$port, nor could it fetch it from its upstream" >&2; return 1
  fi
  if jq -e '.manifests' "$tmp" >/dev/null 2>&1; then
    digest="$(jq -r --arg a "$arch" 'first(.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a) | .digest) // empty' "$tmp")"
    if [[ -z "$digest" ]]; then
      echo "$repo@$ref has no linux/$arch image (it has: $(jq -r '[.manifests[].platform | select(.) | "\(.os)/\(.architecture)" | select(. != "unknown/unknown")] | unique | join(", ")' "$tmp"))" >&2
      rm -f "$tmp"; return 1
    fi
    if ! curl -fsS -H "Accept: $accept" -o "$tmp" "$api/manifests/$digest"; then rm -f "$tmp"; echo "$repo@$digest could not be fetched" >&2; return 1; fi
  fi
  digest="sha256:$(shasum -a 256 "$tmp" | cut -d' ' -f1)" type="$(jq -r '.mediaType // "application/vnd.oci.image.manifest.v1+json"' "$tmp")" size="$(wc -c < "$tmp" | tr -d ' ')"
  # A single image (no index): its config names its platform.
  for blob in $(jq -r '.config.digest, .layers[].digest' "$tmp"); do
    [[ -f "$dir/blobs/sha256/${blob#sha256:}" ]] && continue
    curl -fsS -o "$dir/blobs/sha256/.${blob#sha256:}" "$api/blobs/$blob" \
      && [[ "sha256:$(shasum -a 256 "$dir/blobs/sha256/.${blob#sha256:}" | cut -d' ' -f1)" == "$blob" ]] \
      && mv -f "$dir/blobs/sha256/.${blob#sha256:}" "$dir/blobs/sha256/${blob#sha256:}" \
      || { rm -f "$dir/blobs/sha256/.${blob#sha256:}" "$tmp"; echo "$repo@$digest: its blob $blob could not be fetched whole" >&2; return 1; }
  done
  local platform
  platform="$(jq -r '.architecture // empty' "$dir/blobs/sha256/$(jq -r '.config.digest | ltrimstr("sha256:")' "$tmp")" 2>/dev/null || true)"
  if [[ -n "$platform" && "$platform" != "$arch" ]]; then
    rm -f "$tmp"; echo "$repo@$ref is a linux/$platform image, not linux/$arch" >&2; return 1
  fi
  mv -f "$tmp" "$dir/blobs/sha256/${digest#sha256:}"
  jq -c --arg d "$digest" --arg t "$type" --argjson s "$size" --arg a "$arch" --arg n "$name" '
    .manifests = ([.manifests[] | select(.digest != $d)] + [{ mediaType: $t, digest: $d, size: $s, platform: { os: "linux", architecture: $a } }
      + if $n == "" then {} else { annotations: { "io.containerd.image.name": $n, "org.opencontainers.image.ref.name": $n } } end])' \
    "$dir/index.json" | replace_file "$dir/index.json"
  echo "$digest"
}
