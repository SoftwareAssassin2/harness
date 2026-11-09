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
#   exit 2, the reason on stderr; any other failure exit 1.
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
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
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

if [[ $gate -eq 1 ]]; then
  scratch="$(mktemp -d)"
  finish() { git -C "$workspace" worktree remove --force "$scratch/gate" 2>/dev/null || true; rm -rf "$scratch"; rm -f "$holder"; }
  # A gate that stops on an error of its own ends failed, so the step blocks rather than start it again and again.
  trap 'ends failed "the merge gate stopped (exit $?)"' EXIT
  { jq --argjson pid $$ '. + { pid: $pid }' "$holder" | replace_file "$holder"; } 2>/dev/null || true
  # ends <result> <reason> — the gate's result recorded for the step to take, then the gate cleaned up and ended.
  ends() {
    trap - EXIT
    [[ "$1" != red ]] || plan_note "$project" "$key" "$variation" "the merge gate sent it back to Build, nothing merged: $2" 6>&-
    jq -n --arg r "$1" --arg why "$2" --arg branch "${branch-}" --arg tested "${tested-}" '{ result: $r, reason: $why, branch: $branch, tested: $tested }' | replace_file "$result"
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
  (cd "$scratch/gate" && "$@") 6>&- \
    || ends red "$* fails on $branch rebased onto $main ($(git -C "$workspace" rev-parse --short "refs/merge-gate/$main")) — its output: $log; bring $main into the branch and make it pass"
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
if [[ -f "$result" ]]; then
  done="$(cat "$result")"
  rm -f "$result"
  case "$(jq -r .result <<< "$done")" in
    merged) jq -c '{ merged: true, branch, tested }' <<< "$done"; exit 0 ;;
    red) echo "$command: $(jq -r .reason <<< "$done")" >&2; exit 2 ;;
    *) echo "$command: $(jq -r .reason <<< "$done") — see $log" >&2; exit 1 ;;
  esac
fi

# says <short> <long> — the board's ai-feedback for the variation.
says() { "$here/../ticket/set-ai-feedback.sh" "$project" "$key" "$variation" "$1" "$2" >/dev/null 6>&-; }
running() { says "merging: rebasing onto main and running the full tests" "Its merge gate runs (log: $log); asked again every minute."; }
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
