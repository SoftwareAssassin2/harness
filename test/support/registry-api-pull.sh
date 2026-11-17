#!/bin/bash
# A real cloud VM's pull of one image through Artifact Registry's API (ASS-481
# AC7, cloud-vm-real.test.js), run there over its connection:
#
#   bash -s -- <scratch folder> <image>   < registry-api-pull.sh
#
# The VM's service account's token from the metadata server (ASS-472), the
# image's manifest (an index's linux/amd64 one), its config and layers
# downloaded into the scratch folder, each checked against its digest and
# removed. Prints "pulled <n> blobs <bytes> bytes"; never the token.
set -euo pipefail
dir="$1" host="${2%%/*}" rest="${2#*/}" digest=""
name="${rest%%@*}"; [[ "$rest" != *@* ]] || digest="${rest#*@}"
tag=latest; if [[ "${name##*/}" == *:* ]]; then tag="${name##*:}" name="${name%:*}"; fi
token="$(curl -fsS --max-time 10 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | jq -r .access_token)"
auth=(-H "Authorization: Bearer $token")
accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
get() { curl -fsSL --max-time 300 "${auth[@]}" -H "Accept: $accept" "https://$host/v2/$name/$1" -o "$2"; }
mkdir -p "$dir"
get "manifests/${digest:-$tag}" "$dir/manifest.json"
if jq -e '.manifests' "$dir/manifest.json" >/dev/null; then
  m="$(jq -r '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest' "$dir/manifest.json")"
  get "manifests/$m" "$dir/manifest.json"
fi
n=0 bytes=0
for d in $(jq -r '.config.digest, .layers[].digest' "$dir/manifest.json"); do
  get "blobs/$d" "$dir/blob"
  [[ "sha256:$(sha256sum "$dir/blob" | cut -d' ' -f1)" == "$d" ]] || { echo "blob $d does not match its digest" >&2; exit 1; }
  n=$((n + 1)) bytes=$((bytes + $(stat -c %s "$dir/blob"))); rm -f "$dir/blob"
done
rm -f "$dir/manifest.json"
echo "pulled $n blobs $bytes bytes"
