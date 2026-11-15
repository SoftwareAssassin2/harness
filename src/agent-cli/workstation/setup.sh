#!/usr/bin/env bash
# Description: Get a project's GCP workstation ready for the harness's agents over its open connection, installing under its home only what is missing — workstation:setup <project> <id> [--version]; prints its live data.
set -euo pipefail

# ASS-434: what the golden image is to a VM, for a workstation, which the
# harness reuses and never builds. Over the workstation's one connection
# (workstation:connect, ASS-433; none open fails at once), under its lock, it
# runs on-workstation/setup.sh there, which says what it installs and checks
# and where (AC1): everything under ~/harness — bin (agent.sh pointed at the
# forwarder on the workstation's loopback; jq and claude when they were
# missing), lib, tools, env (the harness's sessions' PATH and HARNESS_RUNTIME,
# never the owner's shell files: AC4), setup.json — and the runtime folder
# (/dev/shm/harness-<uid>, 0700, emptied at each workstation start), where
# ASS-435 puts the forwarder token and credentials beside agent-url. A tool
# that cannot be installed, Docker not usable, or a golden-image tool still
# missing fails it, each named (AC3). It is safe to run again: what is there
# is left alone.
#
# The setup's version (AC2): the sha256 of on-workstation/setup.sh,
# in-vm/agent.sh, the project's golden-image/workstation-tools.sh (when it
# has one), the forwarder's URL on the workstation and project.json's
# golden-image tools, one per line — the script and the tools list, with
# what the script installs. It is recorded on the workstation, in
# ~/harness/setup.json (with the boot id it ran under), and in the
# workstation's live data, workstations.json's `setup`:
#   { ok, version, checked-at (each run), set-up-at (the last that changed
#     anything), home, runtime, boot-id (ASS-435: the workstation's boot it
#     ran under — vm:start records it on the holder, so a restart since shows),
#     did: [what it changed], failed: [{ what, why }],
#     error: one line naming each failure | null }
# --version prints the version alone, asking the workstation nothing: control
# compares it with the live data's to rerun setup when it changes
# (src/control/workstations.js), as it reruns it after every connect, before
# anything is dispatched (workstation-connection.js workstationUsable: the
# setup ok and checked since the connection opened).
# Prints the workstation's entry; fails, naming what failed, when setup did.
# WORKSTATION_SETUP_TIMEOUT (900 seconds) ends a setup that has not finished.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation.bash"

command=workstation:setup
[[ $# -eq 2 || ( $# -eq 3 && "$3" == --version ) ]] || { echo "usage: $command <project> <id> [--version]" >&2; exit 1; }
project="$1" id="$2"
workstation_settings "$command" "$project" "$id" >/dev/null
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
script="$here/on-workstation/setup.sh" agent_sh="$here/../vm/in-vm/agent.sh"
json="$ws_projects/$project/project.json"
ports="$(workstation_ports "$command" "$project")"
forwarder="${ports%%$'\n'*}"
url="http://127.0.0.1:$forwarder/run"
tools=()
while IFS= read -r t; do
  [[ "$t" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] || { echo "$command: $project's golden-image tools has '$t', not a tool name" >&2; exit 1; }
  tools+=("$t")
done < <(jq -r '.["golden-image"].tools[]?' "$json")
folder="$(jq -r '.["golden-image"].folder // empty' "$json")"
[[ -z "$folder" || "$folder" == /* ]] || folder="$ws_projects/../$folder"
installer=""
[[ -z "$folder" || ! -f "$folder/workstation-tools.sh" ]] || installer="$folder/workstation-tools.sh"

version="$( { shasum -a 256 "$script" "$agent_sh" ${installer:+"$installer"} | cut -d' ' -f1; echo "url $url"; printf 'tool %s\n' "${tools[@]+"${tools[@]}"}"; } | shasum -a 256 | cut -d' ' -f1)"
if [[ $# -eq 3 ]]; then echo "$version"; exit 0; fi

workstation_lock "$command" "$project" "$id"
workstation_alive "$project" "$id" || { echo "$command: $project's workstation $id has no open connection: workstation:connect $project $id first" >&2; exit 1; }

b64() { if [[ -n "$1" ]]; then base64 < "$1" | tr -d '\n'; fi; echo; }
err="$(mktemp "${TMPDIR:-/tmp}/workstation-setup.XXXXXX")"
trap 'rm -f "$err"' EXIT
rc=0
# Without the lock's descriptor: a setup left hanging past its time is ended (ws_timeout), and holds no lock meanwhile.
out="$( { b64 "$agent_sh"; b64 "$installer"; } | ws_timeout "${WORKSTATION_SETUP_TIMEOUT:-900}" bash -c "source '$here/../workstation.bash' && workstation_ssh \"\$@\"" _ \
  "$project" "$id" bash -c "$(cat "$script")" workstation-setup "$version" "$url" "${tools[@]+"${tools[@]}"}" 2>"$err" 8>&- 9>&-)" || rc=$?
cat "$err" >&2
result="$(tail -n 1 <<< "$out")"
if ! jq -e 'type == "object" and has("ok")' <<< "$result" >/dev/null 2>&1; then
  why="$(grep -v '^[[:space:]]*$' "$err" | tail -n 1 | cut -c1-300)"
  [[ $rc -ne 124 ]] || why="it did not finish within ${WORKSTATION_SETUP_TIMEOUT:-900} seconds"
  [[ $rc -ne 255 ]] || why="the connection failed${why:+: $why}"
  result="$(jq -nc --arg v "$version" --arg why "${why:-it exited $rc and printed nothing}" '{ ok: false, version: $v, did: [], failed: [{ what: "setup", why: $why }] }')"
fi

workstation_record "$project" "$id" --argjson r "$result" '
  .setup = ((.setup // {}) + {
    ok: $r.ok, version: $r.version, "checked-at": $at, did: $r.did, failed: $r.failed,
    error: (if $r.ok then null else ($r.failed | map("\(.what): \(.why)") | join("; ")) end) }
    + (if $r.home then { home: $r.home, runtime: $r.runtime } else {} end)
    + (if $r["boot-id"] then { "boot-id": $r["boot-id"] } else {} end)
    + (if ($r.did | length) > 0 then { "set-up-at": $at } else {} end))'
entry="$(workstation_entry "$project" "$id")"
if [[ "$(jq -r .ok <<< "$result")" != true ]]; then
  echo "$command: $project's workstation $id: setup failed: $(jq -r .setup.error <<< "$entry")" >&2
  exit 1
fi
printf '%s\n' "$entry"
