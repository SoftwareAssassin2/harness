#!/usr/bin/env bash
# Description: End an agent's assignment, logging what it cost — assignments:remove <agent-name> [<cost-usd> <input> <output> <cache-read> <cache-write> [--estimated]] [--billing subscription|api] [--memory <recalls> <returned> <saves> <deletes>].
set -euo pipefail

# Removes the agent's record from assignments.json (in data/) and
# prints it. When the record has a work-item and variation, the agent's open
# dispatch on that variation in the project's active sprint (see sprint.bash),
# or for a backlog ticket in its backlog.json (ASS-144) — the latest agent-dispatch-log entry dispatched-to the agent without a
# completed-timestamp — gets completed-timestamp now (UTC) and, when given,
# cost-usd and tokens { input, output, cache-read, cache-write }, as numbers
# — with --estimated (ASS-268) also cost-estimated: true, the cost usage.json's
# estimate of a turn cut short (control's finish.js costArgs), counted as spend
# like any other —
# and, given --memory (ASS-147), memory { recalls, returned, saves, deletes }:
# how its session used its memory (session.js memoryUse), and, given
# --billing (ASS-216), billing: what its session was billed to — without it,
# what the record's payment-method or the project's login says (ASS-272) — and the
# record's payment-method, when it has one (ASS-217: what control chose);
# a variation without such an entry is left as it is. The sprint is written
# first (ASS-178): a stop before the record goes leaves the record, so a
# rerun — control removes it as stale — finds the dispatch completed and
# removes it; the other way round, a lost record could never complete it. Fails, writing nothing, when the agent has no assignment, the cost or
# tokens are not numbers, or the ticket or variation is missing from the sprint.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

usage="usage: assignments:remove <agent-name> [<cost-usd> <input> <output> <cache-read> <cache-write> [--estimated]] [--billing subscription|api] [--memory <recalls> <returned> <saves> <deletes>]"
memory=null
if [[ $# -ge 2 && "${*: -5:1}" == --memory ]]; then
  for n in "${@: -4}"; do
    [[ "$n" =~ ^[0-9]+$ ]] || { echo "assignments:remove: the memory counts must be numbers, got '$n'" >&2; exit 1; }
  done
  memory="$(jq -nc --argjson r "${*: -4:1}" --argjson m "${*: -3:1}" --argjson s "${*: -2:1}" --argjson d "${*: -1:1}" '{ recalls: $r, returned: $m, saves: $s, deletes: $d }')"
  set -- "${@:1:$#-5}"
fi
billing=null
if [[ $# -ge 3 && "${*: -2:1}" == --billing ]]; then
  [[ "${*: -1}" == subscription || "${*: -1}" == api ]] || { echo "assignments:remove: the billing must be subscription or api, got '${*: -1}'" >&2; exit 1; }
  billing="\"${*: -1}\""
  set -- "${@:1:$#-2}"
fi
estimated=false
if [[ $# -eq 7 && "${*: -1}" == --estimated ]]; then
  estimated=true
  set -- "${@:1:$#-1}"
fi
[[ $# -eq 1 || $# -eq 6 ]] || { echo "$usage" >&2; exit 1; }
name="$1" cost=null tokens=null
if [[ $# -eq 6 ]]; then
  for n in "${@:2}"; do
    [[ "$n" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "assignments:remove: the cost and tokens must be numbers, got '$n'" >&2; exit 1; }
  done
  cost="$2"
  tokens="$(jq -nc --argjson i "$3" --argjson o "$4" --argjson r "$5" --argjson w "$6" '{ input: $i, output: $o, "cache-read": $r, "cache-write": $w }')"
fi

record="$(jq -c --arg name "$name" 'first(.assignments[] | select(.["agent-name"] == $name)) // empty' "$file")"
[[ -n "$record" ]] || { echo "assignments:remove: no assignment for $name" >&2; exit 1; }
read -r project work variation <<< "$(jq -r '"\(.project // "") \(.["work-item"] // "") \(.variation // "")"' <<< "$record")"
# ASS-272: no --billing (a session that never printed its init event) is the
# record's payment-method, else the project's login kind — claude-usage.json's
# auth-method (project:set-claude-usage), api_key its API key, any other its
# subscription (account.js kindOfAccount); neither known, none. A subscription
# so found zeroes the cost, given in full without a billing (finish.js costArgs).
if [[ "$billing" == null ]]; then
  billing="$(jq -c '.["payment-method"] // null' <<< "$record")"
  [[ "$billing" != null || -z "$project" ]] || billing="$(jq -c '.["auth-method"] // null | if . == null then null elif . == "api_key" then "api" else "subscription" end' "$projects/$project/claude-usage.json" 2>/dev/null || echo null)"
  [[ "$billing" != '"subscription"' || "$cost" == null ]] || cost=0
fi

if [[ -n "$work" && -n "$variation" ]]; then
  update_whole_ticket assignments:remove "$project" "$work" --arg name "$variation" --arg agent "$name" --argjson cost "$cost" --argjson tokens "$tokens" --argjson memory "$memory" --argjson billing "$billing" --argjson estimated "$estimated" --argjson payment "$(jq -c '.["payment-method"]' <<< "$record")" '
    if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
    | .variations |= map(if .name == $name then
        (.["state-changes"] // []) as $changes
        | ([range(0; $changes | length) as $i | ($changes[$i]["agent-dispatch-log"] // []) as $log
            | range(0; $log | length) as $j | select($log[$j]["dispatched-to"] == $agent and $log[$j]["completed-timestamp"] == null) | [$i, $j]] | last) as $open
        | if $open == null then . else
            .["state-changes"][$open[0]]["agent-dispatch-log"][$open[1]] |= (.["completed-timestamp"] = $at | if $cost == null then . else .["cost-usd"] = $cost | .tokens = $tokens | if $estimated then .["cost-estimated"] = true else . end end | if $memory == null then . else .memory = $memory end | if $billing == null then . else .billing = $billing end | if $payment == null then . else .["payment-method"] = $payment end)
          end
      else . end)'
fi

update_json "$file" --arg name "$name" '.assignments |= map(select(.["agent-name"] != $name))'
jq . <<< "$record"
