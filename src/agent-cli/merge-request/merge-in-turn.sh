#!/usr/bin/env bash
# Description: Merge the ticket's pull request in its turn — one ticket of the project at a time, rebased onto the latest main and its full tests run first — merge-request:merge-in-turn <project> <ticket-key> <variation> <test command…>; prints JSON.
set -euo pipefail

# Release's Merge Pull Request on the harness (ASS-197), a timer step asked
# again every minute until it ends. One ticket of a project merges at a time:
# its gate holds the project's merge lock, a flock(2) on
# data/projects/<project>/merge.lock (lock_on, json-file.bash), which the
# kernel drops when the gate ends however it ends, so a crashed holder never
# jams the queue; a gate killed mid-run is simply run again on the next ask.
# merge-lock.json beside it names the holder ({ ticket, variation, pid,
# taken-at }) for the board only; one a crash leaves is overwritten.
#
# Each ask, in order (the lock tried first, for at most a second):
# - The gate has finished (its result, work/<KEY>/merge-gate-<variation>.json,
#   taken): merged — { "merged": true, "branch", "tested" }, exit 0; red —
#   exit 2, the reason on stderr; master's (ASS-394, below) — waiting for
#   master; any other failure exit 1.
# - Waiting for master (work/<KEY>/merge-gate-wait-<variation>.json, written
#   when a master's result is taken): while origin's default branch is still
#   at the commit the tests failed on (git ls-remote; or origin cannot be
#   asked), { "waiting": true, "master-red": true, tests, tickets }, exit 0,
#   the board's ai-feedback "waiting for master: …" naming the tickets — no
#   exit, so no visit charged and nothing sent back to Build. Once it moves,
#   the record goes and the ask goes on below: the gate runs again.
# - The lock is held: { "waiting": true, "behind": <holder's key> }, exit 0, and
#   the board's ai-feedback says "waiting to merge behind <key>" — or, the
#   holder being this ticket, that its gate is running.
# - Else the lock is taken and the gate started in a session of its own,
#   holding it (the descriptor passes to it; the fetch, the tests, the push
#   and the merge get it closed), so control's tick is not held for the
#   length of the tests: { "waiting": true, "behind": <this key> }. Its log is
#   work/<KEY>/merge-gate-<variation>.log.
# The gate (--gate): the variation's Open pull request's branch (control's
# read, refresh_merge_requests) fetched, rebased onto origin's default branch
# in a scratch worktree of the workspace, and <test command…> run there. A
# conflict or a failing test is red: nothing pushed or merged, and why goes
# into execution-plan-<variation>.md (plan_note) for Build, the tests' output in the
# log. Green: the rebased branch pushed
# (--force-with-lease) and merged by merge-request:merge, so what merges is
# what was tested. A variation with no Open pull request has nothing to test
# and merges nothing. More than one Open one, or a failing fetch, push or
# merge, is a failure (exit 1, to Blocked).
# A failing test is not red at once (ASS-394). The failing tests run again,
# once, in the same worktree: node --test's failed files alone, when its
# output names them (merge-gate-tests.js files), else the whole command.
# Passing then, the gate goes on to push and merge (a flake). Failing again,
# the same run is made on the latest master (a worktree of the fetched
# default branch) and the two compared by test (merge-gate-tests.js judge,
# test-results.js's keys): every test that failed again fails on master too
# (or, no test named, the command is red there too) — master's: each such
# test raised once in the project (master-test-failures.bash: the harness
# backlog for the harness project, else the project's own ticket system),
# the result master, and the ticket waits for master as above. A test that
# passes on master, or a failed test file master has not got, is red as
# before (those that do fail on master still raised once).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../master-test-failures.bash"
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
command=merge-request:merge-in-turn

