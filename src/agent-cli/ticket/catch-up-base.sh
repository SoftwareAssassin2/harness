#!/usr/bin/env bash
# Description: Bring a blocked ticket's branches up to date with their base and renumber a numbered file whose number is taken, then re-run the failing check — ticket:catch-up-base <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# ASS-509. grouped-blocked runs it (Bring the Base In, on the host, its VM
# running) when Classify says the block is "behind-base" — the failure is
# explained by files or changes origin/<base> has and the ticket's branch
# lacks (a repository check reading files master added since as deleted) —
# or "numbered-file-taken" — a numbered file the ticket adds (a migration, a
# numbered test) has a number origin/<base> or an older open merge request
# already uses. Both are routine; neither goes to the operator.
#
# 1. The base brought in (catch-up-base.bash catch_up_base): each of the
#    variation's merge requests neither Merged nor Closed — only the
#    repository Classify named (ticket-branch-repository) when it is one of
#    them — in its checkout in the variation's machine, rebased onto the
#    latest origin/<base> and pushed (--force-with-lease), or, the forced
#    push refused, the base merged in and pushed. In vm+workstation mode on a
#    Lima VM the repositories are put on the ticket's branches first
#    (vm:step-start), as ticket:recheck-block does.
# 2. Numbered files (merge-request:check-numbered-files, the same rules):
#    each that collides git mv'd to the name the check gives, every
#    reference to its old name in a file the branch adds or changes
#    rewritten, committed ("<KEY>: renumber <old> to <new>, its number taken
#    (<reason>)") and pushed; an entry of automated-tests-<variation>.json
#    naming the old name recorded again with the new one
#    (automated-tests:record); the check run again to confirm.
# Each thing done, or not, goes in the change log (work.bash blocked_log,
# "Bring the Base In"). Then:
# - a rebase or merge that does not apply cleanly, changes not committed, a
#   branch parted from its origin copy, or a rename that could not be made
#   (or did not clear the collision): nothing of it is forced — the branch
#   is left exactly as it was — and an "## Own-branch fix" section in
#   execution-plan-<variation>.md says what to bring in or rename and why
#   (each conflict's files); the run is done with Generate Solution's group
#   as its resume-at (fix-resume-step.js, as ticket:own-branch-fix's),
#   own-branch-fix true, own-branch-source behind-base-conflict — exit 0;
# - something was brought in or renamed: the blocked step's check is re-run
#   (ticket:recheck-block, RECHECK_STEP "Bring the Base In"). It passes — or
#   the step is no check of the harness's own to re-run, its own run being
#   the check — the run is done, own-branch-fix true, own-branch-source
#   behind-base or numbered-file, no resume-at: the ticket resumes at the
#   step it was blocked at, its visit counts restarted (engine.js
#   ownBranchFix), exit 0. Still failing: exit 4, own-branch-fix false,
#   base-caught-up true — Troubleshoot again, on the branch as it is now;
# - nothing to bring in and nothing collides (Classify's finding not borne
#   out), or no VM: exit 3, its ai-feedback saying so (Blocked for Human);
# - origin could not be fetched or a push failed (each put back as it was),
#   or the numbered files could not be checked for numbered-file-taken:
#   exit 5, its ai-feedback naming them (Blocked for Human).
# Every exit 0 is a fix attempt: ticket:fix-attempts counts the runs that
# ended so (own-branch-fix true, own-branch-source one of the three) in a row
# as base catch-ups, so the third sends the ticket to Blocked for Human with
# what was tried. Prints the run's output as JSON: own-branch-fix,
# own-branch-source, own-branch-why, caught-up (per merge request:
# repository, branch, base, status, behind, detail), renumbered (repository,
# branch, file, rename-to, status, detail, references), recheck, and the
# ai-feedback (null when it is no one's to act on). Fails (1) on bad
# arguments, an unknown run or variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/code.bash"
source "$here_vm/work.bash"
source "$here_vm/engine.bash"
source "$here_vm/dev-environments.bash"
source "$here_vm/catch-up-base.bash"
assignments="${ASSIGNMENTS_FILE:-$here_vm/../../data/assignments.json}"

