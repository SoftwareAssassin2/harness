#!/usr/bin/env bash
# Description: Whether the fix a ticket variation waits on has landed — ticket:fix-landed <project> <ticket-key> <variation>.
set -euo pipefail

# Reads the variation's "waits-on" (ticket:wait-on) and finds that ticket in
# its own project's active sprint, else its backlog. Landed is its ticket
# system status Done with a live variation that went through a merge step —
# merge-pull-request (harness-development) or ensure-auto-merge
# (a GitLab project's own engine) — anywhere in its state changes: top level
# (flat harness-development) or nested in a sub-state-change at any depth
# (grouped/v2 engines, whose merge lives in the release sub-engine; ASS-309).
# A Done ticket with no merge step has landed too when a commit whose subject
# starts "<KEY>:" (the key exactly: ASS-33 is not ASS-335) is reachable from
# the default branch of its project's workspace — code.bash's workspace_of
# (the project's local-pc checkout) and default_branch (origin's default
# branch), read as the local branch and as origin's, last fetched: a ticket
# built by hand and committed straight to the default branch, with no merge
# step (ASS-340). That reads a host checkout, so it is for control's host;
# where the workspace is missing or not a git checkout (inside a VM, say), or
# neither branch can be read, no commit is found and it is not landed.
# A Done ticket with neither has landed too when its fix was a direct edit,
# made after the wait began, to the waiting variation's own inputs (ASS-342):
# one of its work_inputs (work.bash, an allowlist: automated-tests-<variation>
# .json and demo-plan-<variation>.json, which only automated-tests:record and
# ticket:set-demo-plan write) is in the waiting ticket's work folder now with
# content other than ticket:wait-on recorded for it in the variation's
# "wait-began" when the wait began. Nothing else there counts — ticket.json,
# *.lock, step outputs, Blocked's change-log, the obstacle fix
# ticket:plan-obstacle-fix appends to the execution plan: all written by the
# harness on its own while the ticket is blocked or waiting — nor another
# variation's file, an edit made before the wait began (it is in what was
# recorded), or a file removed. A wait recorded before ASS-342, with no
# "wait-began", finds no such edit.
# Prints { waits-on, status,
# landed } and exits 0 once landed; exits 3 when it is Done without a merge,
# such a commit or such an edit (closed without its fix landed: a failed fix
# attempt); 1 until then. When
# the variation waits on nothing, or is missing, exit 4, printing why as { ai-feedback-short, ai-feedback-long } (ASS-107 AC7: the
# fix cannot be waited on).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../code.bash"
source "$here/../work.bash"

