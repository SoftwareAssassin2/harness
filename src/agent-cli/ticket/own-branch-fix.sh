#!/usr/bin/env bash
# Description: Send a blocked ticket back to fix a failure that is in its own branch, not on master — ticket:own-branch-fix <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# ASS-384. grouped-blocked runs it after project:check-on-master found no
# failure on the latest master (absent, exit 3, or not proven, exit 4) for a
# block Classify put in the project's code: a failure there that is in what
# the ticket's own branch adds or changes is a defect the agents made and can
# fix (a migration number another merge request took first, a check its own
# file fails), not the operator's. It is the ticket's own branch when all hold:
# - Classify said so (its own-branch: true), from the Blocked run's
#   structured-output (<run-id>, as ticket:plan-obstacle-fix reads it);
# - Troubleshoot named the failing check — the failing repository, the
#   failing file (failing-file, a path in it, :line allowed) and the job or
#   assertion that fails on it;
# - that file is one the variation's branch adds or changes: in its VM's
#   checkout of the repository (/repos/<basename>, in_project through
#   limactl), among the files changed since the merge base with origin/<base>
#   (the merge request's base for that repository, else origin's default
#   branch) — committed, not committed, or new and untracked.
# Then the finding (summary, root cause, failing check, file:line, evidence,
# the master evidence) is appended to the variation's
# execution-plan-<variation>.md as an "## Own-branch fix" section (one locked
# append, as plan-obstacle-fix's), which Generate Solution reads first; the
# step the ticket resumes at is Generate Solution's top-level group, lifted
# and checked as a landed fix's is (fix-resume-step.js, engine.js
# whyNotResume: at or before the step it blocked at, else that step). Prints
# { own-branch-fix: true, own-branch-why, plan-revised, resume-at,
# resume-source, resume-why, resume-ignored, ai-feedback-short: null,
# ai-feedback-long: null } — the nulls clear check-on-master's not-proven
# feedback from the run, so the ticket is not marked as handed to the
# operator — and exits 0; control (engine.js ownBranchFix) takes resume-at on
# the parent's return and restarts the visit counts (cause own-branch-fix).
# Anything not shown — Classify did not say so, nothing named, no VM, the file
# not the branch's — prints { own-branch-fix: false, own-branch-why } and
# exits 3, writing nothing: grouped-blocked goes on as before (the obstacle
# fix on absent, Blocked for Human with check-on-master's feedback on not
# proven). The attempts count toward ticket:fix-attempts's budget. Fails (1)
# on bad arguments, a bad variation or an unknown run.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/code.bash"
assignments="${ASSIGNMENTS_FILE:-$here_vm/../../data/assignments.json}"

command=ticket:own-branch-fix
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" id="$4"
variation_exists "$command" "$project" "$key" "$variation"
found="$(jq -c --arg id "$id" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id) | .["structured-output"] // {})' "$assignments")"
[[ -n "$found" ]] || { echo "$command: no run $id" >&2; exit 1; }

no() { jq -nc --arg why "$1" '{ "own-branch-fix": false, "own-branch-why": $why }'; echo "$command: not the ticket's own branch: $1" >&2; exit 3; }
field() { jq -r --arg f "$1" '.[$f] // "" | if type == "string" then . else tostring end' <<< "$found"; }