command=ticket:catch-up-base
step="Bring the Base In"
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" id="$4"
variation_exists "$command" "$project" "$key" "$variation"
found="$(jq -c --arg id "$id" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id) | .["structured-output"] // {})' "$assignments")"
[[ -n "$found" ]] || { echo "$command: no run $id" >&2; exit 1; }
issue="$(jq -r '.issue // ""' <<< "$found")"
log() { blocked_log "$project" "$key" "$variation" "$step" "$1"; }
# ends <exit> <short> <long> [<extra json>] — the run's output with its feedback, logged.
ends() {
  local extra="${4:-}"; [[ -n "$extra" ]] || extra='{}'
  log "$2. $3"
  jq -nc --arg short "$2" --arg long "$3" --argjson extra "$extra" '{ "own-branch-fix": false, "own-branch-why": $short } + $extra + { "ai-feedback-short": $short, "ai-feedback-long": $long }'
  echo "$command: $2" >&2
  exit "$1"
}

named="$(jq -r '.["ticket-branch-repository"] // "" | sub("\\.git$"; "") | sub("/$"; "") | split("/") | last // ""' <<< "$found")"
[[ "$named" =~ ^[A-Za-z0-9._-]*$ ]] || named=""
vm="$(vm_of "$command" "$project" "$key" "$variation")" || exit 1
[[ -n "$vm" ]] || ends 3 "Not brought up to date: $key $variation has no VM" "Classify said $issue, but the ticket's branches are in its VM, and it has none."

# vm+workstation on a Lima VM: its repositories onto the ticket's branches first (step-end left them on master).
if [[ "$(dev_environments_mode "$command" "$project" 2> /dev/null)" == vm+workstation && $vm != *:* ]]; then
  "$agent" vm:step-start "$project" "$key" "$variation" > /dev/null 2>&1 || log "vm:step-start failed; the branches are checked out as needed instead."
fi

# 1. The base brought in.
caught="$(catch_up_base "$command" "$project" "$key" "$variation" "$vm" no "$named")"
if [[ -n "$named" && "$caught" == '[]' ]]; then caught="$(catch_up_base "$command" "$project" "$key" "$variation" "$vm" no)"; fi
[[ "$caught" == '[]' ]] || log "Brought origin/<base> into the ticket's branches (Classify: $issue${named:+, $named}):"$'\n'"$(catch_up_lines "$caught")"

# 2. Numbered files: each that collides renamed to the number the check gives.
# A branch whose base could not be brought in is left to Generate Solution whole: it re-checks its numbered files after
# its own rebase, so none is renamed (and pushed) here first.
hard="$(jq -c '[.[] | select(.status | IN("conflict", "not-mechanical"))]' <<< "$caught")"
renumbered='[]' numbered_why="" code=0
if [[ "$hard" != '[]' ]]; then code=0; checked='{}'
  log "The numbered files are left to Generate Solution, which re-checks them after bringing the base in."
