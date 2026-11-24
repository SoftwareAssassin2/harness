#!/usr/bin/env bash
# Description: The operator's choice of where a ticket variation is built, worktree or full — ticket:set-work-mode <project> <ticket-key> <variation> worktree|full [<why>].
set -euo pipefail

# ASS-556: the operator overrides the variation's work mode (the ticket
# screen's w key and Actions tab run this too). Written as "work-mode" by
# operator (work-mode.bash write_work_mode), the <why> its reason (else "set
# by the operator"), its history kept; a later Choose Where to Work keeps it
# (work-mode.js decideWorkMode). The only way back to worktree once a
# variation was escalated to full. Refuses worktree for a project that can
# build in none (its run-targets list no worktree target: work-mode.js
# worktreeCapable), writing nothing. Exit 1 on bad arguments, an unknown
# ticket or variation, 3 on that refusal.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../work-mode.bash"

[[ ( $# -eq 4 || $# -eq 5 ) && ( "$4" == worktree || "$4" == full ) ]] || { echo "usage: ticket:set-work-mode <project> <ticket-key> <variation> worktree|full [<why>]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:set-work-mode: invalid project '$1'" >&2; exit 1; }
if [[ "$4" == worktree ]] && ! node "$here/work-mode.js" capable "$projects/$1/project.json"; then
  echo "ticket:set-work-mode: $1 lists no worktree run target (dev-environments.run-targets: local-worktree, workstation-worktree, cloud-vm-worktree), so nothing can be built in a worktree" >&2
  exit 3
fi
why="${5:-set by the operator}"
write_work_mode ticket:set-work-mode "$1" "$2" "$3" "$(jq -nc --arg mode "$4" --arg why "$why" '{ mode: $mode, by: "operator", reasons: [$why] }')"
jq -nc --arg key "$2" --arg v "$3" --arg mode "$4" '{ ticket: $key, variation: $v, "work-mode": $mode, by: "operator" }'
