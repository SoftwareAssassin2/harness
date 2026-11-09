#!/usr/bin/env bash
# Description: Run the merge-request CI checks the project declares, in the variation's VM, for each repository the ticket changes; pass when each passes or fails only as on master — ci-checks:verify <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-249. The grouped Build's CI Checks step, between Automated Testing and
# Code Review: the gates a merge request's CI would fail (a leaked secret, an
# unpinned image, a policy violation) run in the VM first, so a failure goes
# back to Generate Solution before the merge request reaches the forge.
#
# The checks are declared in ci-checks.json in the project's golden-image
# folder (project.json golden-image.folder, beside tests.json), each
# repository by its basename:
#   { "repositories": { "<basename>": [
#       { "name": "<the CI job it mirrors>",
#         "command": "<bash, run in /repos/<basename>>",
#         "changes": ["<glob>", …],     optional: run only when the merge request's diff touches one, as CI's rules:changes —
#                                       ** any folders, * and ? within one, {a,b} either; matched from the repository's root
#         "baseline": false } ] } }     optional: a check over the merge request's own commits (a secret scan of
#                                       $CI_CHECK_BASE..HEAD) has no master run to compare with
# A project without the file (or without a golden-image folder) declares no
# checks, and a repository not in it none: this passes with nothing run —
# grouped-build is shared by every grouped project. A file that is not this
# shape, or names a repository not project.json's, fails (exit 3), naming the
# problem: a declaration no code change fixes.
#
# For each repository with a merge request not Closed (ticket:merge-request-plan)
# that declares checks, in its checkout in the VM (/repos/<basename>) as it
# stands — the branch Generate Solution left there, changes not committed
# included — every check runs (in_project, through limactl), all of them,
# whatever the ones before did, with CI_CHECK_BASE exported: the merge base of
# HEAD and origin/<base> (the merge request on the branch checked out there, else
# its first; base origin's default branch when none is recorded yet). A check
# whose changes globs match none of the files changed since CI_CHECK_BASE
# (committed, not committed, or new and untracked) is skipped.
#
# A check that fails is compared with its run on master, as
# automated-tests:verify-success's are (ASS-99): the repository switched to
# origin/<base>'s commit, detached, CI_CHECK_BASE that commit, and back; the
# run recorded in ci-checks-baseline-<variation>.json by master's SHA, and run
# again only when master moves. test-results.js judges the two: a failure
# master has too — the same named tests, or red on master too with none named
# — passes, as failing as it does on master; any other is new. A baseline:
# false check is never run on master: red is a new failure. Checks are not
# re-run: a lint or a scan is not flaky.
#
# Each check's job name, command, exit code and output (its last
# $TAIL lines; master's too when compared) go to the ticket's folder,
# ci-checks-results-<variation>.md, replaced each run, for Generate Solution
# and Security Review to read; both it and the baseline are WORK_MANAGED.
# Prints { passed, failed, skipped } and exits 0 when no run check failed but
# as on master; 1 on a new failure (→ Generate Solution); 3 when a check could
# not run — exit 125/126/127, verify-success's NOT_RUNNABLE output, master's
# run refused (changes not committed) — or the step could not (no VM, the
# declaration malformed) (→ Blocked).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../automated-tests.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"
judge_js="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../automated-tests/test-results.js"
command=ci-checks:verify
TAIL=200

[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "$command: no project '$project'" >&2; exit 3; }
fail() { echo "$command: $*" >&2; exit 3; }
results="$(work_path "$command" "$project" "$key" "$variation" "ci-checks-results-$variation.md" 2> /dev/null)" || results=""
baseline="${results%/*}/ci-checks-baseline-$variation.json"
heading="# CI check results — $key $variation, $(date -u +%Y-%m-%dT%H:%M:%SZ)"$'\n'
write_results() {
  [[ -n "$results" ]] || return 0
  lock_on 9 "$results.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}" && printf '%s' "$1" | replace_file "$results" || echo "$command: could not write $results" >&2
}
nothing() { write_results "$heading"$'\n'"Nothing run: $1."$'\n'; jq -nc '{ passed: 0, failed: 0, skipped: 0 }'; exit 0; }

