#!/usr/bin/env bash
# Description: Hold a project's registry under its max-size-gb, deleting the least recently pulled images first — registry:sweep <project>; control runs it every 30 minutes.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/registry.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# A soft cap: the images may pass max-size-gb (GB, 10^9 bytes) between sweeps,
# and a pull is never refused. When <storage>/images is over it, the images —
# every manifest in a repository's index.json, tagged or pulled by digest — are
# deleted through zot's API, the least recently pulled first, until the sizes
# they name bring it under; zot's garbage collection then frees the blobs no
# image uses. A deleted cached image is fetched again at its next pull.
# When an image was last pulled: zot records it but shows it only for tagged
# images, so the sweep reads zot's log — every manifest GET or HEAD that
# succeeded — into <storage>/last-pulls.json ({ "<repo>@<tag or digest>": epoch
# seconds }) and empties the log. An image never seen pulled counts from when
# it was cached. Prints { size-bytes, max-bytes, deleted: ["<repo>@<digest>"] }.
[[ $# -eq 1 ]] || { echo "usage: registry:sweep <project>" >&2; exit 1; }
registry_config registry:sweep "$1"
mkdir -p "$storage/images"

pulls="$storage/last-pulls.json" log="$storage/zot.log"
[[ -f "$pulls" ]] || update_json --create "$pulls" .
if [[ -s "$log" ]]; then
  # zot appends (O_APPEND), so emptying the log is safe; a line written between
  # the read and the truncate is lost, which only makes an image look older.
  jq -R 'fromjson? // empty
    | select(.message == "HTTP API" and (.method == "GET" or .method == "HEAD") and .statusCode == 200)
    | (.path | capture("^/v2/(?<repo>.+)/manifests/(?<ref>[^?]+)")) as $m
    | { key: "\($m.repo)@\($m.ref)", value: (.time | sub("\\.[0-9]+"; "") | fromdate) }' "$log" \
    | jq -s --slurpfile old "$pulls" 'reduce .[] as $p ($old[0]; .[$p.key] = ([.[$p.key] // 0, $p.value] | max))' > "$pulls.$$"
  mv -f "$pulls.$$" "$pulls"
  : > "$log"
fi

size=$(( $(du -sk "$storage/images" | cut -f1) * 1024 ))
max="$(jq -n --argjson gb "$max_gb" '$gb * 1000000000 | floor')"
deleted=()
if (( size > max )); then
  # Every image as "<last pull> <size it names> <repo> <digest>", oldest first.
  while IFS= read -r index; do
    repo="${index#"$storage/images/"}" repo="${repo%/index.json}"
    jq -r '.manifests[] | "\(.digest) \(.annotations["org.opencontainers.image.ref.name"] // "")"' "$index" \
      | while read -r digest tag; do
          blob="$storage/images/$repo/blobs/sha256/${digest#sha256:}"
          [[ -f "$blob" ]] || continue
          last="$(jq -r --arg d "$repo@$digest" --arg t "$repo@$tag" '[.[$d], .[$t]] | map(select(.)) | max // empty' "$pulls")"
          echo "${last:-$(date -r "$blob" +%s)} $(jq '[.config.size // 0, (.layers // [])[].size] | add' "$blob") $repo $digest"
        done
  done < <(find "$storage/images" -mindepth 2 -name index.json -not -path '*/.sync/*') \
    | sort -n > "$storage/sweep.$$"
  while read -r _ bytes repo digest; do
    (( size > max )) || break
    curl -fsS -o /dev/null -X DELETE "http://127.0.0.1:$port/v2/$repo/manifests/$digest"
    deleted+=("$repo@$digest")
    size=$(( size - bytes ))
  done < "$storage/sweep.$$"
  rm -f "$storage/sweep.$$"
fi

jq -n --argjson size "$(( $(du -sk "$storage/images" | cut -f1) * 1024 ))" --argjson max "$max" '{ "size-bytes": $size, "max-bytes": $max, deleted: $ARGS.positional }' --args ${deleted[@]+"${deleted[@]}"}