else checked="$("$agent" merge-request:check-numbered-files "$project" "$key" "$variation" 2> /dev/null)" || code=$?; fi
if [[ $code -eq 1 ]]; then
  tests="$(work_path "$command" "$project" "$key" "$variation" "automated-tests-$variation.json" 2> /dev/null)" || tests=""
  while IFS= read -r c; do
    IFS=$'\t' read -r repo branch base file to reason < <(jq -r '[.repository, .branch, .base, .file, .["rename-to"], .reason] | @tsv' <<< "$c")
    r="$(renumber_file "$command" "$project" "$key" "$vm" "$repo" "$branch" "$base" "$file" "$to" "$reason")"
    if [[ "$(jq -r .status <<< "$r")" == renumbered && -n "$tests" && -f "$tests" ]] \
        && rewritten="$(rewrite_references "$file" "$to" < "$tests")" && [[ "$rewritten" != "$(cat "$tests")" ]]; then
      if jq -e . <<< "$rewritten" > /dev/null 2>&1 && "$agent" automated-tests:record "$project" "$key" "$variation" <<< "$rewritten" > /dev/null 2>&1; then
        r="$(jq -c --arg t "automated-tests-$variation.json" '.files += [$t]' <<< "$r")"
      else r="$(jq -c '.detail += "; automated-tests could not be recorded again"' <<< "$r")"; fi
    fi
    renumbered="$(jq -c --argjson c "$c" --argjson r "$r" '. + [{ repository: $c.repository, branch: $c.branch, file: $c.file, "rename-to": $c["rename-to"], reason: $c.reason, status: $r.status, detail: $r.detail, references: $r.files }]' <<< "$renumbered")"
  # Highest number first: a chain (10 → 11, 11 → 12) frees each name before the next rename takes it.
  done < <(jq -c '.collisions | sort_by(.repository, .branch, (0 - (.number // 0))) | .[]' <<< "$checked")
  log "Renumbered the numbered files whose number is taken:"$'\n'"$(jq -r '.[] | "- \(.repository) \(.branch): \(.file) → \(.["rename-to"]) (\(.reason)): \(.status) — \(.detail)\(if (.references | length) > 0 then "; references updated in \(.references | join(", "))" else "" end)"' <<< "$renumbered")"
  # The check again: what still collides is not mechanical.
  again=0; recheck_nf="$("$agent" merge-request:check-numbered-files "$project" "$key" "$variation" 2> /dev/null)" || again=$?
  if [[ $again -eq 1 ]]; then
    renumbered="$(jq -c --argjson still "$(jq -c '.collisions' <<< "$recheck_nf")" '. + [$still[] | { repository, branch, file, "rename-to": .["rename-to"], reason, status: "still-collides", detail: "still collides after the renames", references: [] }]' <<< "$renumbered")"
  fi
elif [[ $code -ne 0 ]]; then numbered_why="merge-request:check-numbered-files could not check (exit $code)"
  log "The numbered files were not checked: $numbered_why."
fi

hard_files="$(jq -c '[.[] | select(.status | IN("not-mechanical", "still-collides"))]' <<< "$renumbered")"
trouble="$(jq -c --argjson n "$renumbered" '[(.[], $n[]) | select(.status | IN("fetch-failed", "push-failed"))]' <<< "$caught")"
moved="$(jq -c --argjson n "$renumbered" '[(.[] | select(.status | IN("rebased", "merged"))), ($n[] | select(.status == "renumbered"))] | length' <<< "$caught")"
extra="$(jq -nc --argjson c "$caught" --argjson n "$renumbered" '{ "caught-up": $c, renumbered: $n }')"

