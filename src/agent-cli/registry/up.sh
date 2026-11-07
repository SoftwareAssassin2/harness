#!/usr/bin/env bash
# Description: Bring a project's image registry up on the Mac — registry:up <project>; idempotent, and what control runs whenever it stops answering.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/registry.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# One zot per project, from the project's "registry" in project.json (see
# registry.bash). In order, each step only when something is missing or changed:
#  1. registry:refresh-credentials — fails here, before anything is installed,
#     when the Mac's gcloud is not logged in; does nothing for a project with
#     no upstream (registry.bash).
#  2. The pinned zot binary, downloaded once (see registry.bash) and checked against
#     its sha256.
#  3. <storage>/config.json: plain HTTP on 127.0.0.1:<port> (VMs reach it as
#     host.lima.internal:<port>, Lima's address for the Mac's loopback), storage
#     in <storage>/images, and an on-demand sync of the project's upstream
#     (e.g. Artifact Registry; none, so no sync, without one). A tag is
#     checked upstream at most hourly (manifestCheckInterval), so a second pull
#     is served from the cache; by digest it never is. When upstream refuses
#     (the Mac's login expired) zot serves what it holds, and answers 503
#     only for what it does not — including a multi-arch index none of whose
#     platform images it holds, which its hourly GC drops (on-demand sync
#     stores an index alone). compat docker2s2 lets
#     zot hold Docker-format (not only OCI) manifests, which Artifact
#     Registry's Docker Hub mirrors serve (ASS-72). Nothing is deleted by zot
#     but blobs no image uses (registry:sweep picks what goes).
#  4. zot itself, started when nothing answers on the port: in its own session,
#     so it outlives the control (or shell) that ran this — the dashboard kills
#     control's process group — its pid in $zot_pid_file, its output in
#     <storage>/zot.out. The zot this command started (that pid, still running
#     the pinned binary) is restarted when its config changed or it stopped
#     answering (hung); one it did not start — run from a shell, say — is left be.
#     Not launchd: macOS keeps launchd jobs out of /Volumes/... without Full
#     Disk Access; control keeps zot running instead (src/control/registry.js).
# Then waits for zot to answer and prints { project, url, vm-url, storage,
# changed }. Run again with nothing changed, it changes nothing.
# One at a time per project (ASS-179): the project's registry-up.lock is held
# to the end, so a second waits, then finds zot answering — never a second
# zot started, nor one still starting taken for hung. Waits for it up to 300 seconds.
[[ $# -eq 1 ]] || { echo "usage: registry:up <project>" >&2; exit 1; }
registry_config registry:up "$1"
lock_on 6 "$projects/$1/registry-up.lock" registry:up 300
"$agent" registry:refresh-credentials "$1" >/dev/null

changed=false
if [[ ! -x "$zot_bin" ]]; then
  mkdir -p "$(dirname "$zot_bin")"
  curl -fsSL -o "$zot_bin.$$" "$zot_url" || { rm -f "$zot_bin.$$"; echo "registry:up: could not download zot $zot_version from $zot_url" >&2; exit 1; }
  [[ "$(shasum -a 256 "$zot_bin.$$" | cut -d' ' -f1)" == "$zot_sha256" ]] \
    || { rm -f "$zot_bin.$$"; echo "registry:up: the zot $zot_version download does not match its pinned sha256 checksum; nothing installed" >&2; exit 1; }
  chmod 755 "$zot_bin.$$" && mv -f "$zot_bin.$$" "$zot_bin"
  changed=true
fi

# write_if_changed <file> — stdin becomes the file unless it already holds it;
# succeeds only when it wrote.
write_if_changed() {
  local new; new="$(cat)"
  [[ -f "$1" && "$(cat "$1")" == "$new" ]] && return 1
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$new" > "$1.$$" && mv -f "$1.$$" "$1"
}

mkdir -p "$storage/images"
restart=false
jq -n --arg storage "$storage" --arg port "$port" --arg upstream "$upstream_url" '{
  distSpecVersion: "1.1.1",
  storage: { rootDirectory: "\($storage)/images", gc: true, dedupe: true,
    retention: { policies: [{ repositories: ["**"], deleteReferrers: false, deleteUntagged: false }] } },
  http: { address: "127.0.0.1", port: $port, compat: ["docker2s2"] },
  log: { level: "info", output: "\($storage)/zot.log" },
  extensions: { search: { enable: true } } }
  | if $upstream == "" then . else .extensions.sync = { enable: true, credentialsFile: "\($storage)/credentials.json",
      registries: [{ urls: [$upstream], onDemand: true, tlsVerify: true, manifestCheckInterval: "1h", content: [{ prefix: "[a-z]*/**" }] }] } end' \
  | write_if_changed "$storage/config.json" && restart=true

answering() { curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/v2/"; }
# The zot this command started, while its pid still runs the pinned binary (a
# reused pid is never signalled); stopped — TERM, KILL after 10 seconds — when
# it must restart.
pid="$(cat "$zot_pid_file" 2>/dev/null || true)"
[[ "$pid" =~ ^[0-9]+$ && "$(ps -p "$pid" -o command= 2>/dev/null)" == *"$zot_bin serve "* ]] || pid=""
if [[ -n "$pid" ]] && { [[ "$restart" == true ]] || ! answering; }; then
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
  pid=""
fi
if [[ -z "$pid" ]] && ! answering; then
  # setsid through perl (macOS has no setsid command); TZ=UTC makes zot's log
  # times UTC, which registry:sweep reads.
  (cd / && TZ=UTC exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "zot: $!\n"' "$zot_bin" serve "$storage/config.json" </dev/null >>"$storage/zot.out" 2>&1 6>&-) &
  echo $! > "$zot_pid_file"
  changed=true
elif [[ -z "$pid" && "$restart" == true ]]; then
  echo "registry:up: a zot registry:up did not start answers on 127.0.0.1:$port, so it keeps its old config; stop it, then run registry:up $1 again" >&2
fi

for _ in $(seq 60); do
  answering && break
  sleep 0.5
done
answering || { echo "registry:up: zot did not answer on 127.0.0.1:$port — see $storage/zot.out and $storage/zot.log" >&2; exit 1; }

jq -n --arg p "$1" --arg port "$port" --arg storage "$storage" --argjson changed "$changed" \
  '{ project: $p, url: "http://127.0.0.1:\($port)", "vm-url": "http://host.lima.internal:\($port)", storage: $storage, changed: $changed }'