gate=0
[[ "${1:-}" == --gate ]] && { gate=1; shift; }
[[ $# -ge 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <test command…>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
shift 3
workspace="$(workspace_of "$command" "$project")"
folder="$projects/$project/work/$key"
lock="$projects/$project/merge.lock" holder="$projects/$project/merge-lock.json"
result="$folder/merge-gate-$variation.json" log="$folder/merge-gate-$variation.log"
master_wait="$folder/merge-gate-wait-$variation.json"

if [[ $gate -eq 1 ]]; then
  scratch="$(mktemp -d)"
  finish() { local w; for w in gate master; do git -C "$workspace" worktree remove --force "$scratch/$w" 2>/dev/null || true; done; rm -rf "$scratch"; rm -f "$holder"; }
  # tests_in <folder> <output-file> <command…> — the command run in <folder>, its output kept in <output-file> (and the log); its exit status.
  tests_in() { local s=0 dir="$1" out="$2"; shift 2; (cd "$dir" && "$@") > "$out" 2>&1 6>&- || s=$?; cat "$out"; return $s; }
  extra='{}' files=()
  # A gate that stops on an error of its own ends failed, so the step blocks rather than start it again and again.
  trap 'ends failed "the merge gate stopped (exit $?)"' EXIT
  { jq --argjson pid $$ '. + { pid: $pid }' "$holder" | replace_file "$holder"; } 2>/dev/null || true
  # ends <result> <reason> — the gate's result recorded for the step to take, then the gate cleaned up and ended.
  ends() {
    trap - EXIT
    [[ "$1" != red ]] || plan_note "$project" "$key" "$variation" "the merge gate sent it back to Build, nothing merged: $2" 6>&-
    jq -n --arg r "$1" --arg why "$2" --arg branch "${branch-}" --arg tested "${tested-}" --argjson extra "$extra" '{ result: $r, reason: $why, branch: $branch, tested: $tested } + $extra' | replace_file "$result"
    finish
    exit 0
  }
  refresh_merge_requests "$command" "$project" "$key" "$variation" 6>&- || ends failed "could not read the pull requests"
  open="$(jq -c '[.[] | select(.status == "Open" and .key != null)]' <<< "$MRS")"
  case "$(jq length <<< "$open")" in
    0) "$here/merge.sh" "$project" "$key" "$variation" >/dev/null 6>&- || ends failed "could not merge"; ends merged "no Open pull request to test" ;;
    1) ;;
    *) ends failed "the merge gate takes one Open pull request; $key $variation has $(jq length <<< "$open")" ;;
  esac
  branch="$(jq -r '.[0].branch // empty' <<< "$open")"
  [[ -n "$branch" ]] || branch="$(build_of "$command" "$project" "$key" "$variation" | jq -r '.branch // empty')"
  [[ -n "$branch" ]] || branch="$(branch_name "$key" "$variation")"
  main="$(default_branch "$workspace")"
  # Fetch into a private refs/merge-gate/* namespace, not the shared
  # refs/remotes/origin/*, so a concurrent plain `git fetch origin` in the same
  # workspace (e.g. code/create-branch.sh for another ticket) cannot race the
  # tracking refs and lock us out ("cannot lock ref ... is at X but expected
  # Y"). --refmap= is required: without it `git fetch origin` would also update
  # the matching refs/remotes/origin/* opportunistically from its remote's
  # refmap, which races just the same.
  git -C "$workspace" fetch --quiet --refmap= origin "+refs/heads/$main:refs/merge-gate/$main" "+refs/heads/$branch:refs/merge-gate/$branch" 6>&- \
    || ends failed "could not fetch $main and $branch from origin"
  before="$(git -C "$workspace" rev-parse "refs/merge-gate/$branch")"
  git -C "$workspace" worktree add --quiet --detach "$scratch/gate" "$before" 6>&- || ends failed "could not check out $branch"
  if ! git -C "$scratch/gate" rebase --quiet "refs/merge-gate/$main" >/dev/null 2>&1 6>&-; then
    conflicts="$(git -C "$scratch/gate" diff --name-only --diff-filter=U | paste -sd, - | sed 's/,/, /g')"
    git -C "$scratch/gate" rebase --abort 2>/dev/null || true
    ends red "$branch does not rebase onto $main: conflicts in ${conflicts:-its changes}; bring $main into the branch and resolve them"
  fi
  tested="$(git -C "$scratch/gate" rev-parse HEAD)"
  master="$(git -C "$workspace" rev-parse "refs/merge-gate/$main")"
  red="$* fails on $branch rebased onto $main ($(git -C "$workspace" rev-parse --short "$master")) — its output: $log; bring $main into the branch and make it pass"
  status=0; tests_in "$scratch/gate" "$scratch/first" "$@" || status=$?
  if [[ $status -ne 0 ]]; then
    # ASS-394 AC1: red once is not yet the ticket's: the failing tests run again.
    mapfile -t files < <(node "$here/merge-gate-tests.js" files "$scratch/first" 2>/dev/null || true)
    if [[ ${#files[@]} -gt 0 ]]; then again=(node --test --test-force-exit "${files[@]}"); else again=("$@"); fi
    echo "$command: red; the failing tests run again: ${again[*]}"
    status=0; tests_in "$scratch/gate" "$scratch/again" "${again[@]}" || status=$?
    [[ $status -ne 0 ]] || echo "$command: the failing tests pass when run again: a flake, not the ticket's"
  fi
  if [[ $status -ne 0 ]]; then
    # AC2: red again, so the same tests run on the latest master. A test file
    # master has not got is the branch's own, not master's.
    for f in "${files[@]}"; do
      git -C "$workspace" cat-file -e "refs/merge-gate/$main:$f" 2>/dev/null || ends red "$red (it failed again; $f is not on $main)"
    done
    git -C "$workspace" worktree add --quiet --detach "$scratch/master" "$master" 6>&- || ends failed "could not check out $main"
    echo "$command: red again; the same tests on $main ($master)"
    mstatus=0; tests_in "$scratch/master" "$scratch/master.out" "${again[@]}" || mstatus=$?
    verdict="$(node "$here/merge-gate-tests.js" judge "$status" "$scratch/again" "$mstatus" "$scratch/master.out")" \
      || ends failed "could not compare the failing tests with $main's"
    # The tests that fail on master too (the command, when no test is named), each raised once.
    names='[]'
    [[ $mstatus -eq 0 ]] || names="$(jq -c --arg c "${again[*]}" 'if .tests == [] and .master then [$c] else .tests end' <<< "$verdict")"
    tickets='[]'
    if [[ "$names" != '[]' ]]; then
      tickets="$(raise_master_failures "$command" "$project" "$names" \
        "The merge gate (merge-request:merge-in-turn, ASS-394) ran \`$*\` for $key $variation rebased onto $main: these failed, failed again when run again, and failed on the latest $main ($master) too: $main's flake or bug, not the ticket's. Its output: $log." 6>&-)" \
        || tickets='[]'
    fi
    # AC3: a failure that passes on master counts against the ticket, as before.
    [[ "$(jq -r .master <<< "$verdict")" == true && $mstatus -ne 0 ]] \
      || ends red "$red$(jq -r 'if .new == [] then "" else " (failed again, not on master: \(.new | join("; ")))" end' <<< "$verdict")"
    extra="$(jq -nc --arg m "$main" --arg at "$master" --argjson t "$names" --argjson k "$tickets" '{ main: $m, master: $at, tests: $t, tickets: $k }')"
    ends master "$(jq -r 'join("; ")' <<< "$names") fail(s) on the latest $main ($(git -C "$workspace" rev-parse --short "$master")) too: $main's, not the ticket's"
  fi
  if [[ "$tested" != "$before" ]]; then
    git -C "$scratch/gate" push --quiet --force-with-lease="refs/heads/$branch:$before" origin "HEAD:refs/heads/$branch" 6>&- \
      || ends failed "could not push $branch rebased onto $main"
  fi
  "$here/merge.sh" "$project" "$key" "$variation" >/dev/null 6>&- || ends failed "could not merge $branch"
  ends merged "$branch rebased onto $main, $* passed, merged"
fi

# The lock tried first (waiting at most a second), then the result, which a
# gate writes before it lets go.
locked=0
lock_on 6 "$lock" "$command" 1 2>/dev/null && locked=1
# says <short> <long> — the board's ai-feedback for the variation.
says() { "$here/../ticket/set-ai-feedback.sh" "$project" "$key" "$variation" "$1" "$2" >/dev/null 6>&-; }
running() { says "merging: rebasing onto main and running the full tests" "Its merge gate runs (log: $log); asked again every minute."; }
# ASS-394: a gate red on tests that fail on master too waits for master: no
# exit, so no visit charged and nothing sent back to Build.
waiting_for_master() {
  local tickets
  tickets="$(jq -r '.tickets | if length == 0 then "no ticket raised" else join(", ") end' "$master_wait")"
  says "waiting for master: its failing tests fail on $(jq -r .main "$master_wait") too ($tickets)" \
    "The merge gate's tests failed, failed again, and fail on the latest $(jq -r .main "$master_wait") ($(jq -r .master "$master_wait")) too: $(jq -r '.tests | join("; ")' "$master_wait"). That is master's flake or bug, not this ticket's: raised once as $tickets, and this ticket is not charged for it. It waits for $(jq -r .main "$master_wait") to move, then runs its merge gate again; asked every minute."
  jq -c '{ waiting: true, behind: null, "master-red": true, tests, tickets }' "$master_wait"
}
if [[ -f "$result" ]]; then
  done="$(cat "$result")"
  rm -f "$result"
  case "$(jq -r .result <<< "$done")" in
    merged) jq -c '{ merged: true, branch, tested }' <<< "$done"; exit 0 ;;
    red) echo "$command: $(jq -r .reason <<< "$done")" >&2; exit 2 ;;
    master) jq '{ main, master, tests, tickets, reason, "since": (now | todate) }' <<< "$done" | replace_file "$master_wait"
      waiting_for_master; exit 0 ;;
    *) echo "$command: $(jq -r .reason <<< "$done") — see $log" >&2; exit 1 ;;
  esac
fi
# Waiting for master: until origin's master moves past the one the tests
# failed on (or origin cannot be asked), it waits; then the gate runs again.
if [[ -f "$master_wait" ]]; then
  now="$(git -C "$workspace" ls-remote origin "refs/heads/$(jq -r .main "$master_wait")" 2>/dev/null 6>&- | cut -f1 || true)"
  if [[ -z "$now" || "$now" == "$(jq -r .master "$master_wait")" ]]; then waiting_for_master; exit 0; fi
  rm -f "$master_wait"
fi

if [[ $locked -eq 0 ]]; then
  behind="$(jq -r '.ticket // empty' "$holder" 2>/dev/null || true)"
  if [[ "$behind" == "$key" ]]; then running
  else says "waiting to merge behind ${behind:-another ticket}" "One ticket of $project merges at a time; ${behind:-another ticket} holds the merge lock ($lock). This one goes next, asked again every minute."; fi
  jq -nc --arg b "$behind" '{ waiting: true, behind: (if $b == "" then null else $b end) }'
  exit 0
fi
mkdir -p "$folder"
jq -n --arg t "$key" --arg v "$variation" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ ticket: $t, variation: $v, "taken-at": $at }' | replace_file "$holder"
perl -MPOSIX=setsid -e 'setsid(); exec @ARGV' "$here/merge-in-turn.sh" --gate "$project" "$key" "$variation" "$@" < /dev/null > "$log" 2>&1 &
running
jq -nc --arg k "$key" '{ waiting: true, behind: $k }'
