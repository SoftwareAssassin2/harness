#!/usr/bin/env bash
# Description: Set or clear a backlog ticket's manual backlog priority, making room for it — ticket:set-manual-backlog-priority <project> <ticket-key> <priority> [<for>].
set -euo pipefail

# ASS-100: the backlog's manual rank, kept apart from the sprint's
# manual-priority (ticket:set-manual-priority), which it never reads or
# writes. Ranked over every ticket in the project's backlog.json, those in the
# sprint too. Given a whole number from 1, the ticket's
# manual-backlog-priority moves there from where it was: up, every ticket
# with one from there to where it was shifts one down; down, every one from
# where it was to there shifts one up; set where there was none, every one
# from there on shifts one down. Given "", it is cleared to null and every one
# after it shifts one up, so they stay whole from 1. A ticket without one is
# never shifted. Then the backlog is renumbered (ticket:renumber-backlog --by
# human): a ticket's manual-backlog-priority is its priority. Prints { ticket,
# manual-backlog-priority }. Fails, writing nothing, on any other priority, or
# a ticket not in the backlog.
#
# ASS-195: <for> is the dependent a dependency hold raised the ticket for
# (src/control/dependencies.js), as ticket:set-manual-priority's. With a
# priority, the same write records priority-raised-by { field:
# "manual-backlog-priority", value, for } on the ticket; with "", that raise
# is released — only when the record is there and for <for>, the value
# cleared as ever while it still holds the recorded one, left alone when the
# operator has set another since, the record dropped either way; without
# <for>, the write is the operator's and the record is dropped. The ticket is
# matched in backlog.json whatever the sprint lists (ASS-42), so a dependency
# that has joined the sprint still has its raise released there.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"

[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: ticket:set-manual-backlog-priority <project> <ticket-key> <priority> [<for>]" >&2; exit 1; }
[[ -z "$3" || "$3" =~ ^[1-9][0-9]*$ ]] || { echo "ticket:set-manual-backlog-priority: the priority must be a whole number from 1, or \"\" to clear it" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
file="$projects/$1/backlog.json"
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$file" ]] && jq -e --arg k "$key" 'any(.tickets[]?; .key | ascii_upcase == $k)' "$file" >/dev/null \
  || { echo "ticket:set-manual-backlog-priority: no $key in $1's backlog" >&2; exit 1; }
dependent="${4-}"

# A release with no raise of its own to release writes nothing at all.
if [[ -n "$dependent" && -z "$3" ]]; then
  jq -e --arg k "$key" --arg dependent "$dependent" '
    first(.tickets[] | select(.key | ascii_upcase == $k))
    | .["priority-raised-by"] | . != null and .for == $dependent' "$file" >/dev/null || exit 0
fi

update_json "$file" --arg k "$key" --arg priority "$3" --arg dependent "$dependent" '
  def same: ascii_upcase == $k;
  def shift($by): .["manual-backlog-priority"] += $by;
  def onTicket(change): .tickets |= map(if .key | same then change else . end);
  first(.tickets[] | select(.key | same)) as $me
  | ($me | .["manual-backlog-priority"]) as $from
  | (if $priority == "" then null else $priority | tonumber end) as $to
  | ($priority == "" and $dependent != "" and $me["priority-raised-by"].value != $from) as $keep
  | (if $keep then . else
    .tickets |= map(.["manual-backlog-priority"] as $at
        | if .key | same then .["manual-backlog-priority"] = $to
          elif $at == null then .
          elif $to == null then (if $from != null and $at > $from then shift(-1) else . end)
          elif $from == null then (if $at >= $to then shift(1) else . end)
          elif $to < $from then (if $at >= $to and $at < $from then shift(1) else . end)
          elif $to > $from then (if $at > $from and $at <= $to then shift(-1) else . end)
          else . end)
    end)
  | if $dependent != "" and $to != null then onTicket(.["priority-raised-by"] = { field: "manual-backlog-priority", value: $to, for: $dependent })
    else onTicket(del(.["priority-raised-by"])) end'
"$here/renumber-backlog.sh" "$1" --by human >/dev/null
jq -nc --arg t "$key" --arg p "$3" '{ ticket: $t, "manual-backlog-priority": (if $p == "" then null else $p | tonumber end) }'
