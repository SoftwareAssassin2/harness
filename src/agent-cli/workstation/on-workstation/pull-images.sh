#!/bin/bash
# A project's images pulled on a GCP workstation (ASS-472), run there over its
# connection by workstation-variation.bash (wsv_pull_images) at a step's
# claim, once per boot of the workstation:
#
#   bash -s -- <upstream-host> <zot-port> <local-namespace> <image>…   < pull-images.sh
#
# Each <image> is a line of the golden image's images.txt under the project's
# Artifact Registry host (<upstream-host>/<path>[:<tag>][@sha256:<digest>]).
# In turn, each is pulled:
#  1. From zot, when it is by tag alone and zot holds a local rebuild of it
#     (<local-namespace>/<path>:<tag>, registry:push's): it wins over Artifact
#     Registry's, whatever that has under the tag, as a VM's hosts.toml makes
#     it win there (AC2) — pulled from 127.0.0.1:<zot-port> (the connection's
#     forward to the Mac's zot) and tagged as named; on to 2 when that fails.
#  2. Else straight from Artifact Registry under its own name (AC1): in the
#     workstation's own region, so minutes for a first pull where zot over the
#     Mac's tunnel took an hour. Authenticated as the workstation's service
#     account, its token from the metadata server, asked before every pull (a
#     token lives about an hour; a first pull of every image can outlast one)
#     and written to a Docker config of this run's alone (DOCKER_CONFIG, 0700,
#     removed at the end): the owner's ~/.docker/config.json — on the test
#     workstation a gcloud credential helper on the operator's own login,
#     which lapses with Workspace session control, found 2026-11-16 — is never
#     used or touched, and no token ever comes from the Mac.
#  3. Only when that fails: through zot as before ASS-472 (127.0.0.1:<zot-port>
#     /<path>:<tag>, or @<digest> for a pinned one: zot syncs it from Artifact
#     Registry with the Mac's login), tagged as named when it has a tag (a
#     tag-less pinned image keeps zot's name) — so a tag Artifact Registry
#     lacks but zot has still arrives — why the registry failed said.
# docker pull's own check keeps an image already there at the same digest
# from being downloaded again (said "up to date").
#
# ASS-473 AC1: each source's pull is tried 3 times, waiting
# HARNESS_WS_PULL_RETRY_SECONDS (5) and then twice that between tries,
# before the image goes on to the next source (or counts as failed): a
# dropped connection part way ("httpReadSeeker: failed open: failed to do
# request", a ticket's placement on 2026-11-15) is no longer the end of
# it. A source that says it has no such image (manifest unknown, not found)
# is not asked again: another try would only say the same. Each try that
# fails and is tried again is logged. A pull that fails every way leaves the
# workstation the image it has, and says whether it has one (AC2): `kept`
# when the image is there (by its name, at an older version, or at its
# pinned digest — a warning, as on a VM), `missing` when it is not, which
# fails the step's claim (wsv_pull_images).
#
# Output: per image, one line on stderr for the log and one result line on
# stdout,
#   !pull <TAB> <image> <TAB> registry|zot|failed <TAB> <seconds> <TAB> downloaded|up-to-date|kept|missing <TAB> <why>
# <why> empty for a pull from the registry, else why zot (or nothing) was
# used. Exit 0 whatever the pulls did; 1 only on bad arguments.
#
# Tests stand a folder in for the workstation (test/support/fake-ssh.js):
# HARNESS_WS_METADATA_URL replaces the metadata server's
# (http://metadata.google.internal), HARNESS_WS_PULL_RETRY_SECONDS the wait
# between tries. A real ssh session carries neither.
set -uo pipefail
umask 077
[[ $# -ge 3 ]] || { echo "usage: pull-images.sh <upstream-host> <zot-port> <local-namespace> <image>…" >&2; exit 1; }
host="$1" zot="$2" ns="$3"; shift 3
export PATH="$HOME/harness/bin:$PATH"
metadata="${HARNESS_WS_METADATA_URL:-http://metadata.google.internal}"
accept='Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
config="$(mktemp -d)" || exit 1
trap 'rm -rf "$config"' EXIT

# one_line <text> — its last non-empty line, tabs made spaces: a why that fits a result line.
one_line() { printf '%s\n' "$1" | sed '/^[[:space:]]*$/d' | tail -n 1 | tr '\t' ' '; }

# sa_login — the workstation's service account's token, from the metadata server, in this run's Docker config for
# the registry host; fails, why in $why, when the metadata server gives none. The token never reaches the output.
sa_login() {
  local body token
  body="$(curl -fsS --max-time 10 -H 'Metadata-Flavor: Google' "$metadata/computeMetadata/v1/instance/service-accounts/default/token" 2>&1)" \
    || { why="no token from the metadata server for the workstation's service account: $(one_line "$body")"; return 1; }
  token="$(sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<< "$body")"
  [[ -n "$token" ]] || { why="the metadata server's answer held no token for the workstation's service account"; return 1; }
  printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$host" "$(printf 'oauth2accesstoken:%s' "$token" | base64 | tr -d '\n')" > "$config/config.json"
}

# pull <ref> [<docker-config>] — docker pull, $status (downloaded or up-to-date) set; fails, docker's last word in $why.
pull() {
  local out
  if out="$(DOCKER_CONFIG="${2:-${DOCKER_CONFIG:-$HOME/.docker}}" docker pull "$1" 2>&1)"; then
    if grep -q 'Image is up to date' <<< "$out"; then status=up-to-date; else status=downloaded; fi
    return 0
  fi
  why="$(one_line "$out")"; [[ -n "$why" ]] || why="docker pull failed"
  return 1
}

# tries <what> <command>… — the command (a source's pull: it sets $why when it fails) run up to 3 times (ASS-473
# AC1), waiting $retry seconds and then twice that between tries, each failure tried again logged; not again when
# the source says it has no such image. Fails, $why the last try's, when every try failed.
retry="${HARNESS_WS_PULL_RETRY_SECONDS:-5}"
tries() {
  local what="$1" try wait="$retry"; shift
  for try in 1 2 3; do
    "$@" && return 0
    [[ $try -lt 3 ]] || break
    if grep -qiE 'manifest unknown|not found|no such image' <<< "$why"; then return 1; fi
    echo "pull-images: $what failed (try $try of 3): $why; trying again in ${wait}s" >&2
    sleep "$wait"; wait=$(( wait * 2 ))
  done
  why="$why (3 tries)"
  return 1
}

# from_registry <image> — the service account's token asked for, then the pull from Artifact Registry with it.
from_registry() { sa_login && pull "$1" "$config"; }

# present <image> — the workstation's Docker has the image: by its name (any version, its digest left off when it
# has a tag), at its pinned digest, or under zot's name for a pinned one with no tag (from_zot keeps that name).
present() {
  local image="$1" rest="${1#"$host"/}" named
  named="${rest%%@*}"
  if [[ "${named##*/}" == *:* ]]; then docker image inspect "${image%@*}" >/dev/null 2>&1 && return 0; fi
  [[ "$rest" == *@* ]] || { docker image inspect "$image" >/dev/null 2>&1; return; }   # neither: docker's :latest
  docker image inspect "$image" >/dev/null 2>&1 \
    || { [[ -n "$zot" ]] && docker image inspect "127.0.0.1:$zot/${rest%%@*}@${rest#*@}" >/dev/null 2>&1; }
}

# from_zot <ref in zot> <image> — pulled through zot and, when <image> has a tag, tagged as it (its digest left off:
# docker tags no digest).
from_zot() {
  local named="${2%@*}"
  pull "$1" || return 1
  [[ "${named##*/}" != *:* ]] || docker tag "$1" "$named" >/dev/null 2>&1 || { why="pulled $1 but could not tag it $named"; return 1; }
}

# pull_one <image> — sets $source (registry, zot or failed), $status and $why; each source tried 3 times (tries).
pull_one() {
  local image="$1" rest path tag="" digest="" ref registry_why local_why=""
  source=failed status="" why=""
  rest="${image#"$host"/}"
  [[ "$rest" != *@* ]] || digest="${rest#*@}" rest="${rest%%@*}"
  if [[ "${rest##*/}" == *:* ]]; then path="${rest%:*}" tag="${rest##*:}"; else path="$rest"; fi
  if [[ -n "$zot" && -n "$tag" && -z "$digest" ]] \
    && curl -fsI -o /dev/null --max-time 10 -H "$accept" "http://127.0.0.1:$zot/v2/$ns/$path/manifests/$tag" 2>/dev/null; then
    ref="127.0.0.1:$zot/$ns/$path:$tag"
    if tries "pulling $image's local rebuild from zot" from_zot "$ref" "$image"; then source=zot why="a local rebuild (registry:push) in zot, which wins over Artifact Registry's"; return 0; fi
    local_why="its local rebuild in zot ($ref) could not be pulled: $why; "
  fi
  if tries "pulling $image from Artifact Registry" from_registry "$image"; then source=registry why="$local_why"; return 0; fi
  registry_why="$local_why""Artifact Registry: $why"
  [[ -n "$zot" ]] || { why="$registry_why; and the project has no zot to fall back on"; return 0; }
  if [[ -n "$digest" ]]; then ref="127.0.0.1:$zot/$path@$digest"; else ref="127.0.0.1:$zot/$path${tag:+:$tag}"; fi
  if tries "pulling $image through zot" from_zot "$ref" "$image"; then source=zot why="$registry_why"
  else why="$registry_why; zot ($ref): $why"; fi
}

for image in "$@"; do
  [[ "$image" == "$host"/?* ]] || { echo "pull-images: $image is not under $host; passed over" >&2; continue; }
  started=$SECONDS
  pull_one "$image"
  took=$(( SECONDS - started )) said="${status//-/ }"
  case "$source" in
    registry) echo "pulled $image from Artifact Registry in ${took}s ($said)" >&2 ;;
    zot) echo "pulled $image through zot in ${took}s ($said): $why" >&2 ;;
    *) if present "$image"; then status=kept; echo "could not pull $image (${took}s): $why; the workstation keeps the image it has" >&2
       else status=missing; echo "could not pull $image (${took}s): $why; the workstation has no such image" >&2; fi ;;
  esac
  printf '!pull\t%s\t%s\t%s\t%s\t%s\n' "$image" "$source" "$took" "$status" "$why"
done
exit 0