# committed <project> <ticket-key> — whether a commit whose subject starts
# "<ticket-key>:" is reachable from the default branch of the project's
# workspace, locally or on origin as last fetched; fails when none is, or the
# workspace or branch cannot be read.
committed() {
  local workspace branch ref refs=()
  workspace="$(workspace_of ticket:fix-landed "$1" 2>/dev/null)" || return 1
  branch="$(default_branch "$workspace")"
  for ref in "refs/heads/$branch" "refs/remotes/origin/$branch"; do
    git -C "$workspace" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 && refs+=("$ref")
  done
  [[ ${#refs[@]} -gt 0 ]] || return 1
  git -C "$workspace" log --fixed-strings --grep="$2:" --format=%s "${refs[@]}" 2>/dev/null \
    | awk -v prefix="$2:" 'index($0, prefix) == 1 { found = 1 } END { exit !found }'
}

# edited <project> <ticket-key> <variation> <wait-began> — whether one of the
# variation's work_inputs that <wait-began> recorded is in its work folder
# now with other content than then; fails when none is.
edited() {
  local now
  now="$(work_input_digests ticket:fix-landed "$1" "$2" "$3")"
  jq -en --argjson now "$now" --argjson began "$4" --argjson names "$(work_inputs "$3" | jq -Rnc '[inputs]')" '
    any($names[]; . as $n | ($began.inputs // {} | has($n)) and $now[$n] != null and $now[$n] != $began.inputs[$n])' >/dev/null
}

[[ $# -eq 3 ]] || { echo "usage: ticket:fix-landed <project> <ticket-key> <variation>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
variation="$(jq -c --arg key "$key" --arg name "$3" '
  first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == $key)) // {} | .variations // [] | map(select(.name == $name)) | first // {}' "$(sprint_file ticket:fix-landed "$1")")"
waits="$(jq -c '.["waits-on"] // empty' <<< "$variation")"
began="$(jq -c '.["wait-began"] | objects' <<< "$variation")"
[[ -n "$waits" ]] || {
  jq -nc --arg l "$key $3 waits on no fix ticket, so it cannot wait for one to land." '{ "ai-feedback-short": "The fix ticket cannot be waited on", "ai-feedback-long": $l }'
  echo "ticket:fix-landed: $key $3 waits on no ticket" >&2; exit 4; }

# ASS-390 AC6: a wait on Blocked's own fix merge request (ticket:wait-on
# --merge-request: waits-on { merge-request, key, repository, branch }) is read
# from its forge (merge-requests.bash mr_view), not a ticket. Merged: landed,
# exit 0, printing { waits-on, status, landed, fix-merge-request,
# ai-feedback-short: null, ai-feedback-long: null } — the nulls clear the
# waiting feedback from the run — and recorded Merged in the variation's
# fix-merge-requests. Closed unmerged: exit 3 with ai-feedback saying so, for
# Blocked for Human (a question for the operator, not a retry: the fix was
# Blocked's own). Open: exit 1, still waiting (no failure counted), the
# variation's Health (ai-feedback-short and -long, written only when it
# changes) naming it, its url, and what it needs — approval (GitLab's
# approvals_left, GitHub's review decision), out of draft, a failed pipeline,
# open threads, a rebase. A forge that cannot be read is still waiting (1).
# Each end is logged in the change log (work.bash blocked_log, AC3).
if [[ "$(jq -r 'has("merge-request")' <<< "$waits")" == true ]]; then
  source "$here/../merge-requests.bash"
  command=ticket:fix-landed project="$1" name="$3" url="$(jq -r '.["merge-request"]' <<< "$waits")"
  MRS="$(jq -c '[{ repository, branch, key }]' <<< "$waits")" URLS="$(jq -c '[.repository]' <<< "$waits")"
  mr="$(jq -r '.key // "the fix merge request"' <<< "$waits")" where="$(path_of "$(jq -r .repository <<< "$waits")")"
  view="$(mr_view "$command" 0 2>/dev/null)" || { echo "$command: $mr in $where could not be read from its forge; still waiting" >&2; exit 1; }
  state="$(jq -r .state <<< "$view")"
  record() {
    update_whole_ticket "$command" "$project" "$key" --arg name "$name" --arg u "$url" --arg s "$1" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else .["fix-merge-requests"] |= map(if .url == $u then .status = $s else . end) end)' 2>/dev/null || true
  }
  case "$state" in
    Merged)
      record Merged
      blocked_log "$project" "$key" "$name" "Await the Fix Merge Request" "The fix merge request $mr ($url) merged: $key resumes."
      jq -nc --argjson w "$waits" --arg u "$url" '{ "waits-on": $w, status: "Merged", landed: true, "fix-merge-request": $u, "ai-feedback-short": null, "ai-feedback-long": null }'
      exit 0 ;;
    Closed)
      record Closed
      blocked_log "$project" "$key" "$name" "Await the Fix Merge Request" "The fix merge request $mr ($url) was closed without merging: handed to the operator."
      jq -nc --argjson w "$waits" --arg u "$url" --arg mr "$mr" --arg where "$where" --arg key "$key" '{ "waits-on": $w, status: "Closed", landed: false, "fix-merge-request": $u,
        "ai-feedback-short": "Fix MR \($mr) in \($where) was closed unmerged",
        "ai-feedback-long": "Blocked'"'"'s Repair Project opened the fix merge request \($mr) (\($u)) to unblock \($key), and it was closed without merging. Reopen and merge it, or fix the block another way, then resolve; or have AI try again." }'
      echo "$command: $mr was closed unmerged" >&2
      exit 3 ;;
  esac
  approvals="$(mr_approvals_left "$command" 0 "$view")"
  needs="$(jq -r --arg a "$approvals" '[ (if $a == "unknown" then "a review approval" elif ($a | tonumber? // 0) > 0 then "\($a) approval\(if $a == "1" then "" else "s" end)" else empty end),
    (if .draft then "taking out of draft" else empty end),
    (.reasons[]? | { "build-failed": "its failed pipeline fixed", "open-threads": "its open threads resolved", "needs-rebase": "a rebase" }[.] // empty) ]
    | if length == 0 then "merging (approval, if its project asks for one)" else join(", ") end' <<< "$view")"
  short="Waits on fix MR $mr in $where: needs approval"
  long="Blocked's Repair Project opened the fix merge request $mr ($url) to unblock $key, which waits for it to merge. It needs a person's approval to merge (now: $needs): review and approve it, then merge it; closed unmerged, $key comes to you."
  was="$(variation_field '.["ai-feedback-long"] // ""' "$command" "$project" "$key" "$name" | jq -r .)"
  if [[ "$was" != "$long" ]]; then
    update_whole_ticket "$command" "$project" "$key" --arg name "$name" --arg s "$short" --arg l "$long" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else .["ai-feedback-short"] = $s | .["ai-feedback-long"] = $l end)'
    echo "$command: $key $name: $long" >&2
  fi
  jq -nc --argjson w "$waits" --arg u "$url" '{ "waits-on": $w, status: "Open", landed: false, "fix-merge-request": $u }'
  exit 1
fi
home="$(jq -r .project <<< "$waits")" fix="$(jq -r .ticket <<< "$waits")"
files=("$(sprint_file ticket:fix-landed "$home")")
backlog="$(dirname "$(dirname "$(dirname "${files[0]}")")")/backlog.json"
[[ -f "$backlog" ]] && files+=("$backlog")
found="$(jq -cs --arg key "$fix" '
  first(.[] | (.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | ascii_upcase == $key))
  | { status: (.["ticket-system-status"] // null),
      merged: any(.variations // [] | .[] | select(.["is-deleted"] | not) | .["state-changes"] // [] | .[] | .. | objects | select(has("from-state")); .["from-state"] | IN("merge-pull-request", "ensure-auto-merge")) }' "${files[@]}")"
status="$(jq -r '.status // "unknown"' <<< "${found:-null}")"
merged="$(jq -r '.merged // false' <<< "${found:-null}")"
landed=false
[[ "$status" == Done && "$merged" == true ]] && landed=true
[[ "$status" == Done && "$landed" == false ]] && committed "$home" "$fix" && landed=true
[[ "$status" == Done && "$landed" == false && -n "$began" ]] && edited "$1" "$key" "$3" "$began" && landed=true
jq -nc --argjson w "$waits" --arg s "$status" --argjson l "$landed" '{ "waits-on": $w, status: $s, landed: $l }'
[[ "$landed" == true ]] && { blocked_log "$1" "$key" "$3" "Await the Fix" "The fix ticket $fix landed (status $status): $key resumes."; exit 0; }
[[ "$status" == Done ]] && { blocked_log "$1" "$key" "$3" "Await the Fix" "The fix ticket $fix is Done without its fix landed: a failed fix attempt; Blocked goes round again."; echo "ticket:fix-landed: $fix is Done without its fix landed" >&2; exit 3; }
exit 1
