#!/usr/bin/env bash
# Description: Run the ticket's automated tests; pass when every one passes, or fails only as it does on master — automated-tests:verify-success <project> <ticket-key> <variation>.
set -euo pipefail

# Runs every test's run command (see automated-tests.bash) in the variation's
# worktree (in_project: in the dev container when the project has one), all of them, whatever the ones before did: the test runner's exit
# code decides, no LLM judges it. Each command, its exit code and its output
# go to the ticket's folder, automated-test-results-<variation>.md (replaced
# each run), for the next agent to read. Prints { passed, failed } and exits
# 0 when every one exits 0; else fails, saying how many failed. A command
# that could not run at all — its dev container unavailable (exit 125), not
# found or not executable (exit 126/127), or
# its dependencies or a credential missing (NOT_RUNNABLE below) — is no failed test: the run
# exits 3, an environment problem for Blocked, not code to fix. The tests not
# recorded — no automated-tests-<variation>.json at all — exits 4 (ASS-162):
# the grouped/v2 Build engines send that back to Generate Automated Tests,
# which writes it; the flat engines, routing any exit but 0 and 3 to
# generate-solution, are unchanged. Any other failure exits 1.
#
# A command that fails is compared with its run on master (ASS-99), so a suite
# already red on master does not send the ticket back to generate-solution for
# ever: the same command run in the same place with the checkout switched to
# master's commit — origin's default branch, as last fetched; in a VM every
# repository in /repos/ — and back, its exit code and output recorded in the
# ticket's folder, automated-test-baseline-<variation>.json, by master's SHA,
# and run again only when master moves. test-results.js judges the two: when
# every failed test (or aborted file) is one master has too, the command
# passes — the pre-existing failures named in the results, and printed as
# pre-existing — else it is re-run once, and fails only on a new failure that
# fails again. A command whose output names no test, red on master too, exits
# 3 for a human, the results holding both outputs: like the environment
# problem, it routes to Blocked, so it shares that exit (ASS-227 AC3). A
# checkout with changes not committed to a tracked file is never switched: exit
# 3; an untracked file (a __pycache__/) is no change, the detached checkout
# leaving it be.
#
# A test marked "reproduces": true (ASS-227) is red on master by design — it
# reproduces the ticket's bug — so it is not run on master: red on the branch,
# and again on a re-run, it failed (exit 1, for Generate Solution, whose
# max-visits caps it), named tests or none.
#
# Every run that gets as far as its tests records them on the variation's
# local-testing (ASS-241): number-of-relevant-automated-tests, the commands
# run, and number-of-passing-relevant-automated-tests, those that passed —
# the "x/y automated tests" line (src/tui/ticket.js testCounts).
#
# Each run of a command — on the branch, on master, the re-run — is stopped
# once it passes project.json's automated-test-run-minutes (ASS-329: absent,
# 30; null, none; time_limited in automated-tests.bash), with everything it
# started, in the VM or dev container too. A run stopped so failed — never
# "could not run" — its results saying "timed out after N minutes", with its
# output up to then and, where that shows it, what was running (node --test's
# file or test). test-results.js judges it as any failure with no test to
# compare: timed out on the branch with master finishing inside the limit, a
# new failure (re-run once, then exit 1); timed out on master too, exit 3,
# both outputs in the results. Master's run that timed out is recorded as
# such, and run again next time, never kept.
#
# A recorded test gone stale since it was recorded goes back to Generate
# Automated Tests (exit 4, as a missing list does) to be recorded again, not
# to Generate Solution or Blocked (ASS-353): a run command that brings a
# docker compose stack up reusing an earlier run's volumes (compose-reset.js;
# automated-tests:record refuses one now, this catches one recorded before)
# is not run at all, its database possibly carrying migrations a later step
# renumbered; and a run that fails whose list command fails too — got as far
# as running, not "could not run" — names a test file no longer there, moved
# or renumbered by a later step, so its failure is the record's, not the
# code's: neither is compared with master, both named in the results.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../automated-tests.bash"
judge_js="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/test-results.js"
compose_js="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/compose-reset.js"

