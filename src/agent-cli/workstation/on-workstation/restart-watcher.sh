#!/bin/bash
# The restart watcher (ASS-504), on a cloud VM or GCP workstation: installed
# by on-workstation/setup.sh at ~/harness/lib/restart-watcher.sh and started
# by it, detached, as the ssh user (no root):
#
#   restart-watcher.sh <runtime-folder> <version>
#
# <version> its own (the sha256 of this script, workstation:setup's). Having
# looked for the metadata server, it writes "<pid> <version>" to
# <runtime-folder>/restart-watcher.pid (setup waits for it, and reads it: one
# watcher, replaced when its version changes) and fires
# once — telling every agent on the machine, through the forwarder, that it
# is about to go down (`agent.sh machine:restart-imminent`: the Mac interrupts
# each agent's turn and sends it the restart prompt, to commit and push now) —
# when either:
# - the metadata server's instance/preempted turns TRUE (a GCP Spot
#   preemption: about 30 s before the ACPI shutdown), waited on with
#   ?wait_for_change=true (Metadata-Flavor: Google). Where there is no
#   metadata server (a GCP workstation's container, any non-GCP machine) it is
#   said once, as a note, and only the signals are watched;
# - it gets SIGTERM or SIGHUP: the system shutting down, whatever the cause.
# Once fired, <runtime-folder>/restart-watcher.fired says so for the rest of
# the boot (the runtime folder is emptied at each start), so a watcher started
# again in the same boot never fires a second time. SIGUSR1 ends it quietly
# (setup replacing it). It also ends quietly once its pid file no longer names
# it (a newer one took over, or the runtime folder was emptied), checked
# between waits. What it does goes to ~/harness/restart-watcher.log.
#
# HARNESS_WS_METADATA_URL replaces the preempted flag's URL and
# HARNESS_WS_WATCHER_SECONDS the seconds between checks (10), for tests.
set -u
R="$1" version="$2"
pidfile="$R/restart-watcher.pid" fired_file="$R/restart-watcher.fired"
url="${HARNESS_WS_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1/instance/preempted}"
every="${HARNESS_WS_WATCHER_SECONDS:-10}"
agent_sh="$HOME/harness/bin/agent.sh"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" "$*"; }
child=""

mine() { local pid=""; read -r pid _ 2>/dev/null < "$pidfile"; [[ "$pid" == "$$" ]]; }
quit() {
  [[ -z "$child" ]] || kill "$child" 2>/dev/null
  if mine; then rm -f "$pidfile"; fi
  exit 0
}
# fire <why> — once a boot: the Mac told (agent.sh, waited for: its output logged).
fire() {
  [[ ! -e "$fired_file" ]] || return 0
  : > "$fired_file"
  say "restart imminent ($1): telling the agents on this machine"
  "$agent_sh" machine:restart-imminent </dev/null 2>&1
  say "agent.sh machine:restart-imminent exited $?"
}
trap 'fire "shutdown signal SIGTERM"; quit' TERM
trap 'fire "shutdown signal SIGHUP"; quit' HUP
trap 'quit' USR1

# nap <seconds> — in the background and waited for, so a signal is handled at once.
nap() { sleep "$1" & child=$!; wait "$child"; child=""; }
# preempted [<wait>] — the flag (TRUE or FALSE) in $flag; fails without an answer. With <wait>, waits for a change,
# up to $every seconds, in the background so a signal is handled at once.
preempted() {
  local out="$R/restart-watcher.flag" query=""
  [[ -z "${1-}" ]] || query="?wait_for_change=true&timeout_sec=$every"
  curl -sf --max-time $((every + 5)) -H 'Metadata-Flavor: Google' "$url$query" > "$out" 2>/dev/null & child=$!
  wait "$child" || { child=""; return 1; }
  child=""
  flag="$(tr -d '[:space:]' < "$out")"
  [[ -n "$flag" ]]
}

# claim <how> — said, then the pid file written: the watcher started, for setup, which waits for it.
claim() {
  say "watching for $1 (pid $$, version ${version:0:12})"
  printf '%s %s\n' "$$" "$version" > "$pidfile.$$" && mv -f "$pidfile.$$" "$pidfile" || { say "could not write $pidfile"; exit 1; }
}

flag=""
if ! preempted; then
  claim "the shutdown signal alone: no metadata server at $url (a GCP workstation, or not a GCP VM)"
  while mine; do nap "$every" || { [[ -n "$(command -v sleep)" ]] || { say "no sleep command: stopping"; exit 1; }; }; done
  quit
fi
claim "a preemption or the shutdown signal"
while mine; do
  if [[ "$flag" == TRUE ]]; then
    fire "preempted"
    while mine; do nap "$every"; done   # fired: waits for the shutdown, never firing again
    quit
  fi
  preempted wait || nap "$every"
done
quit