[[ "$(jq -r '.["own-branch"] == true' <<< "$found")" == true ]] || no "Classify did not put the cause in the ticket's own branch"
url="$(field failing-repository)" url="${url%/}" url="${url%.git}"
file="$(field failing-file)" check="$(field failing-job)"
[[ -n "$check" ]] || check="$(field failing-assertion)"
[[ -n "$url" && -n "$file" && -n "$check" ]] || no "Troubleshoot named no failing repository, file and job or assertion"
repo="${url##*/}"
[[ "$repo" =~ ^[A-Za-z0-9._-]+$ ]] || no "$url names no repository"
# The file as a path in the repository: its :line (and :column) dropped, a /repos/<repo>/ prefix too.
path="$(sed -E 's/(:[0-9]+)+$//; s#^/repos/[^/]+/##; s#^\./##' <<< "$file")"
vm="$(vm_of "$command" "$project" "$key" "$variation")" || exit 1
[[ -n "$vm" ]] || no "$key $variation has no VM, so no branch of its own to read"
base="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation" | jq -r --arg r "$repo" '
  first(.[] | select((.repository // "") | sub("\\.git$"; "") | split("/") | last == $r) | .base // empty) // empty')" || base=""
# In /repos/<repo>: the branch checked out, then each file changed since the merge base with origin/<base>.
changed="$(in_project "$command" "$project" "/repos/$repo" "set -euo pipefail; base=$(printf '%q' "$base")
  [ -n \"\$base\" ] || { ref=\"\$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)\"; base=\"\${ref#origin/}\"; }
  git symbolic-ref -q --short HEAD || echo HEAD
  mb=\"\$(git merge-base HEAD \"origin/\$base\")\"
  { git diff --name-only \"\$mb\"; git ls-files --others --exclude-standard; } | sort -u" "$vm" 2>/dev/null)" \
  || no "the branch in $vm's /repos/$repo could not be read"
branch="$(head -n 1 <<< "$changed")"
grep -qxF -- "$path" <<< "$(tail -n +2 <<< "$changed")" || no "$path is not one the branch $branch in $repo adds or changes"
why="$path is one the branch $branch in $repo adds or changes, and the latest master does not show the failure"

# Where it resumes: Generate Solution's top-level group, as fix-resume-step.js lifts and checks a declared step.
found_variation="$(variation_field . "$command" "$project" "$key" "$variation")"
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
resume="$(jq -nc --arg project "$project" --arg ticket "$key" --argjson variation "$found_variation" --arg engine "$engine" \
  --argjson files "$(engine_files "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')" \
  '{ project: $project, ticket: $ticket, variation: $variation, engine: $engine, engineFiles: $files, declared: "generate-solution",
     declaredBy: "Blocked'"'"'s own-branch fix (ASS-384) declares" }' | node "$here_vm/ticket/fix-resume-step.js")"

attempt="$(jq -r '(.["own-branch-fixes"] // 0) + 1' <<< "$found")"
name="execution-plan-$variation.md"
plan="$(ticket_folder "$command" "$project" "$key")/$name"
section="$(jq -r --arg at "$(date -u +%Y-%m-%d)" --arg v "$variation" --arg n "$attempt" --arg file "$file" --arg path "$path" --arg url "$url" --arg branch "$branch" --arg p "$project" '
  "## Own-branch fix (\($at), Blocked, variation \($v), attempt \($n))\n",
  "Blocked: \(.summary // "not said"). Cause: \(.["root-cause"] // "not said").",
  "Failing check: \([$url, (if (.["failing-job"] // "") != "" then "job \(.["failing-job"])" else empty end)] | join(" "))\(if (.["failing-assertion"] // "") != "" then " — \(.["failing-assertion"])" else "" end). File: \($file).",
  (.evidence // [] | if type == "array" then . else [.] end | if length > 0 then "Evidence:\n" + (map("- \(.)") | join("\n")) else empty end),
  "Not on the latest master (\(.["master-evidence"] // "not checked")): the failure is in this ticket'"'"'s own branch \($branch), which adds or changes \($path) — no \($p) bug raised, no ticket scope added.",
  "Step added: fix it in this ticket'"'"'s own branch (Generate Solution), then carry on with this plan'"'"'s own work."' <<< "$found")"
text="$section"
[[ ! -s "$plan" ]] || text=$'\n'"$section"
append_line "$plan" "$text"
jq -c --arg why "$why" --arg name "$name" '{ "own-branch-fix": true, "own-branch-why": $why, "plan-revised": $name } + . + { "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$resume"
