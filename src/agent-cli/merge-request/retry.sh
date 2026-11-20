#!/usr/bin/env bash
# Description: Start a merge request's failed pipeline again, once per head commit — merge-request:retry <project> <ticket-key> <variation> <id>.
set -euo pipefail

# ASS-483: how a VM agent retries a failed CI job that failed on infra before
# any test ran (a runner, Docker daemon or scheduling failure), which no code
# change can fix — on the host, with mr_rerun (ASS-346). Once per head commit:
# the head is recorded on the row ("retried-head", which merge-request:check
# does not clear), and a second call at the same head is refused, so a real
# failure cannot loop; a push gives a new head and one more retry.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 4 ]] || { echo "usage: merge-request:retry <project> <ticket-key> <variation> <id>" >&2; exit 1; }
command=merge-request:retry key="$(upper "$2")"
load_merge_requests "$command" "$1" "$key" "$3"
i="$(mr_by_id "$command" "$key" "$3" "$4")"
head="$(mr_head "$command" "$i")"

if [[ "$(jq -r --argjson i "$i" '.[$i]["retried-head"] // empty' <<< "$MRS")" == "$head" ]]; then
  echo "$command: $(mr_name "$i") was already retried at $head; its failure is real or needs the operator" >&2
  exit 1
fi
view="$(mr_view "$command" "$i")"
mr_rerun "$command" "$i" "$view" || { echo "$command: could not start $(mr_name "$i")'s failed pipeline again" >&2; exit 1; }
# Recorded only once started. feedback-acted (ASS-388, cleared by merge-request:check): merge-request:feedback-round
# counts the round as one that did something, as for a resolve. Not written, a later retry may run once more.
set_merge_request "$command" "$1" "$key" "$3" "$i" "$(jq -nc --arg h "$head" '{ "retried-head": $h, "feedback-acted": true }')" || echo "$command: could not record the retry on $(mr_name "$i")" >&2