# The declaration, checked whole before anything runs.
json="$projects/$project/project.json"
folder="$(jq -r '.["golden-image"].folder // empty' "$json")"
[[ -z "$folder" || "$folder" == /* ]] || folder="$projects/../$folder"
declared="${folder:+$folder/ci-checks.json}"
[[ -n "$declared" && -f "$declared" ]] || nothing "$project declares no CI checks (no ci-checks.json in its golden-image folder)"
jq empty "$declared" 2> /dev/null || fail "$declared: ci-checks.json is not valid JSON"
problem="$(jq -r --argjson repos "$(jq -c '[.repositories[]?.url | sub("\\.git$"; "") | split("/") | last]' "$json")" --arg project "$project" '
  def check($at):
    if type != "object" then "\($at) must be an object"
    elif (.name | type) != "string" or .name == "" then "\($at): \"name\" must be a non-empty string"
    elif (.command | type) != "string" or .command == "" then "\($at): \"command\" must be a non-empty string"
    elif has("changes") and ((.changes | type) != "array" or .changes == [] or any(.changes[]; type != "string" or . == "")) then "\($at): \"changes\" must be a list of globs"
    elif has("baseline") and (.baseline | type) != "boolean" then "\($at): \"baseline\" must be true or false"
    elif (keys - ["name", "command", "changes", "baseline"]) != [] then "\($at): unknown key \"\((keys - ["name", "command", "changes", "baseline"])[0])\""
    else empty end;
  first(
    if type != "object" or (.repositories | type) != "object" then "ci-checks.json: \"repositories\" must be an object of <repository>: [<check>…]"
    else .repositories | to_entries[] | .key as $r
      | if IN($repos[]; $r) | not then "ci-checks.json names \($r), not one of \($project)'"'"'s repositories: \($repos | join(", "))"
        elif (.value | type) != "array" then "repositories.\($r) must be a list of checks"
        else .value | to_entries[] | .key as $i | .value | check("repositories.\($r)[\($i)]") end
    end) // empty' "$declared")"
[[ -z "$problem" ]] || fail "$declared: $problem"

# The repositories the ticket changes that declare checks: each with its merge requests not Closed.
plan="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")" || exit 3
mapfile -t repos < <(jq -r --slurpfile d "$declared" '
  [.[] | select(.status != "Closed") | .repository | sub("\\.git$"; "") | split("/") | last] | unique[]
  | select(($d[0].repositories[.] // []) != [])' <<< "$plan")
[[ ${#repos[@]} -gt 0 ]] || nothing "no repository the ticket changes declares a CI check"
[[ -n "$results" ]] || fail "$key has no work folder in $project"
vm="$(vm_of "$command" "$project" "$key" "$variation")" || exit 3
[[ -n "$vm" ]] || fail "$key $variation has no VM: CI checks run in it"

# The checkout's git, run in /repos/<repository> in the VM: `head` prints the
# branch checked out (HEAD when detached) and origin's default branch; `base
# <branch>` origin/<branch>'s SHA, the merge base, then each file changed since
# it; `to <sha>` switches to it, detached, printing where it was — refusing
# when a tracked file has changes not committed; `back <ref>` returns.
GIT='set -euo pipefail
case "$1" in
  head) git symbolic-ref -q --short HEAD || echo HEAD; ref="$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)"; echo "${ref#origin/}" ;;
  base) git rev-parse -q --verify "origin/$2^{commit}" || { echo "no origin/$2" >&2; exit 1; }
    mb="$(git merge-base HEAD "origin/$2")" || { echo "no merge base with origin/$2" >&2; exit 1; }; echo "$mb"
    { git diff --name-only "$mb"; git ls-files --others --exclude-standard; } | sort -u ;;
  to) [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "changes not committed" >&2; exit 1; }
    git symbolic-ref -q --short HEAD || git rev-parse HEAD; git checkout -q --detach "$2" ;;
  back) git checkout -q "$2" ;;
esac'
in_repo() { local repo="$1"; shift; in_project "$command" "$project" "/repos/$repo" "set -- $(printf '%q ' "$@"); $GIT" "$vm"; }

tmp="$(mktemp -d)"
restore=()
cleanup() { [[ ${#restore[@]} -eq 0 ]] || in_repo "${restore[0]}" back "${restore[1]}" > /dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT

# run_check <repository> <command> <base SHA> <output file> — prints its exit code.
run_check() { local status=0; in_project "$command" "$project" "/repos/$1" "export CI_CHECK_BASE=$3; $2" "$vm" > "$4" 2>&1 || status=$?; echo "$status"; }
block() { local lines; lines="$(wc -l < "$1" | tr -d ' ')"; [[ $lines -le $TAIL ]] || printf '\n(the last %s of %s lines)' "$TAIL" "$lines"; printf '\n```\n%s\n```\n' "$(tail -n "$TAIL" "$1")"; }
# matches <files> <globs> — whether a file (one per line) matches a glob (a JSON list), as CI's rules:changes does.
matches() {
  jq -e -n --rawfile files "$1" --argjson globs "$2" '
    def re: gsub("(?<c>[.+()|^$\\[\\]\\\\])"; "\\\(.c)") | gsub("\\{(?<a>[^{}]*)\\}"; "(" + (.a | gsub(","; "|")) + ")")
      | gsub("\\*\\*/"; "\u0001") | gsub("\\*\\*"; "\u0002") | gsub("\\*"; "[^/]*") | gsub("\\?"; "[^/]")
      | gsub("\u0001"; "(.*/)?") | gsub("\u0002"; ".*") | "^\(.)$";
    ($globs | map(re)) as $res | any($files | split("\n")[] | select(. != ""); . as $f | any($res[]; . as $r | $f | test($r)))' > /dev/null
}

passed=0 failed=0 skipped=0 unrunnable=0 total=0
report="$heading"
for repo in "${repos[@]}"; do
  checks="$(jq -c --arg r "$repo" '.repositories[$r]' "$declared")"
  n="$(jq length <<< "$checks")"
  could_not() { unrunnable=$((unrunnable + n)) total=$((total + n)); report+=$'\n'"## ⚠ $repo: could not run its $n check(s): $1"$'\n'; }
  if ! in_repo "$repo" head > "$tmp/head" 2>&1; then could_not "$(tr '\n' ' ' < "$tmp/head")"; continue; fi
  { read -r branch; read -r default; } < "$tmp/head"
  base="$(jq -r --arg r "$repo" --arg b "$branch" --arg d "$default" '
    [.[] | select(.status != "Closed" and (.repository | sub("\\.git$"; "") | split("/") | last) == $r)] | sort_by(.id)
    | (first(.[] | select(.branch == $b)) // first) | .base // $d' <<< "$plan")"
  if ! in_repo "$repo" base "$base" > "$tmp/base" 2>&1; then could_not "$(tr '\n' ' ' < "$tmp/base")"; continue; fi
  master="$(sed -n 1p "$tmp/base")" merge_base="$(sed -n 2p "$tmp/base")"
  sed '1,2d' "$tmp/base" > "$tmp/changed"
  report+=$'\n'"CI_CHECK_BASE for $repo: $merge_base (the merge base of $branch and origin/$base)"$'\n'

  # The branch's runs.
  statuses=() red=()
  for ((i = 0; i < n; i++)); do
    check="$(jq -c ".[$i]" <<< "$checks")"
    globs="$(jq -c '.changes // empty' <<< "$check")"
    if [[ -n "$globs" ]] && ! matches "$tmp/changed" "$globs"; then statuses[i]=skip; continue; fi
    statuses[i]="$(run_check "$repo" "$(jq -r .command <<< "$check")" "$merge_base" "$tmp/branch-$i")"
    [[ ${statuses[i]} -eq 0 || "$(jq -r '.baseline != false' <<< "$check")" != true ]] || ! runnable "${statuses[i]}" "$tmp/branch-$i" || red+=("$i")
  done

  # Master's runs of the red ones: those recorded for master's SHA, the rest run now.
  baseline_error=""
  if [[ ${#red[@]} -gt 0 ]]; then
    if ! jq -e --arg r "$repo" --arg sha "$master" '.[$r].master == $sha' "$baseline" > /dev/null 2>&1; then
      was="$(jq -c 'objects' "$baseline" 2> /dev/null || true)"; [[ -n "$was" ]] || was='{}'
      jq --arg r "$repo" --arg sha "$master" '.[$r] = { master: $sha, checks: {} }' <<< "$was" | replace_file "$baseline"
    fi
    missing=()
    for i in "${red[@]}"; do jq -e --arg r "$repo" --arg c "$(jq -r ".[$i].command" <<< "$checks")" '.[$r].checks | has($c)' "$baseline" > /dev/null || missing+=("$i"); done
    if [[ ${#missing[@]} -gt 0 ]]; then
      if ! from="$(in_repo "$repo" to "$master" 2> "$tmp/error")"; then baseline_error="could not check out origin/$base: $(tr '\n' ' ' < "$tmp/error")"
      else
        restore=("$repo" "$from")
        for i in "${missing[@]}"; do
          c="$(jq -r ".[$i].command" <<< "$checks")"
          status="$(run_check "$repo" "$c" "$master" "$tmp/master-$i")"
          tail -n "$TAIL" "$tmp/master-$i" > "$tmp/master-tail"
          jq --arg r "$repo" --arg c "$c" --argjson status "$status" --rawfile output "$tmp/master-tail" '.[$r].checks[$c] = { status: $status, output: $output }' "$baseline" | replace_file "$baseline"
        done
        in_repo "$repo" back "$from" > /dev/null
        restore=()
      fi
    fi
  fi

  for ((i = 0; i < n; i++)); do
    check="$(jq -c ".[$i]" <<< "$checks")" status="${statuses[i]}" out="$tmp/branch-$i"
    name="$(jq -r .name <<< "$check")" c="$(jq -r .command <<< "$check")"
    total=$((total + 1))
    if [[ $status == skip ]]; then
      skipped=$((skipped + 1)); report+=$'\n'"## – $repo: $name (skipped: the merge request changes none of $(jq -r '.changes | join(", ")' <<< "$check"))"$'\n'; continue
    fi
    body=$'\n`'"$c"$'`\n'"$(block "$out")"
    if [[ $status -eq 0 ]]; then passed=$((passed + 1)); report+=$'\n'"## ✓ $repo: $name (exit 0)"$'\n'"$body"; continue; fi
    if ! runnable "$status" "$out"; then unrunnable=$((unrunnable + 1)); report+=$'\n'"## ⚠ $repo: $name (exit $status: could not run)"$'\n'"$body"; continue; fi
    if [[ "$(jq -r '.baseline != false' <<< "$check")" != true ]]; then
      failed=$((failed + 1)); report+=$'\n'"## ✗ $repo: $name (exit $status)"$'\n\n'"New failure: the command exits $status (baseline: false — no master run)"$'\n'"$body"; continue
    fi
    if [[ -n "$baseline_error" ]]; then unrunnable=$((unrunnable + 1)); report+=$'\n'"## ⚠ $repo: $name (exit $status: no master run to compare with: $baseline_error)"$'\n'"$body"; continue; fi
    master_status="$(jq --arg r "$repo" --arg c "$c" '.[$r].checks[$c].status' "$baseline")"
    jq -j --arg r "$repo" --arg c "$c" '.[$r].checks[$c].output' "$baseline" > "$tmp/master-$i"
    on_master=$'\n'"### On master (exit $master_status)"$'\n'"$(block "$tmp/master-$i")"
    verdict="$(node "$judge_js" "$master_status" "$tmp/master-$i" "$status" "$out")"
    case "$(jq -r .verdict <<< "$verdict")" in
      passed|blocked) passed=$((passed + 1))
        listed="$(jq -r '.["pre-existing"][] | "- \(.)"' <<< "$verdict")"
        [[ -z "$listed" ]] || listed=$'\n\n'"Pre-existing failures, failing on master too:"$'\n'"$listed"
        report+=$'\n'"## ✓ $repo: $name (exit $status: fails as it does on master)$listed"$'\n'"$body$on_master" ;;
      failed) failed=$((failed + 1))
        new="$(jq -r 'if (.new | length) == 1 then "New failure: \(.new[0])" else "New failures, not failing on master:\n" + (.new | map("- \(.)") | join("\n")) end' <<< "$verdict")"
        report+=$'\n'"## ✗ $repo: $name (exit $status)"$'\n\n'"$new"$'\n'"$body$on_master" ;;
    esac
  done
done
write_results "$report"
[[ $unrunnable -eq 0 ]] || { echo "$command: could not run $unrunnable of $total: an environment problem, not a failed check; see $results" >&2; exit 3; }
[[ $failed -eq 0 ]] || { echo "$command: $failed of $total failed; see $results" >&2; exit 1; }
jq -nc --argjson p "$passed" --argjson s "$skipped" '{ passed: $p, failed: 0, skipped: $s }'
