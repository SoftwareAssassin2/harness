#!/usr/bin/env bash
# Description: Start a project's golden image build detached on the Mac and return at once, unless one runs or the image is current — vm:build-golden-start <project>; prints JSON.
set -euo pipefail

# ASS-151: a fast-tracked "Rebuild golden-<project>" ticket's Build agent
# starts the ~50-minute vm:build-golden from its VM (the forwarder allows it
# for a fast-tracked ticket's VM alone) without waiting on it; Test waits on
# it with vm:golden-status. While a build runs (golden_status building: the
# build lock held, or the last started one still going) or the image is
# current, it does nothing. Else it starts vm:build-golden in a session of
# its own — no terminal, nothing tying it to the caller, so neither the
# forwarder's call ending nor control stopping ends it — recording it as
# golden.bash describes (golden-build-run.json, .log, .exit). Prints
# golden_status's JSON with started: whether it started one now (status
# building then). Fails, starting nothing, when the project or its
# definition is missing. One start at a time per project (ASS-179): its
# golden-build-start.lock is held from the check to the run's record, so a
# second finds it building; the build itself is started without it.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:build-golden-start <project>" >&2; exit 1; }
golden_definition vm:build-golden-start "$1"
lock_on 6 "$projects/$1/golden-build-start.lock" vm:build-golden-start "${JSON_LOCK_TIMEOUT:-30}"
now="$(golden_status "$1")"
if [[ "$(jq -r .status <<< "$now")" != failed ]]; then jq -c '. + { started: false }' <<< "$now"; exit 0; fi

dir="$projects/$1"
rm -f "$dir/golden-build-run.exit"
perl -MPOSIX=setsid -e 'setsid(); exec @ARGV' bash -c '"$1" vm:build-golden "$2" > "$3" 2>&1; echo $? > "$4"' build-golden-start \
  "$agent" "$1" "$dir/golden-build-run.log" "$dir/golden-build-run.exit" < /dev/null > /dev/null 2>&1 6>&- &
jq -n --argjson pid $! --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ pid: $pid, "started-at": $at }' | replace_file "$dir/golden-build-run.json"
golden_status "$1" | jq -c '. + { started: true }'
