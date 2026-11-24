#!/usr/bin/env bash
# Description: Build a project's Substrate sandbox image — the golden definition plus its declared services copied out of their pinned images, with the command server — on the Mac, and keep it in the project's registry pinned by digest — substrate:build-image <project> [--arch amd64|arm64]; prints JSON.
set -euo pipefail

# ASS-534. sandbox-image.bash says what the image's definition and inputs are and
# where it is kept; src/substrate/dockerfile.js what the image holds and why.
# For each architecture — the one given, else every one the project's
# services.yaml declares (arm64, the Mac's, for a project with none):
#  - nothing is built when the image's label has the inputs' hash now
#    (built: false), as vm:build-golden does with a current golden image;
#  - each service whose image is under the project's registry upstream
#    (Artifact Registry, say) is fetched through the project's zot — its cache
#    of the upstream, logged in with the Mac's gcloud by zot itself — at its
#    pinned digest, for that architecture, into an OCI layout handed to the
#    build as the stage svc-<name> (docker buildx --build-context … =
#    oci-layout://…). The Mac's Docker never logs in anywhere, and the files
#    are those of the very image the project's compose pins. A service image
#    with no build for the architecture fails the build, naming it (an
#    amd64-only image is built for amd64 only). Any other service image is a
#    FROM of its pinned digest, which the Mac's Docker pulls;
#  - the image is built on the Mac by its Docker (docker buildx, linux/<arch>:
#    amd64 under Docker Desktop's emulation on Apple Silicon — the ASS-532
#    spike took about 5 minutes), its repositories cloned in the build with
#    the Mac's gh and glab logins' tokens, a BuildKit secret of that one step
#    (forge_tokens, as vm:build-golden reads them; none for a repository that
#    is not https), written out as an OCI layout and pushed to the project's
#    zot as 0local/sandbox/<project>:<arch>-<hash's first 12> over its HTTP
#    API (registry.bash registry_push_layout) — never to a cloud registry;
#  - the label records its digest: the image is pinned by it.
# The build's output goes to data/projects/<project>/sandbox-image-build-<arch>.log
# and its run to sandbox-image-<arch>-build.json (substrate:image-status reads
# both). One build of a project's images at a time: a second fails at once.
# While the disk hold is on (disk.bash disk_held: the disk nearly full) none
# starts, as no golden build does.
# The zot must answer (registry:up) and the Mac's Docker run. Prints a JSON
# array, an architecture a line:
#   { project, image, arch, built, digest, ref, hash, seconds }
# and exits 1 at the first architecture whose build fails, saying why and
# where its log is.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox-image.bash"
source "$here/../json-file.bash"
source "$here/../vm-credentials.bash"   # forge_tokens
source "$here/../disk.bash"

