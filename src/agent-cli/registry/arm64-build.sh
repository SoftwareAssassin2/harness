#!/usr/bin/env bash
# Description: Build an arm64 variant of each image a project pins for amd64 only (project.json arm64-images) and serve it from the project's registry — registry:arm64-build <project> [<image>]; control runs it every 30 minutes.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/registry.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/arm64.bash"

# ASS-466 (arm64.bash says what is declared and where the variant goes). For
# each declared image (or the one named) at the tag images.txt pins now:
#  - skipped ("present") when 0local/<path>:<tag> already is an index with a
#    linux/arm64 image zot holds whole (arm64_present): a new tag in images.txt
#    builds again; one swept away (registry:sweep) is built again;
#  - else the pinned image is fetched through zot's cache (its upstream amd64
#    manifest); an upstream index that has linux/arm64 already needs nothing
#    ("upstream");
#  - else built for linux/arm64 with the Mac's Docker (docker buildx, native on
#    Apple Silicon): a build clones the repository at its ref (the Mac's git
#    login) and builds its Dockerfile with its args; a base-swap builds
#      FROM --platform=linux/amd64 <image>:<tag> AS upstream
#      FROM <base>
#      COPY --from=upstream <path> <path>   (each of copy)
#    The Mac's Docker must be running, and able to pull the base images (and,
#    for a base-swap, the pinned image: gcloud auth configure-docker <upstream>).
#    `docker save` hands the image over (Docker Desktop's daemon cannot reach
#    the Mac's 127.0.0.1, so nothing is pushed from it — registry:push's way);
#  - then pushed to zot over its HTTP API, children before the tag: the arm64
#    blobs and manifest; the amd64 manifest, its bytes unchanged, with its
#    blobs mounted from the cache's repository (copied when zot cannot
#    mount); last the index under the tag, pairing the two. Until that last
#    PUT nothing answers for 0local/<path>:<tag>, so a failure part way
#    leaves VMs pulling amd64 from the cache, as before.
# Every image's output goes to <storage>/arm64/<path, / as _>.log, fresh at
# each build. A failure is reported per image — on stderr, why and the log's
# last 20 lines — and the next image goes on; it never touches what VMs pull.
# Prints a JSON array, an image a line:
#   { image, tag, result: "built"|"present"|"upstream"|"failed", digest, log, error }
# — digest the arm64 manifest's (null for "upstream" or "failed"), error null
# unless failed. Exits 1 when any failed (or the declarations are invalid).
# One run per project at a time: <project>/arm64-build.lock, waited on up to
# an hour (a build in control's maintenance, a golden build's).
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: registry:arm64-build <project> [<image>]" >&2; exit 1; }
project="$1"
registry_config registry:arm64-build "$project"
arm64_declarations registry:arm64-build "$project"
if [[ $# -eq 2 ]]; then
  arm64="$(jq -c --arg i "$2" 'map(select(.image == $i or "\(.image):\(.tag)" == $i))' <<<"$arm64")"
  [[ "$arm64" != "[]" ]] || { echo "registry:arm64-build: $project declares no arm64 image $2 (project.json arm64-images)" >&2; exit 1; }
fi
[[ "$arm64" != "[]" ]] || { echo "[]"; exit 0; }
lock_on 8 "$projects/$project/arm64-build.lock" registry:arm64-build 3600
mkdir -p "$storage/arm64"
api="http://127.0.0.1:$port/v2"
state="$storage/arm64.json"

# upload <repo> <file> <digest> — a blob into <repo>, unless zot holds it there already.
upload() {
  local location
  curl -fsI -o /dev/null "$api/$1/blobs/$3" && return 0
  location="$(curl -fsS -D - -o /dev/null -X POST "$api/$1/blobs/uploads/" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
  [[ "$location" == http* ]] || location="http://127.0.0.1:$port$location"
  [[ "$location" == *\?* ]] && location+="&" || location+="?"
  curl -fsS -o /dev/null -X PUT -H 'Content-Type: application/octet-stream' --data-binary "@$2" "${location}digest=$3"
}
# copy <from-repo> <to-repo> <digest> <dir> — a blob zot holds in one repository into another: mounted, else fetched and uploaded.
copy() {
  curl -fsI -o /dev/null "$api/$2/blobs/$3" && return 0
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$api/$2/blobs/uploads/?mount=$3&from=$1")" == 201 ]] && return 0
  curl -fsS -o "$4/blob" "$api/$1/blobs/$3"
  upload "$2" "$4/blob" "$3"
}
# put <repo> <file> <reference> — a manifest, as its own mediaType.
put() {
  curl -fsS -o /dev/null -X PUT -H "Content-Type: $(jq -r '.mediaType // "application/vnd.oci.image.manifest.v1+json"' "$2")" --data-binary "@$2" "$api/$1/manifests/$3"
}
digest_of() { echo "sha256:$(shasum -a 256 "$1" | cut -d' ' -f1)"; }
# platform <config file> — an image config's platform, for an index entry.
platform() { jq -c '{ architecture, os } + (if .variant then { variant } else {} end)' "$1"; }

