#!/usr/bin/env bash
# Description: How many fix attempts Blocked has made for a ticket variation — ticket:fix-attempts <project> <ticket-key> <variation>.
set -euo pipefail

# A fix attempt (ASS-107 AC6) is a fix ticket Blocked raised and waited on
# — the variation's move into its await-fix. Counted, as every state counts
# its visits, per stay: in the variation's state-changes (the
# sub-state-changes Blocked's runs record on it) since it last entered
# blocked anew — from any state but blocked itself: a fix closed unmerged
# goes round Blocked again (blocked → blocked) within the same stay. Blocked
# counts them as each of its runs starts: every attempt made before in the
# stay has failed. A fix that landed ends the stay; the step it returns to
# is its proof, and a failure there is a new stay. Prints { fix-attempts },
# exit 0, under 3; at 3 or more, with ai-feedback-short and -long saying
# why the ticket goes to Blocked for Human, exit 3. Fails (exit 1) on an
# unknown ticket or variation.
# ASS-384: an own-branch fix (ticket:own-branch-fix: the failure in the
# ticket's own branch, sent back to Generate Solution with Blocked's finding)
# is an attempt too, though it ends the stay: the Blocked runs kept in the
# variation's blocks that ended so (ended-at done, own-branch-fix true) are
# counted back from the latest, a retry passed over, until one that ended
# any other way (a fix landed, a repair, nothing wrong, Blocked for Human —
# the operator's resolution starts the count again). They add to this stay's
# fix tickets, and are printed as own-branch-fixes when any; at 3 the
# feedback says how often the own-branch fix was tried.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:fix-attempts <project> <ticket-key> <variation>" >&2; exit 1; }
count="$(jq -r --arg key "$2" --arg name "$3" '
  (first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // null) as $t
  | if $t == null then error("ticket:fix-attempts: no \($key) in the active sprint") else . end
  | ($t.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first) as $v
  | if $v == null then error("ticket:fix-attempts: no \($key) variation \($name)") else . end
  | ($v["state-changes"] // []) as $c
  | ([range(0; $c | length) | select($c[.]["to-state"] == "blocked" and $c[.]["from-state"] != "blocked" and ($c[.]["sub-state-change"] == null))] | last // -1) as $entered
  | ([$c[$entered + 1:][] | .["sub-state-change"] // empty | select(.["to-state"] == "await-fix")] | length) as $raised
  | ($v.blocks // [] | if type == "array" then map(objects) else [] end
     | reduce reverse[] as $b ({ n: 0, stop: false };
         if .stop or $b["ended-at"] == "retry" then .
         elif $b["ended-at"] == "done" and $b["own-branch-fix"] == true then .n += 1
         else .stop = true end) | .n) as $own
  | "\($raised + $own) \($own)"' \
  "$(sprint_file ticket:fix-attempts "$1")" 2>&1)" || { echo "${count#jq: error (at *): }" >&2; exit 1; }
read -r count own <<< "$count"
if (( count < 3 )); then jq -nc --argjson n "$count" --argjson own "$own" '{ "fix-attempts": $n } + (if $own > 0 then { "own-branch-fixes": $own } else {} end)'; exit 0; fi
jq -nc --argjson n "$count" --argjson own "$own" --arg v "$3" '($n - $own) as $raised | { "fix-attempts": $n } + (if $own > 0 then { "own-branch-fixes": $own } else {} end) + { "ai-feedback-short": "\($n) fix attempts failed",
  "ai-feedback-long": (if $own == 0 then "\($n) fix tickets raised in this stay in Blocked did not clear the block. Read them and change-log-\($v).md, fix the cause, then resolve, or have AI try again."
    else "The own-branch fix was tried \($own) time\(if $own == 1 then "" else "s" end) (Blocked found the failure in the ticket'"'"'s own branch and sent it back to Generate Solution with its finding, the Own-branch fix sections of execution-plan-\($v).md)\(if $raised > 0 then ", and \($raised) fix ticket\(if $raised == 1 then "" else "s" end) raised in this stay" else "" end), and the block came back. Read them and change-log-\($v).md, fix the cause, then resolve, or have AI try again." end) }'
exit 3
