#!/usr/bin/env bash
# Description: Check the ticket's automated tests exist and the runner finds them (they may fail) — automated-tests:verify-exist-and-runnable <project> <ticket-key> <variation>.
set -euo pipefail

# Runs each test's list command (see automated-tests.bash) in the variation's
# worktree: every one must exit 0 and print at least one test. Nothing is run,
# so tests written before the solution may fail. Prints { tests, listed:
# [<line>…] }. Fails, naming the command, when one fails or finds nothing, or
# when the tests are not recorded.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../automated-tests.bash"

[[ $# -eq 3 ]] || { echo "usage: automated-tests:verify-exist-and-runnable <project> <ticket-key> <variation>" >&2; exit 1; }
key="$(upper "$2")"
tests_setup automated-tests:verify-exist-and-runnable "$1" "$key" "$3"

listed=()
while IFS= read -r list; do
  status=0
  out="$(in_project automated-tests:verify-exist-and-runnable "$1" "$where" "$list" "$vm" 2>&1)" || status=$?
  [[ $status -eq 0 ]] || { echo "automated-tests:verify-exist-and-runnable: list command failed (exit $status): $list" >&2; echo "$out" >&2; exit 1; }
  [[ -n "${out//[[:space:]]/}" ]] || { echo "automated-tests:verify-exist-and-runnable: found no test: $list" >&2; exit 1; }
  while IFS= read -r line; do [[ -z "${line//[[:space:]]/}" ]] || listed+=("$line"); done <<< "$out"
done < <(jq -r '.[].list' <<< "$tests")
jq -nc --argjson n "$(jq length <<< "$tests")" '{ tests: $n, listed: $ARGS.positional }' --args "${listed[@]}"