# build_one <declaration> <work dir> — one image, in a subshell of its own; its
# output is the image's log. Says why it failed in <work>/error; its result in
# <work>/result ("present <digest>", "upstream", "built <digest> <index> <amd64>").
build_one() {
  set -euo pipefail
  local d="$1" work="$2" image path tag cache local_repo local_tag top m amd64 arm64_manifest arm64_config index blob present
  die() { echo "$*" > "$work/error"; echo "registry:arm64-build: $*" >&2; exit 1; }
  image="$(jq -r .image <<<"$d")" path="$(jq -r .path <<<"$d")" tag="$(jq -r .tag <<<"$d")"
  cache="$path" local_repo="$local_namespace/$path"
  echo "== $image:$tag ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

  if present="$(arm64_present "$path" "$tag")"; then
    echo "present $(jq -r --arg tag "$tag" '.manifests[] | select(.platform.architecture == "arm64") | .digest' <<<"${present#*$'\n'}")" > "$work/result"
    echo "$local_repo:$tag has an arm64 image already; nothing built"
    return 0
  fi

  # The upstream image, through zot's cache (which fetches it with the Mac's login).
  curl -fsS -H "Accept: $arm64_accept" -o "$work/upstream.json" "$api/$cache/manifests/$tag" \
    || die "could not fetch $image:$tag through $project's registry — is it up (registry:up $project), and the Mac logged in to $upstream?"
  jq -e .mediaType "$work/upstream.json" >/dev/null 2>&1 || die "$project's registry answered no manifest for $image:$tag"
  m="$(jq -r .mediaType "$work/upstream.json")"
  if [[ "$m" == *index* || "$m" == *list* ]]; then
    if jq -e 'any(.manifests[]; .platform.architecture == "arm64" and .platform.os == "linux")' "$work/upstream.json" >/dev/null; then
      echo upstream > "$work/result"
      echo "$image:$tag is multi-arch upstream, with linux/arm64; nothing to build"
      return 0
    fi
    amd64="$(jq -r 'first(.manifests[] | select(.platform.architecture == "amd64" and .platform.os == "linux") | .digest) // empty' "$work/upstream.json")"
    [[ -n "$amd64" ]] || die "$image:$tag upstream is an index with no linux/amd64 image to pair an arm64 one with"
    curl -fsS -H "Accept: $arm64_accept" -o "$work/amd64.json" "$api/$cache/manifests/$amd64" || die "could not fetch $image:$tag's amd64 image ($amd64) through $project's registry"
  else
    cp "$work/upstream.json" "$work/amd64.json"
  fi
  amd64="$(digest_of "$work/amd64.json")"
  curl -fsS -o "$work/amd64-config.json" "$api/$cache/blobs/$(jq -r .config.digest "$work/amd64.json")" || die "could not fetch $image:$tag's config through $project's registry"
  [[ "$(jq -r .architecture "$work/amd64-config.json")" == amd64 ]] || die "$image:$tag upstream is $(jq -r .architecture "$work/amd64-config.json"), not amd64"

  # The arm64 build.
  local_tag="harness-arm64.local/$path:$tag"
  local args=() context dockerfile
  if jq -e 'has("build")' <<<"$d" >/dev/null; then
    mkdir -p "$work/src"
    git -C "$work/src" init -q
    git -C "$work/src" fetch -q --depth 1 "$(jq -r .build.url <<<"$d")" "$(jq -r .build.ref <<<"$d")" \
      || die "could not fetch $(jq -r '"\(.build.url) at \(.build.ref)"' <<<"$d")"
    git -C "$work/src" -c advice.detachedHead=false checkout -q FETCH_HEAD
    context="$work/src/$(jq -r .build.context <<<"$d")"
    dockerfile="$context/$(jq -r .build.dockerfile <<<"$d")"
    [[ -f "$dockerfile" ]] || die "no $(jq -r '"\(.build.context)/\(.build.dockerfile)"' <<<"$d") in $(jq -r '"\(.build.url) at \(.build.ref)"' <<<"$d")"
    while IFS= read -r arg; do args+=(--build-arg "$arg"); done < <(jq -r '.build.args | to_entries[] | "\(.key)=\(.value)"' <<<"$d")
  else
    context="$work/swap" dockerfile="$work/swap/Dockerfile"
    mkdir -p "$context"
    jq -r --arg pinned "$image:$tag" '"FROM --platform=linux/amd64 \($pinned) AS upstream", "FROM \(.["base-swap"].base)",
      (.["base-swap"].copy[] | "COPY --from=upstream \(.) \(.)")' <<<"$d" > "$dockerfile"
  fi
  echo "-- docker buildx build for linux/arm64"
  docker buildx build --platform linux/arm64 --provenance=false --sbom=false --load -t "$local_tag" -f "$dockerfile" ${args[@]+"${args[@]}"} "$context" \
    || die "the linux/arm64 build failed"
  mkdir -p "$work/layout"
  docker save "$local_tag" | tar -x -C "$work/layout" || die "could not save the arm64 build ($local_tag) from Docker"
  docker image rm "$local_tag" >/dev/null 2>&1 || true

  # The arm64 image in the saved layout: its top entry, or an index's linux/arm64 one.
  layout_blob() { echo "$work/layout/blobs/sha256/${1#sha256:}"; }
  top="$(jq -r '.manifests[0].digest' "$work/layout/index.json")"
  while jq -e '.manifests' "$(layout_blob "$top")" >/dev/null 2>&1; do
    top="$(jq -r 'first(.manifests[] | select(.platform.architecture == "arm64" or (.platform == null and .annotations["vnd.docker.reference.type"] == null)) | .digest) // empty' "$(layout_blob "$top")")"
    [[ -n "$top" ]] || die "the saved build holds no linux/arm64 image"
  done
  arm64_manifest="$(layout_blob "$top")"
  [[ -f "$arm64_manifest" ]] || die "the saved build holds no manifest $top"
  arm64_config="$(layout_blob "$(jq -r .config.digest "$arm64_manifest")")"
  [[ "$(jq -r .architecture "$arm64_config")" == arm64 ]] || die "the build made a $(jq -r .architecture "$arm64_config") image, not arm64"

  # Into zot: the children, then the index under the tag.
  echo "-- push to $local_repo:$tag"
  for blob in $(jq -r '.config.digest, .layers[].digest' "$arm64_manifest"); do
    upload "$local_repo" "$(layout_blob "$blob")" "$blob" || die "could not push the arm64 blob $blob to $project's registry"
  done
  put "$local_repo" "$arm64_manifest" "$top" || die "could not push the arm64 manifest to $project's registry"
  for blob in $(jq -r '.config.digest, .layers[].digest' "$work/amd64.json"); do
    copy "$cache" "$local_repo" "$blob" "$work" || die "could not copy the amd64 blob $blob into $local_repo"
  done
  put "$local_repo" "$work/amd64.json" "$amd64" || die "could not push the amd64 manifest to $local_repo"
  jq -cnj --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg pinned "$image:$tag" \
    --arg amt "$(jq -r '.mediaType // "application/vnd.oci.image.manifest.v1+json"' "$work/amd64.json")" --arg amd "$amd64" --argjson ams "$(wc -c < "$work/amd64.json" | tr -d ' ')" --argjson ap "$(platform "$work/amd64-config.json")" \
    --arg rmt "$(jq -r '.mediaType // "application/vnd.oci.image.manifest.v1+json"' "$arm64_manifest")" --arg rd "$top" --argjson rs "$(wc -c < "$arm64_manifest" | tr -d ' ')" --argjson rp "$(platform "$arm64_config")" '
    { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{ mediaType: $amt, digest: $amd, size: $ams, platform: $ap }, { mediaType: $rmt, digest: $rd, size: $rs, platform: $rp }],
      annotations: { "org.opencontainers.image.created": $at,
        "org.opencontainers.image.description": "\($pinned): the upstream linux/amd64 image, and a linux/arm64 build of it by the harness (registry:arm64-build)" } }' > "$work/index.json"
  index="$(digest_of "$work/index.json")"
  put "$local_repo" "$work/index.json" "$tag" || die "could not push the multi-arch index to $local_repo:$tag"
  echo "built $top $index $amd64 $(jq -r '.annotations["org.opencontainers.image.created"]' "$work/index.json")" > "$work/result"
  echo "$local_repo:$tag is $index: amd64 $amd64, arm64 $top"
}

