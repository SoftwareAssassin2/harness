#!/bin/bash
# Golden image step (vm:build-golden), shared by every project: pulls each
# image on stdin (one per line, from images.txt) through the project's zot,
# with no login. zot answers a first pull only once it has fetched the whole
# image upstream; Docker gives up after 30 s, while the fetch goes on (the
# 12 GB dev container takes minutes, ASS-70). So each pull is retried every
# 30 s for up to 20 minutes before the build fails. An image with no arm64
# build is pulled as amd64, which the VM runs under Rosetta (some projects have several).
set -euo pipefail
while IFS= read -r image; do
  [[ -n "$image" ]] || continue
  platform=()
  for try in $(seq 40); do
    out="$(docker pull -q "${platform[@]}" "$image" 2>&1 </dev/null)" && { echo "$out"; break; }
    echo "$out" >&2
    if [[ ${#platform[@]} -eq 0 && "$out" == *"no matching manifest for linux/arm64"* ]]; then platform=(--platform linux/amd64); continue; fi
    [[ $try -lt 40 ]] || { echo "images: could not pull $image through the registry" >&2; exit 1; }
    echo "images: pull $try of $image failed (zot may still be fetching it); retrying in 30 s" >&2
    sleep 30
  done
done
