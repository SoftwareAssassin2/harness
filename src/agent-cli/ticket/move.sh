#!/usr/bin/env bash
# Description: Move a ticket, history and all, to another project — ticket:move <from-project> <to-project> <ticket-key>.
set -euo pipefail

# The ticket as it is — every field, its variations' states, histories and
# health — from <from>'s active sprint to the same list (features, bugs or
# spikes) of <to>'s, or, when it is only in <from>'s backlog, to <to>'s
# backlog; a backlog copy of a sprint ticket left in <from> is dropped. Its
# work folder, data/projects/<from>/work/<KEY>, moves to <to>'s. Prints
# { key, from, to, sprint, backlog, folder }. Fails, writing nothing, when it
# is in neither of <from>'s lists, <to> has no active sprint for a sprint
# ticket, <to> already has its work folder, or <to> is <from>.
#
# One transaction (ASS-172): the four files' update_json locks — both active
# sprints and both backlogs — are taken in sorted-path order (so two moves
# never deadlock) before the ticket is read, and held over the read, the copy
# to <to> and the removal from <from>; a write to the ticket waits, and lands
# before the read or fails after (the ticket gone). The files are written as
# update_json would, the locks already held. A failure after the copy puts
# back every file already written: the ticket stays in <from> alone. Killed
# part way, it is rerunnable — the copy replaces <to>'s by key.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:move <from-project> <to-project> <ticket-key>" >&2; exit 1; }
from="$1" to="$2" key="$(tr '[:lower:]' '[:upper:]' <<< "$3")"
for p in "$from" "$to"; do [[ "$p" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$p/project.json" ]] || { echo "ticket:move: no project '$p'" >&2; exit 1; }; done
[[ "$from" != "$to" ]] || { echo "ticket:move: $key is already in $from" >&2; exit 1; }
find_in() { jq -c --arg key "$key" "$1" "$2" 2>/dev/null || true; }
# real <file> — the path update_json locks: resolved, its folder's when it is not there yet.
real() { if [[ -e "$1" ]]; then readlink -f "$1"; else echo "$(readlink -f "$(dirname "$1")")/$(basename "$1")"; fi; }
# active <project> — its active sprint.json, as real prints it; nothing when it has none.
active() { local file; file="$(sprint_file ticket:move "$1" 2>/dev/null)" && real "$file" || true; }
from_sprint="$(active "$from")" to_sprint="$(active "$to")"
from_backlog="$(real "$projects/$from/backlog.json")" to_backlog="$(real "$projects/$to/backlog.json")"
fd=4   # 4–7: never update_json's 9
while IFS= read -r file; do lock_on "$fd" "$file.lock" ticket:move "${JSON_LOCK_TIMEOUT:-30}"; fd=$((fd + 1)); done < <(printf '%s\n' "$from_sprint" "$to_sprint" "$from_backlog" "$to_backlog" | grep . | sort)
# A sprint advanced while this waited is not the one locked.
[[ "$(active "$from")" == "$from_sprint" && "$(active "$to")" == "$to_sprint" ]] || { echo "ticket:move: a sprint advanced while waiting; run it again" >&2; exit 1; }

entry=""; [[ -n "$from_sprint" ]] && entry="$(find_in 'first(("features", "bugs", "spikes") as $a | .[$a] // [] | .[] | select(.key | ascii_upcase == $key) | { list: $a, t: . }) // empty' "$from_sprint")"
waiting=""; [[ -f "$from_backlog" ]] && waiting="$(find_in 'first(.tickets // [] | .[] | select(.key | ascii_upcase == $key)) // empty' "$from_backlog")"
[[ -n "$entry" || -n "$waiting" ]] || { echo "ticket:move: no $key in $from's sprint or backlog" >&2; exit 1; }
[[ ! -e "$projects/$to/work/$key" ]] || { echo "ticket:move: $to already has a work folder for $key" >&2; exit 1; }
[[ -z "$entry" || -n "$to_sprint" ]] || { echo "ticket:move: project '$to' has no active sprint" >&2; exit 1; }

# put <file> [jq options…] <filter> — <file> rewritten as update_json would,
# its lock held; its old content is kept in undo, file then copy, to put back.
undo=()
put() {
  local file="$1" keep tmp=""
  shift
  keep="$(mktemp "$file.XXXXXX")" && cp -p "$file" "$keep" && undo+=("$file" "$keep") \
    && tmp="$(mktemp "$file.XXXXXX")" && cp -p "$file" "$tmp" && jq --indent 4 "$@" "$file" > "$tmp" && [[ -s "$tmp" ]] && mv "$tmp" "$file" \
    || { rm -f "$keep" ${tmp:+"$tmp"}; return 1; }
}
moved() {
  if [[ -n "$entry" ]]; then
    put "$to_sprint" --argjson e "$entry" '.[$e.list] = ([(.[$e.list] // [])[] | select(.key != $e.t.key)] + [$e.t])' \
      && put "$from_sprint" --arg key "$key" '(.features, .bugs, .spikes) |= (if . == null then . else map(select(.key | ascii_upcase != $key)) end)' || return 1
  else
    put "$to_backlog" --argjson t "$waiting" '.tickets = ([(.tickets // [])[] | select(.key != $t.key)] + [$t])' || return 1
  fi
  [[ -z "$waiting" ]] || put "$from_backlog" --arg key "$key" '.tickets |= map(select(.key | ascii_upcase != $key))'
}
[[ -n "$entry" || -f "$to_backlog" ]] || { echo '{ "tickets": [] }' > "$to_backlog.$$" && mv "$to_backlog.$$" "$to_backlog"; }
if ! moved; then
  for ((i = ${#undo[@]} - 2; i >= 0; i -= 2)); do mv "${undo[i+1]}" "${undo[i]}"; done
  echo "ticket:move: could not move $key; $from and $to are as they were" >&2; exit 1
fi
for ((i = 1; i < ${#undo[@]}; i += 2)); do rm -f "${undo[i]}"; done

folder=false
if [[ -d "$projects/$from/work/$key" ]]; then
  mkdir -p "$projects/$to/work"
  mv "$projects/$from/work/$key" "$projects/$to/work/$key"
  folder=true
fi
jq -nc --arg key "$key" --arg from "$from" --arg to "$to" --argjson s "$([[ -n "$entry" ]] && echo true || echo false)" --argjson b "$([[ -z "$entry" ]] && echo true || echo false)" --argjson f "$folder" \
  '{ key: $key, from: $from, to: $to, sprint: $s, backlog: $b, folder: $f }'
