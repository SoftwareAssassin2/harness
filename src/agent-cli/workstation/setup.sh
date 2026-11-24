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
# is left alone. ASS-468: the folders ASS-435 made per ticket variation,
# ~/harness/<KEY>-<variation>, are removed (all but the one a holder from
# before ASS-468 still records, which workstation:release migrates).
#
# The setup's version (AC2): the sha256 of on-workstation/setup.sh,
# in-vm/agent.sh, (ASS-477) on-workstation/docker-credential-harness, (ASS-504)
# on-workstation/restart-watcher.sh — the watcher setup starts there, whose own
# sha256 it is given (HARNESS_WS_WATCHER_VERSION) to replace a running one of
# another version — the
# project's golden-image/workstation-tools.sh (when it has one), the
# forwarder's URL on the workstation, (ASS-477) the project's Artifact
# Registry host (its registry's upstream, whose credentials the agents'
# Docker there gets from the workstation's service account), project.json's
# golden-image tools, (ASS-471) each command the project's CI checks need and
# the checks needing it, and (ASS-462) each golden-image file shipped beside
# workstation-tools.sh, its name and sha256, one per line — the script and
# the tools list, with what the script installs.
# ASS-471: besides golden-image.tools, setup checks every command the
# project's golden-image ci-checks.json needs — the first word of each
# check's command (src/agent-cli/ci-check-commands.js: past NAME=value
# assignments, keywords and redirections; not builtins, nor a path such as
# scripts/x.sh) and each name a check declares in "needs" (what its scripts
# are known to run) — so a command the workstation lacks fails setup, named
# with the checks that run it, instead of a ticket's CI Checks step exiting
# 127. Missing ones go to workstation-tools.sh with the missing tools.
# Shipped beside it (ASS-462), so it can source a file it shares with
# provision.sh: when the project has a workstation-tools.sh, the golden-image
# folder's other top-level regular files, not dotfiles nor the Lima- or
# test-only ones (provision.sh template.yaml warm.sh images.txt tests.json
# run-test.sh ci-checks.json); a name that is not a plain file name fails. It is recorded on the workstation, in
# ~/harness/setup.json (with the boot id it ran under), and in the
# workstation's live data, workstations.json's `setup`:
#   { ok, version, checked-at (each run), set-up-at (the last that changed
#     anything), home, runtime, boot-id (ASS-435: the workstation's boot it
#     ran under — vm:start records it on the holder, so a restart since shows),
#     did: [what it changed], failed: [{ what, why }],
#     error: one line naming each failure | null,
#     sandbox: { ok, why? } (ASS-555: whether Claude Code's sandbox can run
#     there — bubblewrap, socat, bwrap allowed; never a setup failure: without
#     it the worktree targets skip the machine. ASS-563: setup installs
#     bubblewrap and socat and loads bwrap's AppArmor profile when the kernel
#     restricts user namespaces, on the machine as it is; what it could not do
#     is in sandbox.why and in failed, marked `sandbox: true`, and never in
#     error nor ok) }
# ASS-533: and, for a project with a Substrate cluster on the machine, its
# host setup (on-machine/substrate.sh host-setup, run by every setup so what
# it keeps outside /home is re-applied at each start) and its sha256.
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
script="$here/on-workstation/setup.sh" agent_sh="$here/../vm/in-vm/agent.sh" helper="$here/on-workstation/docker-credential-harness" watcher="$here/on-workstation/restart-watcher.sh"
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
# ASS-477: the project's Artifact Registry host (its registry's upstream), whose credentials the agents' Docker on
# the workstation gets from the workstation's service account (on-workstation/docker-credential-harness).
registry="$(jq -r '.registry.upstream.host // empty' "$json")"
[[ -z "$registry" || "$registry" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "$command: $project's registry upstream host '$registry' is not a host" >&2; exit 1; }
[[ -z "$folder" || "$folder" == /* ]] || folder="$ws_projects/../$folder"
# ASS-471: the commands the project's CI checks run (ci-check-commands.js: each check's first words and its
# declared "needs"), each with the checks that need it, checked on the workstation beside the tools.
needs=()
if [[ -n "$folder" && -f "$folder/ci-checks.json" ]]; then
  lines="$(node "$here/../ci-check-commands.js" "$folder/ci-checks.json")" || { echo "$command: $project's golden-image ci-checks.json could not be read" >&2; exit 1; }
  while IFS=$'\t' read -r c by; do [[ -z "$c" ]] || needs+=("$c" "$by"); done <<< "$lines"
fi
installer=""
[[ -z "$folder" || ! -f "$folder/workstation-tools.sh" ]] || installer="$folder/workstation-tools.sh"
shared=()
if [[ -n "$installer" ]]; then
  while IFS= read -r f; do
    n="${f##*/}"
    case "$n" in workstation-tools.sh|provision.sh|template.yaml|warm.sh|images.txt|tests.json|run-test.sh|ci-checks.json) continue ;; esac
    [[ "$n" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] || { echo "$command: $project's golden-image folder has '$n', not a plain file name to ship to the workstation" >&2; exit 1; }
    shared+=("$n")
  done < <(find "$folder" -mindepth 1 -maxdepth 1 -type f ! -name '.*' | LC_ALL=C sort)
fi

# ASS-533: a project with a Substrate cluster on this machine (dev-environments.substrate) has its host setup —
# on-machine/substrate.sh host-setup: Docker's data-root under /home on a workstation, the inotify limits kind needs,
# the cluster's node started again after a restart — shipped and run by every setup, so what it puts outside /home
# (which a workstation's restart resets) is re-applied at each start. The machine's host kind (workstation or
# cloud-vm) goes as HARNESS_WS_SUBSTRATE. A wrong substrate list adds nothing here (control and substrate:up name it).
substrate_script="" substrate_host=""
if substrate_host="$(node "$here/../substrate.js" "$ws_projects" "$project" "$id" 2>/dev/null | jq -r 'select(.kind == "kind") | .host')" && [[ -n "$substrate_host" ]]; then
  substrate_script="$here/../substrate/on-machine/substrate.sh"
fi
version="$( { shasum -a 256 "$script" "$agent_sh" "$helper" "$watcher" ${installer:+"$installer"} | cut -d' ' -f1; echo "url $url"; echo "registry $registry"; printf 'tool %s\n' "${tools[@]+"${tools[@]}"}"
  [[ -z "$substrate_script" ]] || echo "substrate $substrate_host $(shasum -a 256 < "$substrate_script" | cut -d' ' -f1)"
  for ((i = 0; i < ${#needs[@]}; i += 2)); do printf 'need %s %s\n' "${needs[i]}" "${needs[i+1]}"; done
  for n in "${shared[@]+"${shared[@]}"}"; do printf 'file %s %s\n' "$n" "$(shasum -a 256 < "$folder/$n" | cut -d' ' -f1)"; done; } | shasum -a 256 | cut -d' ' -f1)"
if [[ $# -eq 3 ]]; then echo "$version"; exit 0; fi

workstation_lock "$command" "$project" "$id"
workstation_alive "$project" "$id" || { echo "$command: $project's workstation $id has no open connection: workstation:connect $project $id first" >&2; exit 1; }

b64() { if [[ -n "$1" ]]; then base64 < "$1" | tr -d '\n'; fi; echo; }
err="$(mktemp "${TMPDIR:-/tmp}/workstation-setup.XXXXXX")"
trap 'rm -f "$err"' EXIT
rc=0
# Without the lock's descriptor: a setup left hanging past its time is ended (ws_timeout), and holds no lock meanwhile.
out="$( { b64 "$agent_sh"; b64 "$installer"; b64 "$helper"; b64 "$watcher"; b64 "$substrate_script"; for n in "${shared[@]+"${shared[@]}"}"; do printf '%s ' "$n"; b64 "$folder/$n"; done; } | ws_timeout "${WORKSTATION_SETUP_TIMEOUT:-900}" bash -c "source '$here/../workstation.bash' && workstation_ssh \"\$@\"" _ \
  "$project" "$id" env "HARNESS_KEEP_FOLDER=$(workstation_entry "$project" "$id" | jq -r '.holder.folder // ""')" "HARNESS_WS_REGISTRY=$registry" "HARNESS_WS_SUBSTRATE=$substrate_host" "HARNESS_WS_WATCHER_VERSION=$(shasum -a 256 < "$watcher" | cut -d' ' -f1)" bash -c "$(cat "$script")" workstation-setup "$version" "$url" "${tools[@]+"${tools[@]}"}" ${needs[0]+-- "${needs[@]}"} 2>"$err" 8>&- 9>&-)" || rc=$?
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
    error: (if $r.ok then null else ($r.failed | map(select(.sandbox != true) | "\(.what): \(.why)") | join("; ")) end) }
    + (if $r.home then { home: $r.home, runtime: $r.runtime } else {} end)
    + (if $r["boot-id"] then { "boot-id": $r["boot-id"] } else {} end)
    + (if $r.sandbox then { sandbox: $r.sandbox } else {} end)
    + (if ($r.did | length) > 0 then { "set-up-at": $at } else {} end))'
entry="$(workstation_entry "$project" "$id")"
if [[ "$(jq -r .ok <<< "$result")" != true ]]; then
  echo "$command: $project's workstation $id: setup failed: $(jq -r .setup.error <<< "$entry")" >&2
  exit 1
fi
printf '%s\n' "$entry"
