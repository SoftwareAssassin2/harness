#!/usr/bin/env bash
# Description: Log what an agent whose assignment is gone cost — assignments:record-spend <project> <work-item> <variation> <agent-name> <start-time> <cost-usd> <input> <output> <cache-read> <cache-write> [--estimated] [--billing subscription|api].
set -euo pipefail

# For an agent whose assignment another hand removed (ticket:delete, the
# operator) while its process ran on (ASS-268: control's finish.js
# endUnassigned): its dispatch on the variation in the project's active sprint
# (see sprint.bash), or for a backlog ticket in its backlog.json — the
# agent-dispatch-log entry dispatched-to the agent at <start-time>, when its
# assignment logged it (assignments:create), with no cost yet — gets cost-usd
# and tokens { input, output, cache-read, cache-write }, as numbers, as
# assignments:remove gives them, with --estimated cost-estimated: true and
# with --billing its billing; completed-timestamp now (UTC) when it has none.
# An entry with a cost already, or none at all, is left as it is: a cost is
# never recorded twice. Fails, writing nothing, when the cost or tokens are not
# numbers, or the ticket or variation is missing.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"

usage="usage: assignments:record-spend <project> <work-item> <variation> <agent-name> <start-time> <cost-usd> <input> <output> <cache-read> <cache-write> [--estimated] [--billing subscription|api]"
billing=null
if [[ $# -ge 3 && "${*: -2:1}" == --billing ]]; then
  [[ "${*: -1}" == subscription || "${*: -1}" == api ]] || { echo "assignments:record-spend: the billing must be subscription or api, got '${*: -1}'" >&2; exit 1; }
  billing="\"${*: -1}\""
  set -- "${@:1:$#-2}"
fi
estimated=false
if [[ $# -eq 11 && "${*: -1}" == --estimated ]]; then
  estimated=true
  set -- "${@:1:$#-1}"
fi
[[ $# -eq 10 ]] || { echo "$usage" >&2; exit 1; }
project="$1" work="$2" variation="$3" name="$4" started="$5"
for n in "${@:6}"; do
  [[ "$n" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "assignments:record-spend: the cost and tokens must be numbers, got '$n'" >&2; exit 1; }
done
tokens="$(jq -nc --argjson i "$7" --argjson o "$8" --argjson r "$9" --argjson w "${10}" '{ input: $i, output: $o, "cache-read": $r, "cache-write": $w }')"

update_whole_ticket assignments:record-spend "$project" "$work" --arg name "$variation" --arg agent "$name" --arg started "$started" --argjson cost "$6" --argjson tokens "$tokens" --argjson billing "$billing" --argjson estimated "$estimated" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name == $name then
      .["state-changes"] |= (if . == null then . else map(.["agent-dispatch-log"] |= (if . == null then . else map(
        if .["dispatched-to"] == $agent and .timestamp == $started and .["cost-usd"] == null then
          .["cost-usd"] = $cost | .tokens = $tokens | .["completed-timestamp"] //= $at
          | if $estimated then .["cost-estimated"] = true else . end
          | if $billing == null then . else .billing = $billing end
        else . end) end)) end)
    else . end)'