# Not mechanical: back to Generate Solution with what to do, the branches left as they were.
if [[ "$hard" != '[]' || "$hard_files" != '[]' ]]; then
  found_variation="$(variation_field . "$command" "$project" "$key" "$variation")"
  engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
  resume="$(jq -nc --arg project "$project" --arg ticket "$key" --argjson variation "$found_variation" --arg engine "$engine" \
    --argjson files "$(engine_files "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')" \
    '{ project: $project, ticket: $ticket, variation: $variation, engine: $engine, engineFiles: $files, declared: "generate-solution",
       declaredBy: "Blocked'"'"'s base catch-up (ASS-509) declares" }' | node "$here_vm/ticket/fix-resume-step.js")"
  attempt="$(jq -r '(.["own-branch-fixes"] // 0) + (.["base-catch-ups"] // 0) + 1' <<< "$found")"
  section="$(jq -nr --arg at "$(date -u +%Y-%m-%d)" --arg v "$variation" --arg n "$attempt" --argjson hard "$hard" --argjson files "$hard_files" --argjson found "$found" '
    "## Own-branch fix (\($at), Blocked, variation \($v), attempt \($n))\n",
    "Blocked: \($found.summary // "not said"). Cause: \($found["root-cause"] // "not said"). Classify: \($found.issue // "?") — \($found.reasoning // "not said")",
    (if $hard != [] then "Bring the base in first — Blocked could not do it mechanically, and left each branch as it was:\n" + ($hard | map("- \(.repository) \(.branch): \(.detail)") | join("\n"))
       + "\nStep added: in each, git fetch origin and bring the latest origin/<base> in, resolving the conflicts as Conflicts says (merge-request:conflicting-tickets names the tickets whose changes they are), re-check the numbered files, and push." else empty end),
    (if $files != [] then "Renumber — Blocked could not do it mechanically:\n" + ($files | map("- \(.repository) \(.branch): \(.file) → \(.["rename-to"]) (\(.reason)): \(.detail)") | join("\n"))
       + "\nStep added: rename each as the numbered files check says (git mv, every reference, the recorded automated tests through automated-tests:record), push." else empty end),
    "No project bug raised, no ticket scope added. Then carry on with this plan'"'"'s own work."')"
  plan="$(ticket_folder "$command" "$project" "$key")/execution-plan-$variation.md"
  [[ ! -s "$plan" ]] || section=$'\n'"$section"
  append_line "$plan" "$section"
  log "Not mechanical: back to Generate Solution, the finding in execution-plan-$variation.md's Own-branch fix section."
  jq -c --argjson extra "$extra" --arg plan "execution-plan-$variation.md" '{ "own-branch-fix": true, "own-branch-source": "behind-base-conflict",
    "own-branch-why": "the base could not be brought in, or a numbered file renamed, mechanically: Generate Solution does it", "plan-revised": $plan } + $extra + . + { "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$resume"
  exit 0
fi

if [[ "$trouble" != '[]' || ( -n "$numbered_why" && "$issue" == numbered-file-taken ) ]]; then
  ends 5 "Not brought up to date: $(jq -r 'map(.status) | unique | join(", ")' <<< "$trouble")${numbered_why:+ $numbered_why}" \
    "Blocked tried to bring the base into $key $variation's branches and rename its numbered files, but: $(jq -r 'map("\(.repository) \(.branch): \(.detail)") | join("; ")' <<< "$trouble")${numbered_why:+; $numbered_why}. Each branch is as it was before. Check the VM's forge access (git fetch and push in /repos/<repository>), then have AI try again." "$extra"
fi
if [[ "$moved" -eq 0 ]]; then
  ends 3 "Not borne out: nothing to bring in, no numbered file taken" \
    "Classify said $issue, but each of $key $variation's branches has every commit of its origin/<base> and no numbered file it adds collides$(if [[ "$caught" != '[]' ]]; then printf ' (%s)' "$(jq -r 'map("\(.repository) \(.branch): \(.status)") | join("; ")' <<< "$caught")"; fi)${numbered_why:+; $numbered_why}. Read change-log-$variation.md's Troubleshoot and Classify entries." "$extra"
fi

# Brought up to date: the blocked step's check re-run.
rc=0
recheck="$(RECHECK_STEP="$step" RECHECK_NEXT_PASS="The ticket resumes where it was blocked." RECHECK_NEXT_FAIL="On to Troubleshoot again, on the branch as it is now." \
  RECHECK_NEXT_NONE="The ticket resumes where it was blocked, its step the check." "$agent" ticket:recheck-block "$project" "$key" "$variation" 2> /dev/null)" || rc=$?
[[ -n "$recheck" ]] || recheck='{}'
source_="behind-base"; [[ "$(jq '[.[] | select(.status == "renumbered")] | length' <<< "$renumbered")" -eq 0 ]] || source_="numbered-file"
if [[ $rc -eq 0 || "$(jq -r '.rechecked == false' <<< "$recheck")" == true ]]; then
  jq -nc --argjson extra "$extra" --argjson r "$recheck" --arg s "$source_" '{ "own-branch-fix": true, "own-branch-source": $s,
    "own-branch-why": ((if $s == "numbered-file" then "a numbered file whose number was taken renamed, and pushed" else "its branch brought up to date with its base, and pushed" end)
      + (if $r.rechecked == true then "; the blocked step'"'"'s check passes now" else "; the blocked step runs again as its check" end)) }
    + $extra + { recheck: ($r.recheck // null), "ai-feedback-short": null, "ai-feedback-long": null }'
  exit 0
fi
jq -nc --argjson extra "$extra" --argjson r "$recheck" '{ "own-branch-fix": false, "base-caught-up": true,
  "own-branch-why": "brought up to date, but the blocked step'"'"'s check still fails" } + $extra + { recheck: ($r.recheck // null) }'
echo "$command: brought up to date, but the blocked step's check still fails: on to Troubleshoot" >&2
exit 4
