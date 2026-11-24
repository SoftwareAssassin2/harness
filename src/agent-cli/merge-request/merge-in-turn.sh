#!/usr/bin/env bash
# Description: Merge the ticket's pull requests, each in its depends-on order, rebased onto the latest main and its full tests run first; other tickets of the project merge at the same time — merge-request:merge-in-turn <project> <ticket-key> <variation> <test command…>; prints JSON.
set -euo pipefail

# Release's Merge Pull Request on the harness (ASS-197), a timer step asked
# again every minute until it ends. ASS-560: tickets of a project merge at the
# same time — there is no project-wide lock or turn (ASS-197's merge.lock and
# merge-lock.json are gone). Only a ticket variation's own pull requests stay
# in order: its gate takes them one at a time, in depends-on order (a library
# before its consumer), and only one gate of the variation runs at once. That
# is a flock(2) on work/<KEY>/merge-gate-<variation>.lock (lock_on,
# json-file.bash), which the kernel drops when the gate ends however it ends,
# so a crashed gate never jams its ticket; a gate killed mid-run is simply run
# again on the next ask. work/<KEY>/merge-gate-holder-<variation>.json beside
# it names the gate ({ ticket, variation, pid, taken-at }); one a crash leaves
# is overwritten. The price of merging side by side is more rebases: a ticket
# whose main moves under its gate (another ticket merged first) rebases and
# runs its tests again (base-moved, below), and two changes each green on its own
# but not together are caught by the project's CI on main after the merge
# (ASS-552), not here.
#
# Each ask, in order (the variation's lock tried first, for at most a second):
# - The gate has finished (its result, work/<KEY>/merge-gate-<variation>.json,
#   taken): merged — { "merged": true, "branch", "tested", "merge-requests" },
#   exit 0; red — exit 2, the reason on stderr; base moved (below); master's
#   (ASS-394, below) — waiting for master; any other failure exit 1. Each
#   ending's JSON also carries ai-feedback-short / -long (null but for a base
#   move and exit 1): the step records its output (record-script-output),
#   so a Release that ends at Blocked says why, and one that goes on has
#   nothing stale left to say.
# - Base moved (ASS-560 AC2/AC6): main moved on origin after the gate rebased
#   onto it — another ticket merged first — so what it tested is not what
#   would merge: nothing more is merged (the pull requests merged before it,
#   in order, stay merged), exit 0, { "waiting": true, "base-moved": true,
#   main, was, now, "ai-feedback-short", "ai-feedback-long" }, the board told
#   so too. v2-release's first exit takes base-moved back into Merge Pull
#   Request itself, so the next ask starts a gate afresh — rebased onto the
#   new main and fully tested again — and each such return is a visit: the
#   step's max-visits bounds the rebases, then Blocked, the ai-feedback
#   saying main kept moving. Exit 0, not a code of its own: control counts
#   any other non-zero exit as a failure (backoff, then Blocked after a few
#   in a row), and an engine without that exit (a project's own Release)
#   reads it as waiting, so it never takes a base move for a merge — it
#   simply starts the gate again on the next ask, unbounded as before. A
#   merge the forge refuses while main has moved (a non-fast-forward, an
#   out-of-date branch) is the same base move, not a failure.
# - Waiting for master (work/<KEY>/merge-gate-wait-<variation>.json, written
#   when a master's result is taken): while origin's default branch is still
#   at the commit the tests failed on (git ls-remote; or origin cannot be
#   asked), { "waiting": true, "master-red": true, tests, tickets }, exit 0,
#   the board's ai-feedback "waiting for master: …" naming the tickets — no
#   exit, so no visit charged and nothing sent back to Build. Once it moves,
#   the record goes and the ask goes on below: the gate runs again.
# - The variation's gate is running (its lock held): { "waiting": true,
#   "running": true }, exit 0, the board's ai-feedback saying so.
# - Else the lock is taken and the gate started in a session of its own,
#   holding it (the descriptor passes to it; the fetch, the tests, the push
#   and the merge get it closed), so control's tick is not held for the
#   length of the tests: { "waiting": true, "running": true }. Its log is
#   work/<KEY>/merge-gate-<variation>.log.
# The gate (--gate), for each of the variation's Open pull requests in
# depends-on order (in_order, merge-requests.bash; read again from the forge
# before each, control's read, refresh_merge_requests, which retargets one
# whose dependency has merged onto main): its branch fetched, rebased onto
# origin's default branch in a scratch worktree of the workspace, and <test
# command…> run there. The fetch goes into refs of the variation's own
# (refs/merge-gate/<KEY>/<variation>/…), so two tickets' gates in one
# workspace never race for a ref. A conflict or a failing test is red:
# nothing more pushed or merged, and why goes into
# execution-plan-<variation>.md (plan_note) for Build, the tests' output in
# the log. Green, and main still where it was rebased onto: the rebased
# branch pushed (--force-with-lease) and that one pull request merged
# (merge-request:merge --first), so what merges is what was tested; then the
# next. A variation with no Open pull request has nothing to test and merges
# nothing. A failing fetch, push or merge is a failure (exit 1, to Blocked).
# A failing test is not red at once (ASS-394). The failing tests run again,
# once, in the same worktree: node --test's failed files alone, when its
# output names them (merge-gate-tests.js files), else the whole command.
# Passing then, the gate goes on to push and merge (a flake). Failing again,
# the same run is made on the latest master (a worktree of the fetched
# default branch) and the two compared by test (merge-gate-tests.js judge,
# test-results.js's keys): every test that failed again fails on master too
# (or, no test named, the command is red there too) — master's: each such
# test raised once in the project (master-test-failures.bash: the harness
# backlog for the harness project, else the project's own ticket system;
# its own lock, as gates now run side by side), the result master, and the
# ticket waits for master as above. A test that passes on master, or a
# failed test file master has not got, is red as before (those that do fail
# on master still raised once).
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
# ASS-560: the variation's own lock and gate record, not the project's: other tickets' gates run beside this one.
lock="$folder/merge-gate-$variation.lock" holder="$folder/merge-gate-holder-$variation.json"
result="$folder/merge-gate-$variation.json" log="$folder/merge-gate-$variation.log"
master_wait="$folder/merge-gate-wait-$variation.json"
# The refs the gate fetches into: the variation's own, so two gates in one workspace never write the same ref.
ns="refs/merge-gate/$key/$variation"