results=() failed=0
while IFS= read -r d; do
  image="$(jq -r .image <<<"$d")" tag="$(jq -r .tag <<<"$d")" path="$(jq -r .path <<<"$d")"
  log="$storage/arm64/${path//\//_}.log"
  work="$(mktemp -d "$storage/arm64/build.XXXXXX")"
  set +e
  ( build_one "$d" "$work" ) > "$log" 2>&1 8>&-
  code=$?
  set -e
  result="$(cat "$work/result" 2>/dev/null || true)"
  if [[ $code -ne 0 || -z "$result" ]]; then
    failed=1
    error="$(cat "$work/error" 2>/dev/null || echo "failed (exit $code)")"
    { echo "registry:arm64-build: $image:$tag: $error — VMs pull it as amd64 (emulated) until it builds; build log $log:"; tail -n 20 "$log" | sed 's/^/  /'; } >&2
    results+=("$(jq -nc --arg i "$image" --arg t "$tag" --arg l "$log" --arg e "$error" '{ image: $i, tag: $t, result: "failed", digest: null, log: $l, error: $e }')")
  else
    read -r kind digest index amd64 at <<<"$result"
    if [[ "$kind" == built ]]; then
      update_json --create "$state" --arg i "$image" --arg t "$tag" --arg d "$digest" --arg x "$index" --arg a "$amd64" --arg at "$at" \
        '.[$i] = { tag: $t, digest: $d, index: $x, amd64: $a, "built-at": $at }'
    fi
    results+=("$(jq -nc --arg i "$image" --arg t "$tag" --arg r "$kind" --arg d "${digest:-}" --arg l "$log" \
      '{ image: $i, tag: $t, result: $r, digest: (if $d == "" then null else $d end), log: $l, error: null }')")
  fi
  rm -rf "$work"
done < <(jq -c '.[]' <<<"$arm64")

printf '%s\n' "${results[@]}" | jq -s .
exit $failed
