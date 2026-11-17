#!/usr/bin/env bash
# Description: Check the ticket's automated tests exist and the runner finds them (they may fail) — automated-tests:verify-exist-and-runnable <project> <ticket-key> <variation>.
set -euo pipefail

# Runs each test's list command (see automated-tests.bash) in the variation's
# worktree: every one must exit 0 and print at least one test. Nothing is run,
# so tests written before the solution may fail. An entry naming its merge
# request (ASS-498) is listed on that merge request's branch (below). Prints
# { tests, listed: [<line>…] }. Fails, naming the command, when one fails or finds nothing, or
# when the tests are not recorded.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../automated-tests.bash"

[[ $# -eq 3 ]] || { echo "usage: automated-tests:verify-exist-and-runnable <project> <ticket-key> <variation>" >&2; exit 1; }
key="$(upper "$2")"
tests_setup automated-tests:verify-exist-and-runnable "$1" "$key" "$3"

listed=()
# ASS-498: an entry naming its merge request — "merge-request": <id>, two
# merging into one repository — has its list command run with that merge
# request's branch checked out, then the repository put back where it was.
# The checkout's git, run where the tests run (as verify-success.sh's
# CHECKOUT): `to <branch>` checks out the branch in the repository holding it
# (locally or on origin), printing "<repository> <where it was>"; it refuses,
# changing nothing, when none has it or that one has changes not committed.
# `back <repository> <ref>` checks the ref out again.
SWITCH='set -euo pipefail
repos() { if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then echo .; else for d in */; do [ -e "$d.git" ] && echo "${d%/}"; done; fi; return 0; }
case "$1" in
  to)
    r="$(repos | while read -r d; do git -C "$d" show-ref -q --verify "refs/heads/$2" || git -C "$d" show-ref -q --verify "refs/remotes/origin/$2" || continue; echo "$d"; break; done)"
    [ -n "$r" ] || { echo "no repository has $2" >&2; exit 1; }
    [ -z "$(git -C "$r" status --porcelain --untracked-files=no)" ] || { echo "$r has changes not committed" >&2; exit 1; }
    from="$(git -C "$r" symbolic-ref -q --short HEAD || git -C "$r" rev-parse HEAD)"
    git -C "$r" checkout -q "$2" || { echo "$r: could not check out $2" >&2; exit 1; }
    echo "$r $from" ;;
  back) git -C "$2" checkout -q "$3" ;;
esac'
switch() {
  if [[ -n "$vm" ]]; then machine_run --workdir "$where" "$vm" -- bash -c "$SWITCH" switch "$@" < /dev/null
  else (cd "$where" && bash -c "$SWITCH" switch "$@") < /dev/null; fi
}
restore=()
cleanup() { [[ ${#restore[@]} -eq 0 ]] || switch back "${restore[@]}" || true; }
trap cleanup EXIT

mrs='[]'
if jq -e 'any(.[]; has("merge-request"))' <<< "$tests" > /dev/null; then
  mrs="$(variation_field '[.["merge-request"] // [] | .[] | select(.id != null)]' automated-tests:verify-exist-and-runnable "$1" "$key" "$3")"
fi

while IFS= read -r entry; do
  list="$(jq -r .list <<< "$entry")"
  mr="$(jq -r '.["merge-request"] // empty' <<< "$entry")"
  if [[ -n "$mr" ]]; then
    branch="$(jq -r --argjson id "$mr" '.[] | select(.id == $id) | .branch // empty' <<< "$mrs")"
    [[ -n "$branch" ]] || { echo "automated-tests:verify-exist-and-runnable: $key $3 has no merge request $mr planned (ticket:merge-request-plan): $list" >&2; exit 1; }
    moved="$(switch to "$branch" 2>&1)" || { echo "automated-tests:verify-exist-and-runnable: could not check out merge request $mr's branch: $moved" >&2; exit 1; }
    read -r -a restore <<< "$moved"
  fi
  status=0
  out="$(in_project automated-tests:verify-exist-and-runnable "$1" "$where" "$list" "$vm" 2>&1)" || status=$?
  [[ $status -eq 0 ]] || { echo "automated-tests:verify-exist-and-runnable: list command failed (exit $status): $list" >&2; echo "$out" >&2; exit 1; }
  [[ -n "${out//[[:space:]]/}" ]] || { echo "automated-tests:verify-exist-and-runnable: found no test: $list" >&2; exit 1; }
  while IFS= read -r line; do [[ -z "${line//[[:space:]]/}" ]] || listed+=("$line"); done <<< "$out"
  if [[ ${#restore[@]} -gt 0 ]]; then switch back "${restore[@]}"; restore=(); fi
done < <(jq -c '.[]' <<< "$tests")
jq -nc --argjson n "$(jq length <<< "$tests")" '{ tests: $n, listed: $ARGS.positional }' --args "${listed[@]}"