if [[ $gate -eq 1 ]]; then
  scratch="$(mktemp -d)"
  # remove_worktrees — this pull request's scratch worktrees gone (the next one gets fresh ones).
  remove_worktrees() { local w; for w in gate master; do git -C "$workspace" worktree remove --force "$scratch/$w-$key-$variation" 2>/dev/null || true; done; }
  finish() {
    remove_worktrees; rm -rf "$scratch"; rm -f "$holder"
    git -C "$workspace" for-each-ref --format='%(refname)' "$ns/" 2>/dev/null | while read -r r; do git -C "$workspace" update-ref -d "$r" 2>/dev/null || true; done
  }
  # tests_in <folder> <output-file> <command…> — the command run in <folder>, its output kept in <output-file> (and the log); its exit status.
  tests_in() { local s=0 dir="$1" out="$2"; shift 2; (cd "$dir" && "$@") > "$out" 2>&1 6>&- || s=$?; cat "$out"; return $s; }
  extra='{}' files=() merged='[]'
  # A gate that stops on an error of its own ends failed, so the step blocks rather than start it again and again.
  trap 'ends failed "the merge gate stopped (exit $?)"' EXIT
  { jq --argjson pid $$ '. + { pid: $pid }' "$holder" | replace_file "$holder"; } 2>/dev/null || true
  # ends <result> <reason> — the gate's result recorded for the step to take, then the gate cleaned up and ended.
  ends() {
    trap - EXIT
    [[ "$1" != red ]] || plan_note "$project" "$key" "$variation" "the merge gate sent it back to Build, nothing more merged: $2" 6>&-
    jq -n --arg r "$1" --arg why "$2" --arg branch "${branch-}" --arg tested "${tested-}" --argjson merged "$merged" --argjson extra "$extra" \
      '{ result: $r, reason: $why, branch: $branch, tested: $tested, "merge-requests": $merged } + $extra' | replace_file "$result"
    finish
    exit 0
  }
  # moved_from <commit> — origin's default branch is no longer at <commit> (another ticket merged): the base moved, ends moved.
  moved_from() {
    local now
    now="$(git -C "$workspace" ls-remote origin "refs/heads/$main" 2>/dev/null 6>&- | cut -f1 || true)"
    [[ -n "$now" && "$now" != "$1" ]] || return 0
    extra="$(jq -nc --arg m "$main" --arg was "$1" --arg now "$now" '{ main: $m, was: $was, now: $now }')"
    ends moved "$main moved from $(git -C "$workspace" rev-parse --short "$1") to ${now:0:7} on origin while the gate ran ($2) — another ticket merged first; $branch is rebased onto it and tested again"
  }
  count=0
  while :; do
    refresh_merge_requests "$command" "$project" "$key" "$variation" 6>&- || ends failed "could not read the pull requests"
    # The first Open one in depends-on order: those before it are merged (by this gate, or earlier).
    i="$(jq -r "$(in_order) | first(.[] as \$i | select(\$all[\$i].status == \"Open\" and \$all[\$i].key != null) | \$i) // empty" <<< "$MRS")"
    if [[ -z "$i" ]]; then
      [[ $count -gt 0 ]] && ends merged "$(jq -r 'map(.branch) | join(", ")' <<< "$merged") rebased onto $main, $* passed, merged in order"
      "$here/merge.sh" "$project" "$key" "$variation" >/dev/null 6>&- || ends failed "could not merge"
      ends merged "no Open pull request to test"
    fi
    count=$((count + 1))
    branch="$(jq -r --argjson i "$i" '.[$i].branch // empty' <<< "$MRS")"
    [[ -n "$branch" ]] || branch="$(build_of "$command" "$project" "$key" "$variation" | jq -r '.branch // empty')"
    [[ -n "$branch" ]] || branch="$(branch_name "$key" "$variation")"
    main="$(default_branch "$workspace")"
    # Fetch into the variation's own refs/merge-gate/<KEY>/<variation>/* namespace
    # ($ns), not the shared refs/remotes/origin/*, so a concurrent plain `git
    # fetch origin` in the same workspace (e.g. code/create-branch.sh for another
    # ticket) cannot race the tracking refs and lock us out ("cannot lock ref ...
    # is at X but expected Y", ASS-318) — nor another ticket's gate, fetching
    # main beside this one (ASS-560). --refmap= is required: without it `git
    # fetch origin` would also update the matching refs/remotes/origin/*
    # opportunistically from its remote's refmap, which races just the same.
    git -C "$workspace" fetch --quiet --refmap= origin "+refs/heads/$main:$ns/base/$main" "+refs/heads/$branch:$ns/head/$branch" 6>&- \
      || ends failed "could not fetch $main and $branch from origin"
    before="$(git -C "$workspace" rev-parse "$ns/head/$branch")"
    gate_tree="$scratch/gate-$key-$variation" master_tree="$scratch/master-$key-$variation"
    git -C "$workspace" worktree add --quiet --detach "$gate_tree" "$before" 6>&- || ends failed "could not check out $branch"
    if ! git -C "$gate_tree" rebase --quiet "$ns/base/$main" >/dev/null 2>&1 6>&-; then
      conflicts="$(git -C "$gate_tree" diff --name-only --diff-filter=U | paste -sd, - | sed 's/,/, /g')"
      git -C "$gate_tree" rebase --abort 2>/dev/null || true
      ends red "$branch does not rebase onto $main: conflicts in ${conflicts:-its changes}; bring $main into the branch and resolve them"
    fi
    tested="$(git -C "$gate_tree" rev-parse HEAD)"
    master="$(git -C "$workspace" rev-parse "$ns/base/$main")"
    red="$* fails on $branch rebased onto $main ($(git -C "$workspace" rev-parse --short "$master")) — its output: $log; bring $main into the branch and make it pass"
    echo "$command: $branch rebased onto $main ($master): $*"
    status=0; files=(); tests_in "$gate_tree" "$scratch/first" "$@" || status=$?
    if [[ $status -ne 0 ]]; then
      # ASS-394 AC1: red once is not yet the ticket's: the failing tests run again.
      mapfile -t files < <(node "$here/merge-gate-tests.js" files "$scratch/first" 2>/dev/null || true)
      if [[ ${#files[@]} -gt 0 ]]; then again=(node --test --test-force-exit "${files[@]}"); else again=("$@"); fi
      echo "$command: red; the failing tests run again: ${again[*]}"
      status=0; tests_in "$gate_tree" "$scratch/again" "${again[@]}" || status=$?
      [[ $status -ne 0 ]] || echo "$command: the failing tests pass when run again: a flake, not the ticket's"
    fi
    if [[ $status -ne 0 ]]; then
      # AC2: red again, so the same tests run on the latest master. A test file
      # master has not got is the branch's own, not master's.
      for f in "${files[@]}"; do
        git -C "$workspace" cat-file -e "$ns/base/$main:$f" 2>/dev/null || ends red "$red (it failed again; $f is not on $main)"
      done
      git -C "$workspace" worktree add --quiet --detach "$master_tree" "$master" 6>&- || ends failed "could not check out $main"
      echo "$command: red again; the same tests on $main ($master)"
      mstatus=0; tests_in "$master_tree" "$scratch/master.out" "${again[@]}" || mstatus=$?
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
    # ASS-560 AC6: another ticket merged while the tests ran — what was tested is not what would merge.
    moved_from "$master" "before $branch was pushed"
    if [[ "$tested" != "$before" ]]; then
      git -C "$gate_tree" push --quiet --force-with-lease="refs/heads/$branch:$before" origin "HEAD:refs/heads/$branch" 6>&- \
        || ends failed "could not push $branch rebased onto $main"
    fi
    # A merge the forge refuses because main moved meanwhile (a non-fast-forward, the branch out of date) is a base move too.
    if ! "$here/merge.sh" "$project" "$key" "$variation" --first >/dev/null 6>&-; then
      moved_from "$master" "the merge of $branch refused"
      ends failed "could not merge $branch"
    fi
    merged="$(jq -c --arg b "$branch" --arg t "$tested" '. + [{ branch: $b, tested: $t }]' <<< "$merged")"
    echo "$command: $branch merged"
    remove_worktrees
  done
fi

# The variation's lock tried first (waiting at most a second), then the
# result, which a gate writes before it lets go.
mkdir -p "$folder"
locked=0
lock_on 6 "$lock" "$command" 1 2>/dev/null && locked=1
# says <short> <long> — the board's ai-feedback for the variation.
says() { "$here/../ticket/set-ai-feedback.sh" "$project" "$key" "$variation" "$1" "$2" >/dev/null 6>&-; }
running() { says "merging: rebasing onto main and running the full tests" "Its merge gate runs (log: $log), its pull requests one at a time in their planned order; other tickets merge at the same time. Asked again every minute."; }
# ASS-394: a gate red on tests that fail on master too waits for master: no
# exit, so no visit charged and nothing sent back to Build.
waiting_for_master() {
  local tickets
  tickets="$(jq -r '.tickets | if length == 0 then "no ticket raised" else join(", ") end' "$master_wait")"
  says "waiting for master: its failing tests fail on $(jq -r .main "$master_wait") too ($tickets)" \
    "The merge gate's tests failed, failed again, and fail on the latest $(jq -r .main "$master_wait") ($(jq -r .master "$master_wait")) too: $(jq -r '.tests | join("; ")' "$master_wait"). That is master's flake or bug, not this ticket's: raised once as $tickets, and this ticket is not charged for it. It waits for $(jq -r .main "$master_wait") to move, then runs its merge gate again; asked every minute."
  jq -c '{ waiting: true, "master-red": true, tests, tickets }' "$master_wait"
}
# The step records its output (record-script-output): each ending says why, or clears what an earlier one said.
quiet='{ "ai-feedback-short": null, "ai-feedback-long": null }'
if [[ -f "$result" ]]; then
  done="$(cat "$result")"
  rm -f "$result"
  case "$(jq -r .result <<< "$done")" in
    merged) jq -c --argjson q "$quiet" '{ merged: true, branch, tested, "merge-requests": (."merge-requests" // []) } + $q' <<< "$done"; exit 0 ;;
    red) jq -c --argjson q "$quiet" '{ red: true, reason } + $q' <<< "$done"; echo "$command: $(jq -r .reason <<< "$done")" >&2; exit 2 ;;
    moved) out="$(jq -c '{ waiting: true, "base-moved": true, main, was, now, "merge-requests": (."merge-requests" // []),
        "ai-feedback-short": "merge gate: \(.main) moved while it ran (another ticket merged first); rebasing and testing again",
        "ai-feedback-long": "\(.reason). Each rebase is a visit to Merge Pull Request, so its max-visits bounds them; past it, the ticket goes to Blocked with this as the reason (\(.main) kept moving under the gate)." }' <<< "$done")"
      says "$(jq -r '."ai-feedback-short"' <<< "$out")" "$(jq -r '."ai-feedback-long"' <<< "$out")"
      echo "$command: $(jq -r .reason <<< "$done")" >&2; echo "$out"; exit 0 ;;
    master) jq '{ main, master, tests, tickets, reason, "since": (now | todate) }' <<< "$done" | replace_file "$master_wait"
      waiting_for_master; exit 0 ;;
    *) jq -c --arg log "$log" '{ failed: true, reason, "ai-feedback-short": "merge gate failed: \(.reason)", "ai-feedback-long": "\(.reason) — see its log, \($log)" }' <<< "$done"
      echo "$command: $(jq -r .reason <<< "$done") — see $log" >&2; exit 1 ;;
  esac
fi
# Waiting for master: until origin's master moves past the one the tests
# failed on (or origin cannot be asked), it waits; then the gate runs again.
if [[ -f "$master_wait" ]]; then
  now="$(git -C "$workspace" ls-remote origin "refs/heads/$(jq -r .main "$master_wait")" 2>/dev/null 6>&- | cut -f1 || true)"
  if [[ -z "$now" || "$now" == "$(jq -r .master "$master_wait")" ]]; then waiting_for_master; exit 0; fi
  rm -f "$master_wait"
fi

# Its own gate running already: only one gate of a variation at a time, so its pull requests keep their order.
if [[ $locked -eq 0 ]]; then running; jq -nc '{ waiting: true, running: true }'; exit 0; fi
jq -n --arg t "$key" --arg v "$variation" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ ticket: $t, variation: $v, "taken-at": $at }' | replace_file "$holder"
perl -MPOSIX=setsid -e 'setsid(); exec @ARGV' "$here/merge-in-turn.sh" --gate "$project" "$key" "$variation" "$@" < /dev/null > "$log" 2>&1 &
running
jq -nc '{ waiting: true, running: true }'
