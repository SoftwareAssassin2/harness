#!/usr/bin/env bash
# Description: Move a ticket within its step's own state engine — ticket:change-sub-state <project> <ticket-key> <variation> <sub-engine> <from-state|-> <to-state> [<sub-state>…].
set -euo pipefail

# On the variation in the project's active sprint (see sprint.bash), at
# whatever top-level state: harness-status.sub-status becomes { state:
# <to-state>, state-engine: <sub-engine> }, and a change within the state is
# appended to state-changes — the top-level engine and state as from and to,
# with sub-state-change { state-engine, from-state (null for -), to-state },
# timestamp (UTC), an empty agent-dispatch-log and work-is-done false — the
# change before it done. Given <sub-state>s, the path of sub-states it
# changes beneath (top first, ASS-67), the change is the level under the
# last of them: its sub-status nested under theirs, and its sub-state-change
# under one for each of them, from and to that sub-state in its engine. A
# change drops any level deeper than its own. <from-state> -
# enters the sub-engine: no sub-status need be there. Leaving the sub-engine
# is ticket:change-state's, which drops the sub-status. A MOVE_CAUSE in the
# environment (sprint.bash: a move no step's exit made, or one no human made
# at a human step — control's fast-track, ASS-151) is merged into the
# change, as move_to merges it. Fails, writing nothing,
# unless the variation's sub-status is at each <sub-state> and then at
# <from-state>, or when the ticket or variation is missing.
#
# The level's run moves with it (ASS-161): when a run of <sub-engine> works
# for that level — its ticket path (runs.bash) the variation's top-level
# state and <sub-state>s — moving from <from-state> is the run's move,
# handed to transient-state-engine:change-state, which moves the run and
# records the move here (MOVED_BY_RUN set, the ticket alone): one way a
# ticket moves within its group, so control, which drives the run, sees it.
# Where the ticket and the run already disagree (the ticket not at the run's
# state in that engine) it refuses, saying where each is — unless <to-state>
# is the run's state, which closes the gap: then the ticket alone moves.
# Entering (-) moves the ticket alone: control enters it as it starts the run.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../runs.bash"

[[ $# -ge 6 ]] || { echo "usage: ticket:change-sub-state <project> <ticket-key> <variation> <sub-engine> <from-state|-> <to-state> [<sub-state>…]" >&2; exit 1; }

path="$(jq -nc '$ARGS.positional' --args "${@:7}")"
if [[ "$5" != "-" && -z "${MOVED_BY_RUN:-}" ]]; then
  # The variation's levels ([{ engine, state }], top first) and the run of
  # <sub-engine> at the level moved, as "<id>\t<run state>\t<ticket engine>\t<ticket state>".
  levels="$(variation_status ticket:change-sub-state "$1" "$2" "$3" 2>/dev/null | jq -Rnc '[inputs | split("\t") | { engine: .[0], state: .[1] }]')" || levels='[]'
  run="$(jq -r --arg p "$1" --arg key "$2" --arg name "$3" --arg sub "$4" --argjson path "$path" --argjson levels "$levels" "$ticket_path_def"'
    .["transient-state-engines"] // [] | . as $all
    | ($path | length + 1) as $depth
    | if ($levels | length) == 0 or ($levels[1:$depth] | map(.state)) != $path then empty else
        first($all[] | select(.project == $p and .["state-engine"] == $sub)
          | select(ticket_path($all) as $at | ($at[1] | ascii_downcase) == ($key | ascii_downcase) and $at[2] == $name and $at[3:] == [$levels[0].state] + $path))
        | "\(.id)\t\(.state)\t\($levels[$depth].engine // "")\t\($levels[$depth].state // "")"
      end' "${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}")"
  if [[ -n "$run" ]]; then
    IFS=$'\t' read -r id state engine at <<< "$run"
    if [[ "$engine" != "$4" || "$at" != "$state" ]]; then
      [[ "$6" == "$state" ]] || { echo "ticket:change-sub-state: $2.$3 is at ${at:-no sub-state} but its $4 run $id is at $state" >&2; exit 1; }
    elif [[ "$5" == "$state" ]]; then
      exec "$here/../transient-state-engine/change-state.sh" "$id" "$5" "$6"
    fi
  fi
fi
update_whole_ticket ticket:change-sub-state "$1" "$2" --arg name "$3" --arg sub "$4" --arg from "$5" --arg to "$6" --argjson path "$path" --argjson cause "${MOVE_CAUSE:-"{}"}" '
  (.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first) as $v
  # The harness-status level `d` beneath the top (0 the top itself).
  | def level($d): reduce range(0; $d) as $i ($v["harness-status"]; .["sub-status"]);
    ($path | length + 1) as $depth
  | if $v == null then error("\($command): no \($key) variation \($name)")
    elif ($v["harness-status"].state // null) == null then error("\($command): \($key).\($name) has no state")
    else . end
  | reduce range(0; $path | length) as $i (.; if (level($i + 1).state // null) != $path[$i] then error("\($command): \($key).\($name) is not at sub-state \($path[$i])") else . end)
  | if $from != "-" and (level($depth).state // null) != $from then error("\($command): \($key).\($name) is not at sub-state \($from)") else . end
  | .variations |= map(if .name == $name then
      .["harness-status"] |= setpath([range(0; $depth) | "sub-status"]; { state: $to, "state-engine": $sub })
      | .["state-changes"] = ((.["state-changes"] // []) | if length > 0 then .[-1]["work-is-done"] = true else . end)
        + [{ "state-engine": .["harness-status"]["state-engine"], "from-state": .["harness-status"].state, "to-state": .["harness-status"].state,
             "sub-state-change": (reduce range(($path | length) - 1; -1; -1) as $i
               ({ "state-engine": $sub, "from-state": (if $from == "-" then null else $from end), "to-state": $to };
                { "state-engine": level($i + 1)["state-engine"], "from-state": $path[$i], "to-state": $path[$i], "sub-state-change": . })),
             timestamp: $at, "agent-dispatch-log": [], "work-is-done": false } + $cause]
    else . end)'
