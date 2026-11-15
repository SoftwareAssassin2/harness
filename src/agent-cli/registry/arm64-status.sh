#!/usr/bin/env bash
# Description: Report, per image a project declares in arm64-images, its pinned tag and whether its arm64 variant exists, when it was built and its digest — registry:arm64-status <project>; prints JSON.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/registry.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/arm64.bash"

# ASS-466 (arm64.bash, registry:arm64-build). Reads, never builds. Prints a
# JSON array, a declared image a line:
#   { image, tag, arm64, "built-at", digest, index, log }
# — tag the one images.txt pins now; arm64 true when the project's zot serves
# 0local/<path>:<tag> as an index with a linux/arm64 image it holds whole (a
# VM pulling <image>:<tag> runs it natively), false when not (it runs amd64,
# emulated), null when zot is not answering; digest the arm64 manifest's and
# index the index's, from zot; built-at when registry:arm64-build built it
# (<storage>/arm64.json, for this tag; null for a variant it did not record);
# log the image's last build log, null when none. Fails, naming each problem,
# when the declarations are invalid.
[[ $# -eq 1 ]] || { echo "usage: registry:arm64-status <project>" >&2; exit 1; }
registry_config registry:arm64-status "$1"
arm64_declarations registry:arm64-status "$1"
state="$storage/arm64.json"
up=true
curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/v2/" || up=false

while IFS= read -r d; do
  path="$(jq -r .path <<<"$d")" tag="$(jq -r .tag <<<"$d")" image="$(jq -r .image <<<"$d")"
  present="" arm64=false
  if [[ "$up" == false ]]; then arm64=null
  elif present="$(arm64_present "$path" "$tag")"; then arm64=true
  fi
  log="$storage/arm64/${path//\//_}.log"
  [[ -f "$log" ]] || log=""
  jq -nc --arg i "$image" --arg t "$tag" --argjson a "$arm64" --arg p "$present" --arg log "$log" --slurpfile s <(cat "$state" 2>/dev/null || true) '
    ($s[0][$i] // null | if . != null and .tag == $t then . else null end) as $built
    | (if $p == "" then null else ($p | split("\n")) end) as $p
    | { image: $i, tag: $t, arm64: $a, "built-at": ($built["built-at"] // null),
        digest: (if $p then ($p[1] | fromjson | first(.manifests[] | select(.platform.architecture == "arm64") | .digest)) else null end),
        index: (if $p then $p[0] else null end),
        log: (if $log == "" then null else $log end) }'
done < <(jq -c '.[]' <<<"$arm64") | jq -s .
