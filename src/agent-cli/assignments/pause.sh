#!/usr/bin/env bash
# Description: Pause all agents or one project's — assignments:pause <all|project> human, or assignments:pause <all|project> ai <agent-name> <reason> <eta-minutes>.
set -euo pipefail

# Each pause is held in data/assignments.json `pauses`, by scope —
# "all", or a project — then kind: `human` (the dashboard's space and !) as
# { since }, `ai` as { since, reason, eta, agent, project, run }: eta
# <eta-minutes> from now, `project` and `run` the health check the agent
# works under (see pause.bash), which alone may pause — its own project
# only, or anything when it is the harness project's. Pausing again replaces
# that scope's kind. `status` is "Paused" while any pause holds; only
# assignments:start of the same scope and kind releases it (control releases
# an AI pause once past its eta). Fails, writing nothing, on an unknown scope
# or kind, an AI pause without a reason or whole minutes from 1, or one its
# agent may not take.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../pause.bash"

usage() { echo "usage: assignments:pause <all|project> human | assignments:pause <all|project> ai <agent-name> <reason> <eta-minutes>" >&2; exit 1; }
scope="${1:-}" kind="${2:-}"
case "$kind" in
  human) [[ $# -eq 2 ]] || usage; agent="" reason="" minutes=0 ;;
  ai)
    [[ $# -eq 5 && -n "$3" && -n "$4" ]] || usage
    [[ "$5" =~ ^[1-9][0-9]*$ ]] || { echo "assignments:pause: <eta-minutes> must be a whole number from 1" >&2; exit 1; }
    agent="$3" reason="$4" minutes="$5" ;;
  *) usage ;;
esac
pause_scope assignments:pause "$scope"
check='{}'
[[ "$kind" == human ]] || check="$(may_pause assignments:pause "$agent" "$scope")"

update_json "$pause_assignments" --arg scope "$scope" --arg kind "$kind" --arg agent "$agent" --arg reason "$reason" --argjson minutes "$minutes" --argjson check "$check" '
  (now | floor) as $now
  | .pauses[$scope][$kind] = ({ since: ($now | todate) }
      + (if $kind == "ai" then { reason: $reason, eta: ($now + $minutes * 60 | todate), agent: $agent, project: $check.project, run: $check.run } else {} end))
  | .status = "Paused"'
