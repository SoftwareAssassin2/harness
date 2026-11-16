#!/usr/bin/env bash
# Description: Start a project's GCP workstation if it is stopped and open its one SSH connection, the forwarder, Hindsight and zot reverse-forwarded to its loopback — workstation:connect <project> <id>; prints its live data.
set -euo pipefail

# ASS-433 AC1: the workstation is the project's dev-environments workstation
# <id> (ASS-431). Under the workstation's lock (workstation.bash
# workstation_lock), so two connects never race: a second waits, then finds
# the connection open. In order:
#  1. An open connection that answers (its master up and a command run over
#     it returning) is taken as it is: recorded connected, printed.
#  2. Anything left of an earlier one (a master hung, a stale socket) ended.
#  3. The workstation's state read (gcloud workstations describe); a stopped
#     one started (gcloud workstations start, which waits: about 80 seconds),
#     one stopping waited for and then started, one starting waited for —
#     polled every WORKSTATION_POLL_SECONDS (5) until it runs, for up to
#     WORKSTATION_START_TIMEOUT seconds (300).
#  4. The one master SSH connection opened (workstation.bash workstation_open:
#     gcloud workstations ssh … -M -S <socket> -N), with a reverse forward
#     for each of harness.json's forwarder-port, project.json's hindsight.port
#     and registry.port, each bound to the workstation's loopback at the same
#     port (AC2), and waited for, up to WORKSTATION_CONNECT_TIMEOUT seconds
#     (60).
# Each step's outcome is written to the project's workstations.json (AC5):
# state, connected, connected-at, started-at, forwards; a failure as
# last-error { at, kind, message }, kind expired when the gcloud login under
# the workstation's gcloud-config needs reauthentication (src/control/
# login.js's reading, ASS-429: a network failure is offline, never expired),
# the message one line with any token redacted. Prints the workstation's
# entry with its id and started (whether this started it). Fails, naming the
# step and the kind, otherwise; for expired, with the gcloud auth login to run.
#
# ASS-470: run by a control (HARNESS_CONTROL_PID, which control gives every
# agent.sh it runs), the connection is recorded as that control's
# (control-pid) — an open one taken as it is, unless another running control
# owns it; a new one before the workstation is started, so a control exiting
# meanwhile still closes it — and nothing is done for a control that has
# exited: refused at once, and a master opened after it exited closed again.
# Run by hand, a new master is recorded as nobody's (null), and so is an open
# one no running control owns. workstation.bash says why.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation.bash"

command=workstation:connect
[[ $# -eq 2 ]] || { echo "usage: $command <project> <id>" >&2; exit 1; }
project="$1" id="$2"
settings="$(workstation_settings "$command" "$project" "$id")"
ports=()
while IFS= read -r port; do ports+=("$port"); done < <(workstation_ports "$command" "$project")
[[ ${#ports[@]} -gt 0 ]] || exit 1
config="$(jq -r '.["gcloud-config"] // empty' <<< "$settings")"

# fail <what> <output> — the failure recorded (last-error, not connected) and reported.
fail() {
  workstation_error "$2"
  workstation_record "$project" "$id" --arg kind "$ws_error_kind" --arg message "$ws_error_message" \
    '. + { connected: false, "checked-at": $at, "last-error": { at: $at, kind: $kind, message: $message } }' || true
  local hint=""
  [[ "$ws_error_kind" != expired ]] || hint="; the gcloud login needs reauthentication: run ${config:+CLOUDSDK_CONFIG=$config }gcloud auth login"
  echo "$command: $project's workstation $id: $1 failed ($ws_error_kind)$hint: $ws_error_message" >&2
  exit 1
}

printed() { workstation_entry "$project" "$id" | jq -c --argjson started "$1" '. + { started: $started }'; }

workstation_lock "$command" "$project" "$id"

me="${HARNESS_CONTROL_PID:-}"
[[ "$me" =~ ^[0-9]+$ ]] || me=""
gone() { [[ -n "$me" ]] && ! kill -0 "$me" 2>/dev/null; }
! gone || { echo "$command: $project's workstation $id: the control that ran it (pid $me) has exited: not connected" >&2; exit 1; }

if workstation_reachable "$project" "$id"; then
  owner="$(workstation_entry "$project" "$id" | jq -r '.["control-pid"] // empty')"
  ws_live_control "$owner" || owner="$me"
  workstation_record "$project" "$id" --argjson owner "${owner:-null}" '. + { state: "running", connected: true, "checked-at": $at, "control-pid": $owner }'
  printed false
  exit 0
fi
workstation_close "$project" "$id"
workstation_record "$project" "$id" --argjson owner "${me:-null}" '. + { "control-pid": $owner }'

started=false
state="$(workstation_state "$settings" 2>&1)" || fail "reading its state (gcloud workstations describe)" "$state"
deadline=$((SECONDS + ${WORKSTATION_START_TIMEOUT:-300}))
while [[ "$state" != running ]]; do
  if [[ "$state" == stopped ]]; then
    workstation_record "$project" "$id" --arg s "$state" '. + { state: $s, "state-at": $at }'
    out="$(workstation_gcloud "$settings" start 2>&1)" || fail "starting it (gcloud workstations start)" "$out"
    started=true
    workstation_record "$project" "$id" '. + { "started-at": $at }'
  else
    (( SECONDS < deadline )) || fail "waiting for it to run" "it is still $state after ${WORKSTATION_START_TIMEOUT:-300} seconds"
    sleep "${WORKSTATION_POLL_SECONDS:-5}"
  fi
  state="$(workstation_state "$settings" 2>&1)" || fail "reading its state (gcloud workstations describe)" "$state"
done
workstation_record "$project" "$id" '. + { state: "running", "state-at": $at }'

out="$(workstation_open "$project" "$id" "$settings" "${ports[@]}" 2>&1)" || fail "opening its SSH connection (gcloud workstations ssh)" "$out"
if gone; then
  workstation_close "$project" "$id"
  workstation_record "$project" "$id" '. + { connected: false, "disconnected-at": $at, "control-pid": null }'
  echo "$command: $project's workstation $id: the control that ran it (pid $me) exited while it connected: closed again" >&2
  exit 1
fi
workstation_record "$project" "$id" --argjson forwards "$(printf '%s\n' "${ports[@]}" | jq -sc 'map(tonumber)')" \
  '. + { connected: true, "connected-at": $at, "checked-at": $at, forwards: $forwards, "last-error": null }'
printed "$started"
