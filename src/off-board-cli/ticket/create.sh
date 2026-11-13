#!/usr/bin/env bash
# Description: Create an off-board ticket — ticket:create <project> <type> <title> [<body-file>] [--fast-track] [--resume-at <step>] [--priority <priority>].
set -euo pipefail

# Writes <OFF_BOARD_DIR>/<folder>/<KEY>.md (see ticket.bash), the key one past
# the highest number in the folder (read under the store lock), status
# Backlog, the time now as created and updated, and beside it, still under
# the lock, its status history <KEY>.history.json with that first Backlog
# (ASS-413, see ticket.bash). The body file's Markdown (H2 sections) follows the H1 title;
# without one, the User story, Context and Acceptance criteria headings are
# written empty. --priority, last, writes a priority line after the status,
# one of ticket.bash's $priorities (see ticket:update-priority); without it
# the ticket has none. --fast-track (ASS-83), anywhere after the title,
# writes fast-track: true after that: a ticket the health check raises for
# itself, joined to the sprint at once and ranked above everything (control's
# rank.js, fast-track.js); nothing but the health check passes it. The grouped
# blocked flow's fix ticket is fast-tracked too (ASS-306), but after it is
# created — ticket:mark-fast-track, run by agent.sh ticket:fast-track — the
# create prompt it shares with other flows passing no --fast-track.
# --resume-at <step> (ASS-343), anywhere after the title, writes resume-at:
# <step> after that: the grouped blocked flow's fix ticket, when its fix
# changes an earlier step of the blocked ticket's engine than the one it
# blocked at, names that step, where the blocked ticket resumes once the fix
# lands (agent.sh ticket:fix-resume-step; control takes it only when it is a
# work step at or before the blocked one). Prints
# { key, file }. Fails, writing nothing, when the
# project is missing or has no off-board work source, the type is not Story,
# Bug or Spike, the priority is not one of those names, the resume-at step is
# not one word of letters, digits, _ and -, or the body file is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

usage='usage: ticket:create <project> <type> <title> [<body-file>] [--fast-track] [--resume-at <step>] [--priority <priority>]'
fast= resume=
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast-track) fast=1 ;;
    --resume-at)
      [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }
      [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:create: invalid resume-at step '$2'" >&2; exit 1; }
      resume="$2"; shift ;;
    *) args+=("$1") ;;
  esac
  shift
done
set -- "${args[@]+"${args[@]}"}"
priority=
if [[ $# -ge 2 && "${*: -2:1}" == --priority ]]; then priority="$(priority_name ticket:create "${*: -1}")"; set -- "${@:1:$#-2}"; fi
[[ ($# -eq 3 || $# -eq 4) && "${4:-}" != --priority ]] || { echo "$usage" >&2; exit 1; }
case "$2" in Story|Bug|Spike) ;; *) echo "ticket:create: unknown type '$2'; one of Story, Bug, Spike" >&2; exit 1 ;; esac
[[ $# -eq 3 || -f "$4" ]] || { echo "ticket:create: no file $4" >&2; exit 1; }
folder="$(ticket_folder ticket:create "$1")"
prefix="$(key_prefix ticket:create "$1")"

mkdir -p "$folder"
lock_store ticket:create "$folder"
last="$(ticket_files "$folder" | tail -1)"
last="$(basename "${last:-0}" .md)"
last="${last##*-}"
[[ "$last" =~ ^[0-9]+$ ]] || last=0
key="$prefix-$((last + 1))"
file="$folder/$key.md"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

tmp="$(mktemp "$folder/.$key.XXXXXX")"
{
  printf -- '---\nkey: %s\ntype: %s\nstatus: Backlog\n%s%s%screated: %s\nupdated: %s\n---\n# %s\n\n' "$key" "$2" "${priority:+priority: $priority$'\n'}" "${fast:+fast-track: true$'\n'}" "${resume:+resume-at: $resume$'\n'}" "$now" "$now" "$3"
  if [[ $# -eq 4 ]]; then cat "$4"; else printf '## User story\n\n## Context\n\n## Acceptance criteria\n'; fi
} > "$tmp"
mv "$tmp" "$file"
start_history ticket:create "$file" "$now"
jq -n --arg key "$key" --arg file "$file" '{ key: $key, file: $file }'
