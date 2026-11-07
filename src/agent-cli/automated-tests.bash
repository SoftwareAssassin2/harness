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
