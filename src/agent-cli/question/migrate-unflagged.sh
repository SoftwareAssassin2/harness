#!/usr/bin/env bash
# Description: One-off (ASS-248): close as Assumed the open questions with no blocking flag on Done tickets — question:migrate-unflagged [--apply]; a dry run, writing nothing, without --apply.
set -euo pipefail

# Questions asked before question:ask took --blocking / --non-blocking have no
# blocking flag. On a ticket that is not Done one counts as blocking, read so
# wherever questions are read (control, ticket:join-sprint, the dashboard), and
# is left as it is. On a Done ticket — Done in the ticket system as its
# project's lists last have it: the active sprint, else the backlog, else the
# latest other sprint listing it — its open ones (any status but Answered,
# Answer Accepted or Assumed) close as Assumed, through question:close-assumed
# --unflagged, the questions' own writer. A ticket folder no list names is not
# Done. Prints a line per project: { project, applied, done-tickets,
# closing-as-assumed, open-tickets, now-blocking } — the Done tickets with such
# questions and how many close, the other tickets with them and how many now
# block. Without --apply it writes nothing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/question.bash"

[[ $# -eq 0 || ($# -eq 1 && "$1" == --apply) ]] || { echo "usage: question:migrate-unflagged [--apply]" >&2; exit 1; }
apply=false; [[ $# -eq 1 ]] && apply=true
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

for dir in "$projects"/*/; do
  dir="${dir%/}" project="$(basename "$dir")"
  [[ -f "$dir/project.json" && "$project" =~ ^[A-Za-z0-9_-]+$ ]] || continue
  # The lists a ticket's status is read from, first match wins: the active sprint, the backlog, the other sprints newest first.
  active="$(jq -r 'first(.list[]? | select(.["is-active"]) | .number) // empty' "$dir/sprints.json" 2>/dev/null || true)"
  lists=()
  [[ -n "$active" && -f "$dir/sprints/sprint-$active/sprint.json" ]] && lists+=("$dir/sprints/sprint-$active/sprint.json")
  [[ -f "$dir/backlog.json" ]] && lists+=("$dir/backlog.json")
  while IFS= read -r f; do [[ "$f" == "$dir/sprints/sprint-$active/sprint.json" ]] || lists+=("$f"); done \
    < <(ls "$dir"/sprints/sprint-*/sprint.json 2>/dev/null | sed -E 's/.*sprint-([0-9]+)\/sprint\.json$/\1 &/' | sort -rn | cut -d' ' -f2-)
  done_keys='[]'
  [[ ${#lists[@]} -eq 0 ]] || done_keys="$(jq -s '[reduce (.[] | (.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key != null)) as $t ({};
      ($t.key | ascii_upcase) as $k | if has($k) then . else .[$k] = $t["ticket-system-status"] end) | to_entries[] | select(.value == "Done") | .key]' "${lists[@]}")"
  done_tickets=0 closing=0 open_tickets=0 blocking=0
  for file in "$dir"/work/*/questions-and-answers.json; do
    [[ -s "$file" ]] || continue
    key="$(basename "$(dirname "$file")")"
    n="$(jq '[.list // [] | .[] | select((.status | IN("Answered", "Answer Accepted", "Assumed") | not) and .blocking == null)] | length' "$file" 2>/dev/null || echo 0)"
    [[ "$n" -gt 0 ]] || continue
    if jq -e --arg k "$(tr "[:lower:]" "[:upper:]" <<< "$key")" 'index($k) != null' <<< "$done_keys" > /dev/null; then
      done_tickets=$((done_tickets + 1)) closing=$((closing + n))
      ! $apply || "$here/close-assumed.sh" "$project" "$key" --unflagged > /dev/null
    else
      open_tickets=$((open_tickets + 1)) blocking=$((blocking + n))
    fi
  done
  jq -nc --arg p "$project" --argjson a "$apply" --argjson dt "$done_tickets" --argjson c "$closing" --argjson ot "$open_tickets" --argjson b "$blocking" \
    '{ project: $p, applied: $a, "done-tickets": $dt, "closing-as-assumed": $c, "open-tickets": $ot, "now-blocking": $b }'
done
