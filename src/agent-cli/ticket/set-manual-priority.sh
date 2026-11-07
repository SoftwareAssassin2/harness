#!/usr/bin/env bash
# Description: Set or clear a ticket's manual priority, making room for it — ticket:set-manual-priority <project> <ticket-key> <priority> [<for>].
set -euo pipefail

# In the project's active sprint (see sprint.bash), a ticket's rank is its
# manual-priority when set, else its priority. Given a whole number from 1,
# it becomes the ticket's manual-priority and its priority, and the ticket
# moves there from its rank: every other ticket ranked between the two shifts
# one toward where it was — down when it moves up, up when it moves down — or,
# for a ticket without a rank, every one from there down one; a shifted
# ticket's manual-priority, when set, shifts with its priority.
#
# Given "", its manual-priority is cleared to null and every ticket without
# one is ranked again, taking the ranks those with one leave free, in order:
# higher ticket-system-priority (Highest, Critical, Very High, High, Medium, Low, Very Low, Lowest, then
# none); bugs before the rest; depended on by another ticket in the sprint; closer
# to done (the highest step sequence of its variations, in the project's
# execution state engine, see engine_steps); more points; then
# ticket number. Fails, writing nothing, on any other priority or an unknown
# ticket.
#
# ASS-195: <for> is the dependent a dependency hold raised the ticket for
# (src/control/dependencies.js). With a priority, the same write records
# priority-raised-by { field: "manual-priority", value, for } on the ticket,
# so the hold releases its own raise and nothing else. With "", that raise is
# released: only when the record is there and for <for> — nothing is written
# otherwise — the manual priority cleared as ever while it still holds the
# recorded value, left alone when the operator has set another since, and the
# record dropped either way. Without <for> the write is the operator's: the
# record is dropped, so their value is never cleared later.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: ticket:set-manual-priority <project> <ticket-key> <priority> [<for>]" >&2; exit 1; }
[[ -z "$3" || "$3" =~ ^[1-9][0-9]*$ ]] || { echo "ticket:set-manual-priority: the priority must be a whole number from 1, or \"\" to clear it" >&2; exit 1; }
dependent="${4-}"

# A release with no raise of its own to release writes nothing at all.
if [[ -n "$dependent" && -z "$3" ]]; then
  sprint="$(sprint_file ticket:set-manual-priority "$1" 2>/dev/null)" || sprint=""
  [[ -z "$sprint" ]] || jq -e --arg key "$2" --arg dependent "$dependent" '
    first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
    | .["priority-raised-by"] | . != null and .for == $dependent' "$sprint" >/dev/null || exit 0
fi

# The engine's step sequences by id, for "closer to done".
sequences="$(engine_steps ticket:set-manual-priority "$1" | jq -c '[.[] | { (.id): .sequence }] | add // {}')"

update_sprint ticket:set-manual-priority "$1" "$2" --arg priority "$3" --arg dependent "$dependent" --argjson sequences "$sequences" '
  def rank: .["manual-priority"] // .priority;
  def shift($by): .priority |= (if . == null then . else . + $by end)
    | .["manual-priority"] |= (if . == null then . else . + $by end);
  def tickets: (.features, .bugs, .spikes) // [] | .[];
  def onTicket(change): (.features, .bugs, .spikes) |= (if . == null then . else map(if .key | same then change else . end) end);
  ($t | rank) as $from
  | (if $priority == "" then null else $priority | tonumber end) as $to
  | ($priority == "" and $dependent != "" and $t["priority-raised-by"].value != $t["manual-priority"]) as $keep
  | (if $keep then . else
    (.features, .bugs, .spikes) |= (if . == null then . else map(
        if .key | same then
          .["manual-priority"] = $to | if $to == null then . else .priority = $to end
        elif $to == null or rank == null then .
        elif $from == null or $to < $from then (if rank >= $to and ($from == null or rank < $from) then shift(1) else . end)
        elif $to > $from then (if rank > $from and rank <= $to then shift(-1) else . end)
        else . end
      ) end)
    | if $to != null then . else
        ([tickets | .dependencies // [] | .[]] | unique) as $depended
        | ({ Highest: 0, Critical: 1, "Very High": 2, High: 3, Medium: 4, Low: 5, "Very Low": 6, Lowest: 7 }) as $jira
        | ([.bugs // [] | .[] | .key]) as $bugs
        | ([tickets | .["manual-priority"] | select(. != null)]) as $taken
        | ([tickets | select(.["manual-priority"] == null) | {
            key,
            order: [
              ($jira[.["ticket-system-priority"] // ""] // 5),
              (if .key | IN($bugs[]) then 0 else 1 end),
              (if .key | IN($depended[]) then 0 else 1 end),
              -([.variations // [] | .[] | select(.["is-deleted"] | not) | $sequences[.["harness-status"].state] // -1] | max // -1),
              -(.points // 0),
              ([.key | scan("[0-9]+")] | last // "0" | tonumber)
            ]
          }] | sort_by(.order) | map(.key)) as $ranked
        | ([range(1; ($ranked | length) + ($taken | length) + 1)] - $taken) as $free
        | (reduce range(0; $ranked | length) as $i ({}; .[$ranked[$i]] = $free[$i])) as $ranks
        | (.features, .bugs, .spikes) |= (if . == null then . else map(
            if .["manual-priority"] == null then .priority = $ranks[.key] else . end
          ) end)
      end
  end)
  | if $dependent != "" and $to != null then onTicket(.["priority-raised-by"] = { field: "manual-priority", value: $to, for: $dependent })
    else onTicket(del(.["priority-raised-by"])) end'
