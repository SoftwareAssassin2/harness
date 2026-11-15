#!/usr/bin/env bash
# Description: Plan one new merge request mid-build, in a repository where the ticket has no Open one — ticket:add-merge-request <project> <ticket-key> <variation> <json-file|-> (- for stdin) — { repository, contents, step, why, needed-by }.
set -euo pipefail

# ASS-424. Write Execution Plan plans a ticket's merge requests; a later
# build step (Generate Solution, Address Merge Request Feedback, Generate
# Automated Tests) that finds the ticket needs a change in one of the
# project's repositories where it has no merge request still to build — none
# planned there, or every one Merged or Closed — plans one here instead of
# asking the operator. A merged merge request does not end the ticket's work
# in its repository (the rule ASS-423 shares on the Blocked path): the
# change goes on a new one, never on the merged branch.
#
# stdin (it is "-": a VM's /mnt/ticket is read-only, ASS-182) — or the file
# whose path is given in its place (ASS-428, as ticket:set-acceptance-criteria
# and ticket:set-merge-request-plan take one: a confined host agent can't pipe
# or redirect into agent.sh without re-sandboxing it, so it stages the JSON in
# a temp file of its own and passes the path, the call a bare one; the
# forwarder still requires "-" of a VM) — holds
#   { repository, contents, step, why, "needed-by": [ids] }
# repository one of the project's (project.json repositories); contents what
# the merge request holds; step the step adding it; why the finding or
# feedback that needs it; needed-by (default none) the planned ids that
# cannot merge without it.
#
# The plan is written by plan_new_merge_request (merge-requests.bash, shared
# with ASS-423): the next id never used on the ticket, branch
# change/<KEY>-<id> (change/<KEY>.<variation>-<id> for a variation other
# than A), depends-on none, base the repository's last merged one's, status
# Not Created. Its row also gets planned-by { step, why, at }, which control
# reads (merge-request:await-dependencies sends the ticket back to Generate
# Solution while it is Not Created; merge-request:check counts it as not
# merged), and each needed-by one neither Merged nor Closed gets it in its
# depends-on, so Await Sequential Merge waits for it to merge. An "## Merge
# request <id> added" section in execution-plan-<variation>.md says which
# step added it and why. Prints { planned: true, id, repository, branch,
# base, "needed-by" } (needed-by: the ids now depending on it) and exits 0.
#
# Exits 3, planning nothing, when the ticket already has a merge request in
# that repository neither Merged nor Closed (Open, or planned and Not Created):
# the change goes on that one. Prints { planned: false, existing: { id,
# branch, status, key, url } }. Fails (1), planning nothing, on bad
# arguments or input, a repository not the project's, a needed-by id not
# planned, or a missing ticket or variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

command=ticket:add-merge-request
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <json-file|-> (- for stdin: { repository, contents, step, why, needed-by })" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" from=stdin
if [[ "$4" != - ]]; then
  from="$4"
  [[ -f "$from" ]] || { echo "$command: no file $from: nothing planned" >&2; exit 1; }
  exec < "$from"
fi
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; exit 1; }
input="$(jq -c 'def text: type == "string" and (gsub("\\s"; "") != "");
  def whole: type == "number" and . >= 1 and . == floor;
  if type == "object" and (.repository | text) and (.contents | text) and (.step | text) and (.why | text)
     and ((.["needed-by"] // []) | type == "array" and all(.[]; whole))
  then { repository, contents, step, why, "needed-by": (.["needed-by"] // [] | unique) } else empty end' 2>/dev/null || true)"
[[ -n "$input" ]] || { echo "$command: $from must hold { repository, contents, step, why, needed-by }, the first four non-empty text, needed-by planned ids" >&2; exit 1; }
field() { jq -r --arg f "$1" '.[$f]' <<< "$input"; }
BARE='def bare: (. // "") | sub("/$"; "") | sub("\\.git$"; "");'
# The repository as project.json names it (a trailing / or .git aside); one not the project's is refused by the plan write.
url="$(jq -r --arg u "$(field repository)" "$BARE"'first(.repositories // [] | .[].url | select(bare == ($u | bare))) // $u' "$projects/$project/project.json" 2>/dev/null || field repository)"

mrs="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")"
# AC3: one in that repository not Merged or Closed takes the change.
existing="$(jq -c --arg u "$url" "$BARE"'first(.[] | select(.id != null and (.repository | bare) == ($u | bare) and (.status | IN("Merged", "Closed") | not))
  | { id, branch, status, key, url }) // empty' <<< "$mrs")"
if [[ -n "$existing" ]]; then
  jq -c '{ planned: false, existing: . }' <<< "$existing"
  echo "$command: $key $variation already has MR $(jq -r .id <<< "$existing") ($(jq -r .status <<< "$existing")) in $url: make the change on its branch $(jq -r .branch <<< "$existing")" >&2
  exit 3
fi
missing="$(jq -r --argjson mrs "$mrs" 'first(.["needed-by"][] | . as $id | select(all($mrs[]; .id != $id))) // empty' <<< "$input")"
[[ -z "$missing" ]] || { echo "$command: needed-by names MR $missing, which $key $variation has not planned" >&2; exit 1; }

planned="$(plan_new_merge_request "$command" "$project" "$key" "$variation" "$url" "$(field contents)")" || exit 1
id="$(jq -r .id <<< "$planned")"
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# planned-by on its row; it joins the depends-on of each needed-by one still to merge.
update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson id "$id" --argjson input "$input" --arg at "$at" '
  .variations |= map(if .name != $name or .["is-deleted"] then . else
    .["merge-request"] |= map(
      if .id == $id then .["planned-by"] = { step: $input.step, why: $input.why, at: $at }
      elif (.id | IN($input["needed-by"][])) and (.status | IN("Merged", "Closed") | not)
      then .["depends-on"] = ((.["depends-on"] // []) + [$id] | unique) else . end) end)'
needed="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation" \
  | jq -c --argjson id "$id" '[.[] | select(.id != $id and any(.["depends-on"][]?; . == $id)) | .id]')"

# AC2: the plan says which step added it and why.
folder="$projects/$project/work/$key"
mkdir -p "$folder"
plan="$folder/execution-plan-$variation.md"
section="$(jq -r --argjson p "$planned" --argjson needed "$needed" --arg at "$at" --arg v "$variation" '
  "## Merge request \($p.id) added (\($at), \(.step), variation \($v))\n",
  "\(.step) planned MR \($p.id) on \($p.repository), branch \($p.branch)\(if $p.base then ", from origin/\($p.base)" else "" end): the ticket has no Open merge request there, so the change goes on a new one, never on a merged branch.",
  "Why: \(.why)",
  "Contents: \(.contents)",
  (if $needed != [] then "Needed by: \($needed | map("MR \(.)") | join(", ")), which now \(if ($needed | length) == 1 then "depends" else "depend" end) on it: it merges first." else empty end)' <<< "$input")"
text="$section"
[[ ! -s "$plan" ]] || text=$'\n'"$section"
append_line "$plan" "$text"
jq -c --argjson needed "$needed" '{ planned: true } + . + { "needed-by": $needed }' <<< "$planned"