usage() { echo "usage: substrate:build-image <project> [--arch amd64|arm64]" >&2; exit 1; }
[[ $# -eq 1 || ( $# -eq 3 && "$2" == --arch ) ]] || usage
project="$1" only="${3-}"
[[ -z "$only" || "$only" == amd64 || "$only" == arm64 ]] || usage
if disk_held; then
  echo "substrate:build-image: Disk nearly full — work held ($(gib "$(jq '.["free-bytes"]' "$disk_space_file")") GiB free): no image build starts until the free space is back above disk-free-warn-gb" >&2
  exit 1
fi
sandbox_definition substrate:build-image "$project"
registry_config substrate:build-image "$project"
if [[ -n "$only" ]]; then
  [[ "$declared" != true || " $architectures " == *" $only "* ]] \
    || { echo "substrate:build-image: $project's sandbox/services.yaml builds for $architectures only (architectures), not $only" >&2; exit 1; }
  archs="$only"
else
  archs="${architectures:-arm64}"
fi
lock_on 4 "$projects/$project/sandbox-image-build.lock" substrate:build-image 1 2>/dev/null \
  || { echo "substrate:build-image: $project's sandbox image is being built already ($projects/$project/sandbox-image-build.lock is held); not starting another" >&2; exit 1; }
curl -fs -o /dev/null "http://127.0.0.1:$port/v2/" \
  || { echo "substrate:build-image: $project's registry is not answering on 127.0.0.1:$port, and the image goes there — start it (registry:up $project) and run again" >&2; exit 1; }
repository="$(sandbox_repository "$project")"
mkdir -p "$storage/substrate"
work=""
trap '[[ -z "$work" ]] || rm -rf "$work"' EXIT

# sandbox_npm_config <command> <project> — ASS-542: a npm/pnpm user config naming the project's GitLab npm registries
# (vm-credentials.json gitlab's npm-registries: scope → project id) with its token from the keychain, as
# vm:credentials writes a VM's /run/harness/npmrc; for the build's `npm` secret only (never written to a file).
sandbox_npm_config() {
  local decl host scope id lines=()
  decl="$(declared_credentials "$1" "$2")" || return 1
  decl="$(jq -c '{ gitlab } | with_entries(select(.value != null))' <<<"$decl")"
  jq -e '.gitlab["npm-registries"] | objects | length > 0' <<<"$decl" >/dev/null || { echo "$1: $2 declares no gitlab npm-registries in vm-credentials.json" >&2; return 1; }
  read_tokens "$1" "$2" "$decl" || return 1
  host="$(jq -r '.gitlab.host // "gitlab.com"' <<<"$decl")"
  while IFS=$'\t' read -r scope id; do
    [[ "$scope" =~ ^@[a-z0-9._-]+$ && "$id" =~ ^[0-9]+$ ]] || { echo "$1: invalid gitlab npm registry '$scope': '$id'" >&2; return 1; }
    lines+=("$scope:registry=https://$host/api/v4/projects/$id/packages/npm/" "//$host/api/v4/projects/$id/packages/npm/:_authToken=${TOKENS[gitlab]}")
  done < <(jq -r '.gitlab["npm-registries"] | to_entries[] | [.key, (.value | tostring)] | @tsv' <<<"$decl")
  printf '%s\n' "${lines[@]}"
}

# build <arch> — one architecture's image; sets $result its result line. Run in this shell (no subshell), so a
# failure's exit ends the command and the EXIT trap removes its work folder.
build() {
  local arch="$1" h inputs label run log started ctx layouts out name image path svc digest contexts=() seconds tag top size https=()
  h="$(sandbox_hash "$arch")" inputs="$(sandbox_inputs "$arch")" label="$(sandbox_label "$project" "$arch")"
  if [[ -f "$label" && "$(jq -r .hash "$label")" == "$h" ]]; then
    result="$(jq -c '{ project, image, arch, built: false, digest, ref, hash, seconds: 0 }' "$label")"
    return 0
  fi
  run="$projects/$project/sandbox-image-$arch-build.json" log="$projects/$project/sandbox-image-build-$arch.log" started=$SECONDS
  jq -n --arg h "$h" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ hash: $h, "started-at": $at, "ended-at": null, "exit-code": null }' | replace_file "$run"
  : > "$log"
  # failed <why> — the run recorded as failed, the reason said; exits 1.
  failed() {
    jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + { "ended-at": $at, "exit-code": 1 }' "$run" | replace_file "$run"
    echo "substrate:build-image: sandbox-$project ($arch): $1 — see $log" >&2
    exit 1
  }
  work="$(mktemp -d "$storage/substrate/build.XXXXXX")"
  ctx="$work/context" layouts="$work/images" out="$work/image"
  mkdir -p "$ctx/harness" "$ctx/files" "$out"
  cp "$shared/git.sh" "$shared/repositories.sh" "$ctx/harness/"
  cp "$provision_file" "$ctx/harness/provision.sh"
  cp -R "$substrate_src/image/command-server" "$ctx/harness/command-server"
  cp "$substrate_src/image/sandbox-services" "$substrate_src/image/sandbox-rootfs-exec" "$substrate_src/image/sandbox-login" "$substrate_src/image/sandbox-docker" "$ctx/harness/"
  if [[ "$declared" == true ]]; then
    jq . <<<"$declaration" | replace_file "$ctx/harness/services.json"
    while IFS= read -r name; do
      mkdir -p "$ctx/files/$(dirname "$name")"; cp "$sandbox_folder/$name" "$ctx/files/$name"
    done < <(jq -r '.files[].from' <<<"$declaration")
  else
    echo '{"architectures":[],"services":[]}' | replace_file "$ctx/harness/services.json"
  fi
  # Each service's pinned image: through zot when it is the upstream's.
  local given="{}"
  while IFS=$'\t' read -r svc image digest; do
    [[ -n "$svc" ]] || continue
    path="${image#*/}" name="${path%:*}"
    if [[ -n "$upstream" && "${image%%/*}" == "$upstream" ]]; then
      echo "== fetching $image@$digest (linux/$arch) through the registry for $svc" >> "$log"
      top="$(registry_fetch_layout "$name" "$digest" "$arch" "$layouts" 2>>"$log")" \
        || failed "services ($svc): its image $image@$digest could not be fetched for linux/$arch: $(tail -1 "$log")"
      contexts+=(--build-context "svc-$svc=oci-layout://$layouts@$top")
      given="$(jq -c --arg s "$svc" '.[$s] = true' <<<"$given")"
    fi
  done < <(jq -r '(.services // [])[] | select(.image != null) | [.name, .image, .digest] | @tsv' <<<"$declaration")
  node "$substrate_src/services-cli.js" dockerfile "$sandbox_folder" "$arch" \
    "$(jq -nc --arg p "$project" --arg h "$h" --argjson c "$given" '{ project: $p, hash: $h, contexts: $c, repositories: $ARGS.positional }' --args ${repos[@]+"${repos[@]}"})" \
    2>>"$log" | replace_file "$ctx/Dockerfile" || failed "its Dockerfile could not be written"
  for path in ${repos[@]+"${repos[@]}"}; do [[ "$path" != https://* ]] || https+=("$path"); done
  gh_token="" gl_token=""
  [[ ${#https[@]} -eq 0 ]] || forge_tokens substrate:build-image "${https[@]}" || failed "the forge logins its repositories are cloned with failed (above)"
  # ASS-542: a prepare step with npm: true gets the project's GitLab npm registries as a user config (BuildKit secret).
  local npm_config="" secrets=(--secret id=forge,env=HARNESS_FORGE_TOKENS)
  if jq -e '(.prepare // []) | any(.npm)' <<<"$declaration" >/dev/null; then
    npm_config="$(sandbox_npm_config substrate:build-image "$project")" || failed "its prepare steps need the project's GitLab npm registries (vm-credentials.json gitlab: keychain-service and npm-registries)"
    secrets+=(--secret id=npm,env=HARNESS_NPM_CONFIG)
  fi
  echo "== docker buildx build --platform linux/$arch (inputs ${h:0:12})" >> "$log"
  HARNESS_NPM_CONFIG="$npm_config" HARNESS_FORGE_TOKENS="$gh_token"$'\n'"$gl_token" docker buildx build --platform "linux/$arch" --provenance=false --sbom=false --progress=plain \
    "${secrets[@]}" ${contexts[@]+"${contexts[@]}"} -f "$ctx/Dockerfile" \
    --output "type=oci,dest=$work/image.tar" "$ctx" >> "$log" 2>&1 < /dev/null \
    || failed "the build failed: $(grep -E 'ERROR|error:' "$log" | tail -1)"
  tar -x -C "$out" -f "$work/image.tar"
  tag="$arch-${h:0:12}"
  echo "== pushing to 127.0.0.1:$port/$repository:$tag" >> "$log"
  top="$(registry_push_layout "$out" "$repository" "$tag" 2>>"$log")" || failed "the image could not be pushed to the registry on 127.0.0.1:$port"
  size="$(jq '[.config.size, .layers[].size] | add' "$out/blobs/sha256/${top#sha256:}")"
  seconds=$((SECONDS - started))
  jq -n --arg p "$project" --arg a "$arch" --arg h "$h" --arg in "$inputs" --arg d "$top" --arg r "$repository" --arg t "$tag" \
    --arg ref "127.0.0.1:$port/$repository@$top" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson s "$seconds" --argjson b "$size" \
    '{ project: $p, image: "sandbox-\($p)", arch: $a, hash: $h, inputs: ($in | rtrimstr("\n") | split("\n")), digest: $d,
       repository: $r, tag: $t, ref: $ref, "built-at": $at, "build-seconds": $s, "size-bytes": $b }' | replace_file "$label"
  jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + { "ended-at": $at, "exit-code": 0 }' "$run" | replace_file "$run"
  echo "built sandbox-$project ($arch) in $((seconds / 60))m $((seconds % 60))s: $repository@$top" >> "$log"
  rm -rf "$work"; work=""
  result="$(jq -c '{ project, image, arch, built: true, digest, ref, hash, seconds: ."build-seconds" }' "$label")"
}

results=()
for arch in $archs; do build "$arch"; results+=("$result"); done
printf '%s\n' "${results[@]}" | jq -s .