[[ $# -eq 3 ]] || { echo "usage: automated-tests:verify-success <project> <ticket-key> <variation>" >&2; exit 1; }
key="$(upper "$2")"
tests_setup automated-tests:verify-success "$1" "$key" "$3"
minutes="$(run_minutes automated-tests:verify-success "$1")" || exit 3
baseline="${results%/*}/automated-test-baseline-$3.json"

# ASS-353: a recorded run command reusing its compose stack's volumes is recorded again before anything runs.
reusing="$(node "$compose_js" <<< "$tests")"
if [[ -n "$reusing" ]]; then
  report="# Automated test results — $key $3, $(date -u +%Y-%m-%dT%H:%M:%SZ)"$'\n'
  while IFS= read -r command; do
    report+=$'\n'"## ↻ $command (not run: record it again)"$'\n\n'"It brings a docker compose stack up reusing the volumes an earlier run left, its database possibly carrying migrations since renamed or renumbered: run \`docker compose down -v\` first in it (or use a per-run-unique COMPOSE_PROJECT_NAME), so each run starts from a fresh database."$'\n'
  done <<< "$reusing"
  printf '%s' "$report" | replace_file "$results"
  echo "automated-tests:verify-success: $(wc -l <<< "$reusing" | tr -d ' ') of $(jq length <<< "$tests") reuse a docker compose stack's volumes across runs: for Generate Automated Tests to record again; see $results" >&2
  exit 4
fi

# The checkout's git, run where the tests run (in the VM, every repository in
# /repos/; else the folder, on the Mac): `key` prints master's SHA (each
# repository's, by name, in a VM); `to-master` switches each repository not at
# master's commit to it, detached, printing "<repository> <where it was>" for
# `back <repository> <ref>…`; it refuses, changing nothing, when one has
# changes not committed or cannot be switched.
CHECKOUT='set -euo pipefail
repos() { if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then echo .; else for d in */; do [ -e "$d.git" ] && echo "${d%/}"; done; fi; return 0; }
master() { local ref; ref="$(git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)"; git -C "$1" rev-parse -q --verify "$ref^{commit}" || { echo "$1: no $ref" >&2; return 1; }; }
case "$1" in
  key) repos | while read -r r; do sha="$(master "$r")"; if [ "$r" = . ]; then echo "$sha"; else echo "$r@$sha"; fi; done | paste -sd " " - ;;
  to-master)
    moving=() switched=()
    while read -r r; do [ "$(git -C "$r" rev-parse HEAD)" = "$(master "$r" 2> /dev/null)" ] || moving+=("$r"); done < <(repos)
    for r in ${moving[@]+"${moving[@]}"}; do [ -z "$(git -C "$r" status --porcelain --untracked-files=no)" ] || { echo "$r has changes not committed" >&2; exit 1; }; done
    for r in ${moving[@]+"${moving[@]}"}; do
      from="$(git -C "$r" symbolic-ref -q --short HEAD || git -C "$r" rev-parse HEAD)"
      sha="$(master "$r")" && git -C "$r" checkout -q --detach "$sha" || {
        for s in ${switched[@]+"${switched[@]}"}; do git -C "${s%% *}" checkout -q "${s#* }"; done
        echo "$r: could not check out master" >&2; exit 1; }
      switched+=("$r $from")
    done
    for s in ${switched[@]+"${switched[@]}"}; do echo "$s"; done ;;
  back) shift; while [ $# -gt 0 ]; do git -C "$1" checkout -q "$2"; shift 2; done ;;
esac'
in_checkout() {
  if [[ -n "$vm" ]]; then LIMA_HOME="$(lima_home)" limactl shell --workdir "$where" "$vm" -- bash -c "$CHECKOUT" checkout "$@" < /dev/null
  else (cd "$where" && bash -c "$CHECKOUT" checkout "$@") < /dev/null; fi
}

tmp="$(mktemp -d)"
restore=()
cleanup() { [[ ${#restore[@]} -eq 0 ]] || in_checkout back "${restore[@]}" || true; rm -rf "$tmp"; }
trap cleanup EXIT

# run_test <project> <command> <output file> — runs it, inside the time limit, its output (both streams) to the file; prints its exit code.
run_test() { local status=0; in_project automated-tests:verify-success "$1" "$where" "$(time_limited "$minutes" "$2")" "$vm" > "$3" 2>&1 || status=$?; echo "$status"; }
# timed_out <exit code> <output file> — "timed out after N minutes[, in …]" for a run stopped at the limit; else fails.
timed_out() { local why; [[ $1 -eq 124 ]] && why="$(node "$judge_js" timed-out "$1" "$2")" && [[ -n "$why" ]] && echo "$why"; }
# ran <exit code> <output file> — whether the run got as far as a test: stopped at the limit, it did.
ran() { timed_out "$1" "$2" > /dev/null || runnable "$1" "$2"; }
# exit_of <exit code> <output file> — the run's exit, as the results put it.
exit_of() { local why; if why="$(timed_out "$1" "$2")"; then echo "exit $1: $why"; else echo "exit $1"; fi; }
block() { printf '\n```\n%s\n```\n' "$(cat "$1")"; }

mapfile -t commands < <(jq -r '.[].run' <<< "$tests")
mapfile -t lists < <(jq -r '.[].list' <<< "$tests")
mapfile -t reproduces < <(jq -r '.[].reproduces == true' <<< "$tests")
statuses=() red=() stale=()
for i in "${!commands[@]}"; do
  statuses[i]="$(run_test "$1" "${commands[i]}" "$tmp/branch-$i")"
  [[ ${statuses[i]} -ne 0 ]] || continue
  # ASS-353: red, its list failing too (and running) — the recorded file gone: stale, not red.
  listed="$(run_test "$1" "${lists[i]}" "$tmp/list-$i")"
  if [[ $listed -ne 0 ]] && runnable "$listed" "$tmp/list-$i"; then stale[i]="$listed"; continue; fi
  [[ ${reproduces[i]} == true ]] || ! ran "${statuses[i]}" "$tmp/branch-$i" || red+=("$i")
done

# Master's runs of the red commands: the ones recorded for master's SHA, the rest run now.
baseline_error=""
if [[ ${#red[@]} -gt 0 ]]; then
  if ! sha="$(in_checkout key 2> "$tmp/error")"; then baseline_error="$(cat "$tmp/error")"
  else
    [[ -f "$baseline" ]] && jq -e --arg sha "$sha" '.master == $sha' "$baseline" > /dev/null 2>&1 || jq -n --arg sha "$sha" '{ master: $sha, tests: {} }' | replace_file "$baseline"
    missing=()
    for i in "${red[@]}"; do jq -e --arg run "${commands[i]}" '.tests[$run] | . != null and (.["timed-out"] | not)' "$baseline" > /dev/null || missing+=("$i"); done
    if [[ ${#missing[@]} -gt 0 ]]; then
      if ! switched="$(in_checkout to-master 2> "$tmp/error")"; then baseline_error="$(cat "$tmp/error")"
      else
        [[ -z "$switched" ]] || read -ra restore <<< "$(tr '\n' ' ' <<< "$switched")"
        for i in "${missing[@]}"; do
          status="$(run_test "$1" "${commands[i]}" "$tmp/master-$i")"
          timed=false; ! timed_out "$status" "$tmp/master-$i" > /dev/null || timed=true
          jq --arg run "${commands[i]}" --argjson status "$status" --rawfile output "$tmp/master-$i" --argjson timed "$timed" \
            '.tests[$run] = { status: $status, output: $output } + if $timed then { "timed-out": true } else {} end' "$baseline" | replace_file "$baseline"
        done
        [[ ${#restore[@]} -eq 0 ]] || in_checkout back "${restore[@]}"
        restore=()
      fi
    fi
  fi
fi

passed=0 failed=0 unrunnable=0 blocked=0 gone=0
pre_existing='[]'
report="# Automated test results — $key $3, $(date -u +%Y-%m-%dT%H:%M:%SZ)"$'\n'
for i in "${!commands[@]}"; do
  command="${commands[i]}" status="${statuses[i]}" out="$tmp/branch-$i" extra=""
  if [[ $status -eq 0 ]]; then passed=$((passed + 1)); report+=$'\n'"## ✓ $command (exit 0)"$'\n'"$(block "$out")"$'\n'; continue; fi
  if [[ -n "${stale[i]:-}" ]]; then gone=$((gone + 1))
    report+=$'\n'"## ↻ $command ($(exit_of "$status" "$out"): its recorded test is gone, record it again)"$'\n\n'"Its list command fails too (exit ${stale[i]}), so the file it names was moved or renamed after it was recorded: \`${lists[i]}\`"$'\n'"$(block "$tmp/list-$i")"$'\n'"$(block "$out")"$'\n'; continue; fi
  if ! ran "$status" "$out"; then unrunnable=$((unrunnable + 1)); report+=$'\n'"## ⚠ $command (exit $status: could not run)"$'\n'"$(block "$out")"$'\n'; continue; fi
  master_status=- master=- new="New failures, failing again on a re-run:"
  if [[ ${reproduces[i]} != true ]]; then
    if [[ -n "$baseline_error" ]]; then unrunnable=$((unrunnable + 1)); report+=$'\n'"## ⚠ $command (exit $status: could not run master's tests: $baseline_error)"$'\n'"$(block "$out")"$'\n'; continue; fi
    master_status="$(jq --arg run "$command" '.tests[$run].status' "$baseline")" master="$tmp/master-$i" new="New failures, not failing on master, and failing again on a re-run:"
    jq -j --arg run "$command" '.tests[$run].output' "$baseline" > "$tmp/master-$i"
  fi
  verdict="$(node "$judge_js" "$master_status" "$master" "$status" "$out")" why="every failure is one master has too"
  if [[ "$(jq -r .verdict <<< "$verdict")" == failed ]]; then
    why="no new failure failed again on a re-run"
    rerun="$(run_test "$1" "$command" "$tmp/rerun-$i")"
    verdict="$(node "$judge_js" "$master_status" "$master" "$status" "$out" "$rerun" "$tmp/rerun-$i")"
    extra=$'\n'"### Re-run ($(exit_of "$rerun" "$tmp/rerun-$i"))"$'\n'"$(block "$tmp/rerun-$i")"$'\n'
  fi
  case "$(jq -r .verdict <<< "$verdict")" in
    passed) passed=$((passed + 1)); pre_existing="$(jq -c --argjson v "$verdict" '. + $v["pre-existing"]' <<< "$pre_existing")"
      listed="$(jq -r '.["pre-existing"][] | "- \(.)"' <<< "$verdict")"
      [[ -z "$listed" ]] || listed=$'\n\n'"Pre-existing failures, failing on master too:"$'\n'"$listed"
      report+=$'\n'"## ✓ $command ($(exit_of "$status" "$out"): $why)$listed"$'\n'"$(block "$out")"$'\n'"$extra" ;;
    failed) failed=$((failed + 1))
      report+=$'\n'"## ✗ $command ($(exit_of "$status" "$out"))"$'\n\n'"$new"$'\n'"$(jq -r '.new[] | "- \(.)"' <<< "$verdict")"$'\n'"$(block "$out")"$'\n'"$extra" ;;
    blocked) blocked=$((blocked + 1)) why="red on master too, with no test results to compare"
      ! timed_out "$master_status" "$tmp/master-$i" > /dev/null || why="timed out on master too, nothing to compare"
      report+=$'\n'"## ⚠ $command ($(exit_of "$status" "$out"): $why)"$'\n'"$(block "$out")"$'\n\n'"### On master ($(exit_of "$master_status" "$tmp/master-$i"))"$'\n'"$(block "$tmp/master-$i")"$'\n'"$extra" ;;
  esac
done
printf '%s' "$report" | replace_file "$results"
total=${#commands[@]}
update_whole_ticket automated-tests:verify-success "$1" "$key" --arg name "$3" --argjson passing "$passed" --argjson total "$total" '
  .variations |= map(if .name == $name then .["local-testing"] = ((.["local-testing"] // {} | if type == "object" then . else {} end)
    + { "number-of-relevant-automated-tests": $total, "number-of-passing-relevant-automated-tests": $passing }) else . end)' \
  || echo "automated-tests:verify-success: could not record the counts on the variation" >&2
[[ $gone -eq 0 ]] || { echo "automated-tests:verify-success: $gone of $total name a test no longer where it was recorded: for Generate Automated Tests to record again; see $results" >&2; exit 4; }
[[ $unrunnable -eq 0 ]] || { echo "automated-tests:verify-success: could not run $unrunnable of $total: an environment problem, not failed tests; see $results" >&2; exit 3; }
[[ $blocked -eq 0 ]] || { echo "automated-tests:verify-success: $blocked of $total red on master too, with no test results to compare: for a human; see $results" >&2; exit 3; }
[[ $failed -eq 0 ]] || { echo "automated-tests:verify-success: $failed of $total failed; see $results" >&2; exit 1; }
jq -nc --argjson p "$passed" --argjson pre "$pre_existing" '{ passed: $p, failed: 0 } + if $pre == [] then {} else { "pre-existing": $pre } end'
