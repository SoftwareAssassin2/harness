# A ticket variation's automated tests, for the automated-tests:* commands:
# what generate-automated-tests recorded with automated-tests:record (ASS-180)
# in the ticket's folder,
# data/projects/<project>/work/<KEY>/automated-tests-<variation>.json — a list of
# { "list": "<command that lists the tests without running them>", "run":
# "<command that runs them>" } — each command run with bash in the
# variation's worktree (build.worktree-folder), else the project's workspace,
# through in_project (code.bash): in the dev container when it has one; for a
# variation with a VM (ASS-74), in the VM, in /repos/, where every
# repository is checked out.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../automated-tests.bash"
#   tests_setup <command> <project> <ticket-key> <variation>   # sets $tests (the JSON list), $where (the folder), $vm (the VM, or empty), $results (the results file)
#   $NOT_RUNNABLE                 # an ERE: output that means the command never got as far as a test (below)
#   runnable <exit code> <output file>  # whether the command got as far as a test (below)
#   run_minutes <command> <project>      # the time limit on each test command run, in minutes, or none (below)
#   time_limited <minutes|none> <shell command>   # the command, stopped at that limit (below)
#
# A file of exactly [] is a manual-only test plan (ASS-49): $tests is [] and
# the callers pass with nothing to list or run — verify-exist-and-runnable
# { tests: 0, listed: [] }, verify-success { passed: 0, failed: 0 } — so a
# manual-only ticket moves on past generate-automated-tests and
# automated-testing in every engine that uses them (the harness's and a project's own), with
# no engine change. Fails, naming <command>, when the file lists no
# well-formed test otherwise, or the project, workspace, ticket or variation
# is missing; when the file itself is missing — generate-automated-tests's
# output lost, an outage mid-step — it returns 4 (ASS-162), its own code, so
# an engine can send the ticket back to the step that writes it.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/code.bash"

# Output that means the runner never got as far as a test — docker's own
# errors too, for a dev container gone between in_project's check and its exec.
# pnpm says Command "<bin>" not found for a missing bin. Google's and AWS's
# client libraries say so when no credential is there to find. Shared with
# ci-checks:verify (ASS-249), whose checks are judged the same way.
NOT_RUNNABLE='ERR_PNPM_VERIFY_DEPS_BEFORE_RUN|ERR_PNPM_FETCH_|Cannot find module|MODULE_NOT_FOUND|command not found|Command "[^"]*" not found|No such container|is not running|Cannot connect to the Docker daemon|Could not load the default credentials|DefaultCredentialsError|Unable to locate credentials|NoCredentialsError'

# A test runner's own result line — node's spec reporter (✔ ✖ ﹣ ▶) and TAP
# (ok/not ok/# Subtest:), vitest's and jest's (✓ ×): a test's name, not the
# environment's error, whatever words that name holds (ASS-320) — a passing
# test "... whose VM is not running ..." is not a VM that is not running.
TEST_RESULT='^[[:space:]]*((✔|✓|✖|×|﹣|▶) |(not )?ok [0-9]+ |# Subtest: )'

# runnable <exit code> <output file> — whether the command got as far as a
# test: no runner-missing exit code and no NOT_RUNNABLE output off a result
# line. Not grep -qE on the pipe: -q exits early, SIGPIPEs the first grep and
# pipefail would make a real error look runnable.
runnable() { [[ $1 -ne 125 && $1 -ne 126 && $1 -ne 127 && -z "$(grep -vE "$TEST_RESULT" "$2" | grep -E "$NOT_RUNNABLE")" ]]; }

# The time limit on each run of a test command (ASS-329): project.json's
# automated-test-run-minutes — absent, 30; null, none — a number of minutes
# above 0 (a fraction too). run_minutes prints it, or none; fails, naming
# <command>, on any other value.
run_minutes() {
  local command="$1" project="$2" minutes
  minutes="$(jq -r 'if has("automated-test-run-minutes") then .["automated-test-run-minutes"] | if . == null then "none" elif type == "number" and . > 0 then . else "bad" end else 30 end' "$projects/$project/project.json")"
  [[ "$minutes" != bad ]] || { echo "$command: project.json's automated-test-run-minutes must be a number of minutes above 0, or null for none" >&2; return 1; }
  echo "$minutes"
}

# time_limited prints a shell command that runs the given one, stopped once it
# passes the limit: a bash script run where the command runs — on the Mac, in
# the VM, in the dev container — as in_project runs any command, so the limit
# needs nothing there but bash (macOS has no timeout(1)), and stopping it is
# done there too: a SIGTERM to the local `limactl shell` or `docker exec`
# never reaches what it started (ASS-69). The command runs in a process group
# of its own (set -m), so a watchdog can stop it and everything it started at
# once: SIGTERM to the group at the limit (node --test, stopped so, reports
# the files it was running), SIGKILL to what is left of it 10 seconds later.
# A run stopped so exits 124, its output ending with the limit's line, for
# test-results.js timedOut; any other run exits with the command's own code,
# the watchdog stopped. With none, the command as it is.
TIME_LIMIT='f="$(mktemp)"
set -m
bash -c "$run" & c=$!
( sleep "$seconds"; echo stopped > "$f"; kill -TERM -- -"$c"
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -"$c" || exit 0; sleep 1; done
  kill -KILL -- -"$c" ) > /dev/null 2>&1 & w=$!
set +m
wait "$c" 2> /dev/null; s=$?
if [ -s "$f" ]; then wait "$w"; rm -f "$f"; echo "automated-tests:verify-success: timed out after $minutes minutes" >&2; exit 124; fi
kill -- -"$w" 2> /dev/null; rm -f "$f"; exit "$s"'
time_limited() {
  [[ "$1" != none ]] || { printf '%s' "$2"; return; }
  printf 'minutes=%q seconds=%q run=%q\n%s' "$1" "$(awk -v m="$1" 'BEGIN { print m * 60 }')" "$2" "$TIME_LIMIT"
}

tests_setup() {
  local command="$1" project="$2" key="$3" variation="$4" folder file
  local build
  vm="$(vm_of "$command" "$project" "$key" "$variation")"
  if [[ -n "$vm" ]]; then where=/repos/
  else
    build="$(build_of "$command" "$project" "$key" "$variation")"
    where="$(jq -r '.["worktree-folder"] // empty' <<< "$build")"
    [[ -n "$where" && -d "$where" ]] || where="$(workspace_of "$command" "$project")"
  fi
  folder="$projects/$project/work/$key"
  file="$folder/automated-tests-$variation.json"
  results="$folder/automated-test-results-$variation.md"
  [[ -f "$file" ]] || { echo "$command: $key has no automated-tests-$variation.json in its folder" >&2; return 4; }
  if jq -e '. == []' "$file" > /dev/null 2>&1; then tests='[]'; return 0; fi
  tests="$(jq -c '[.[]? | select(type == "object" and (.list | type) == "string" and (.run | type) == "string")]' "$file")"
  [[ "$(jq length <<< "$tests")" -gt 0 ]] || { echo "$command: automated-tests-$variation.json lists no tests" >&2; return 1; }
}
