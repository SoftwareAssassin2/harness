#!/usr/bin/env bash
# Description: Run every repository's automated tests in a fresh VM cloned from the project's golden image — vm:test-repos <project> [<repository>…]; prints a report.
set -euo pipefail

# ASS-105. The tests are what each repository's own CI runs on master, listed
# in tests.json in the project's golden-image folder (vm:build-golden), every
# repository of project.json's by its basename, or this fails before anything:
#   { "repositories": { "<basename>": { "no-tests": "<why: what its CI runs instead>" }   or
#       { "tests": [ { "name": "<its CI job>", "command": "<shell, run in /repos/<basename>>",
#           "summary": "<ERE: the output's matching lines, the last 5, are reported>",   optional
#           "pre-existing": "<CI evidence that it fails on master too>" } ] } } }        optional
# run-test.sh beside it, optional, runs each command in the VM (e.g.
# in a dev container): in /repos/<basename>, as the VM user, the
# command its $1, the GitHub token then the GitLab token on stdin, its exit
# code the test's. Without one each command runs with bash, stdin empty.
# Neither file is an input of the image (vm:build-golden).
#
# The VM, test-<project>-<n>, is a throwaway copy-on-write clone of
# golden-<project> with nothing of the Mac mounted, started under vm:start's
# sandbox (the project's zot and its own ssh port only), and deleted at the
# end, whatever happened. As vm:create does, master — origin's default branch
# — is fetched and checked out in each repository first. The tokens are the
# Mac's gh and glab logins (as vm:build-golden's), read again for each test
# (glab's expires within hours, and refreshes when read), over stdin only. Each
# test's output goes to data/projects/<project>/golden-image-tests.log, between
# a "== <repo> <test>: <command>" line and a "== exit <n> <seconds>s: <repo>
# <test>" one, so the log can be audited alone; its progress to stderr. Prints a markdown report — a row per test, then per
# repository: duration, passed, failed, pre-existing failures — and exits 1
# when a test failed that is not a pre-existing failure.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"

[[ $# -ge 1 ]] || { echo "usage: vm:test-repos <project> [<repository>…]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "vm:test-repos: no project '$1'" >&2; exit 1; }
project="$1" json="$projects/$1/project.json"; shift
folder="$(jq -r '.["golden-image"].folder // empty' "$json")"
[[ -n "$folder" ]] || { echo "vm:test-repos: $project has no golden-image in project.json" >&2; exit 1; }
[[ "$folder" == /* ]] || folder="$projects/../$folder"
tests="$folder/tests.json"
[[ -f "$tests" ]] || { echo "vm:test-repos: no $tests" >&2; exit 1; }
mapfile -t urls < <(jq -r '.repositories[]?.url' "$json")
mapfile -t all < <(printf '%s\n' "${urls[@]}" | sed -E 's/\.git$//; s|.*/||')
missing="$(jq -r --args '[$ARGS.positional[] as $r | select(.repositories[$r] | (.tests | type) != "array" and (.["no-tests"] | type) != "string") | $r] | join(", ")' "${all[@]}" < "$tests")"
[[ -z "$missing" ]] || { echo "vm:test-repos: $tests lists no tests for $missing: give each its \"tests\", or \"no-tests\" and why" >&2; exit 1; }
repos=("${all[@]}")
if [[ $# -gt 0 ]]; then
  for name in "$@"; do printf '%s\n' "${all[@]}" | grep -qxF -- "$name" || { echo "vm:test-repos: $project has no repository $name" >&2; exit 1; }; done
  repos=("$@")
fi
golden="golden-$project"
limactl list "$golden" --format '{{.Status}}' >/dev/null 2>&1 || { echo "vm:test-repos: no golden image $golden: build it with vm:build-golden $project" >&2; exit 1; }
forge_tokens vm:test-repos "${urls[@]}"
tokens() { printf '%s\n%s\n' "$gh_token" "$gl_token"; }
zot="$(jq -r '.registry.port // empty' "$json")"
log="$(cd "$projects/$project" && pwd -P)/golden-image-tests.log"
: > "$log"

# Epoch seconds, the same in every zone: a unique name, not a day or a time shown (ASS-294).
vm="test-$project-$(date +%s)"
trap 'limactl delete -f "$vm" >/dev/null 2>&1 || true' EXIT
limactl clone --tty=false "$golden" "$vm" --set ".mounts = [] | .ssh.localPort = $(free_port)" >/dev/null 2>&1 \
  || { echo "vm:test-repos: could not clone $golden into $vm" >&2; exit 1; }
start_sandboxed vm:test-repos "$vm" none $zot
echo "vm:test-repos: $vm cloned from $golden and started; log: $log" >&2

tokens | limactl shell --workdir / "$vm" -- bash -c '
set -euo pipefail
R="${HARNESS_VM_ROOT-}"   # empty in a VM; tests run this against a folder standing in for its root
IFS= read -r GH_TOKEN || true; IFS= read -r GITLAB_TOKEN || true
export GH_TOKEN GITLAB_TOKEN GIT_TERMINAL_PROMPT=0
vm="$1"; shift
for name in "$@"; do
  [ -d "$R/repos/$name/.git" ] || { echo "vm:test-repos: /repos/$name is missing in $vm" >&2; exit 1; }
  cd "$R/repos/$name"
  case "$(git remote get-url origin)" in https://github.com/*) user=x-access-token var=GH_TOKEN ;; *) user=oauth2 var=GITLAB_TOKEN ;; esac
  branch="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/master)"
  { git -c credential.helper= -c "credential.helper=!f() { test \"\$1\" = get && echo username=$user && echo \"password=\$$var\"; }; f" fetch -q origin \
    && git checkout -q -B "${branch#origin/}" "$branch"; } || { echo "vm:test-repos: could not check out master (${branch#origin/}) in /repos/$name" >&2; exit 1; }
done' test-repos-master "$vm" "${repos[@]}" >> "$log" 2>&1 || { tail -n 1 "$log" >&2; exit 1; }

runner=""
[[ ! -f "$folder/run-test.sh" ]] || runner="$(cat "$folder/run-test.sh")"
cell() { sed 's/|/\\|/g' <<< "$1"; }
rows=() totals=() failures=0
out="$(mktemp)"
for name in "${repos[@]}"; do
  reason="$(jq -r --arg r "$name" '.repositories[$r]["no-tests"] // empty' "$tests")"
  if [[ -n "$reason" ]]; then
    rows+=("| $name | — | — | — | no automated tests: $(cell "$reason") | |") totals+=("| $name | — | 0 | 0 | 0 |")
    continue
  fi
  passed=0 failed=0 pre=0 seconds=0
  while IFS= read -r t; do
    test_name="$(jq -r .name <<< "$t")" command="$(jq -r .command <<< "$t")" summary="$(jq -r '.summary // empty' <<< "$t")" evidence="$(jq -r '.["pre-existing"] // empty' <<< "$t")"
    echo "== $name $test_name: $command" >> "$log"
    forge_tokens vm:test-repos "${urls[@]}"   # again for each test: glab's token lasts hours, a run longer
    started=$SECONDS status=0 from=$(($(wc -c < "$log") + 1))   # the output goes to the log as it comes
    if [[ -n "$runner" ]]; then tokens | limactl shell --workdir "/repos/$name" "$vm" -- bash -c "$runner" run-test.sh "$command" >> "$log" 2>&1 || status=$?
    else limactl shell --workdir "/repos/$name" "$vm" -- bash -c "$command" < /dev/null >> "$log" 2>&1 || status=$?
    fi
    took=$((SECONDS - started)); seconds=$((seconds + took))
    tail -c +"$from" "$log" > "$out"
    echo "== exit $status ${took}s: $name $test_name" >> "$log"
    line=""
    [[ -z "$summary" ]] || line="$(sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$out" | grep -E -- "$summary" | tail -n 5 | paste -sd ';' - | sed 's/;/; /g' || true)"
    if [[ $status -eq 0 ]]; then result=passed passed=$((passed + 1))
    elif [[ -n "$evidence" ]]; then result="pre-existing failure (exit $status): $evidence" pre=$((pre + 1))
    else result="FAILED (exit $status)" failed=$((failed + 1))
    fi
    echo "vm:test-repos: $name $test_name: ${result%%:*} in ${took}s" >&2
    rows+=("| $name | $(cell "$test_name") | \`$(cell "$command")\` | ${took}s | $(cell "$result") |${line:+ $(cell "$line")} |")
  done < <(jq -c --arg r "$name" '.repositories[$r].tests[]' "$tests")
  totals+=("| $name | ${seconds}s | $passed | $failed | $pre |")
  failures=$((failures + failed))
done
rm -f "$out"

echo "## $project: every repository's tests in $vm, cloned from $golden"
echo
echo "| Repository | Test | Command | Duration | Result | Output |"
echo "|---|---|---|---|---|---|"
printf '%s\n' "${rows[@]}"
echo
echo "| Repository | Duration | Passed | Failed | Pre-existing failures |"
echo "|---|---|---|---|---|"
printf '%s\n' "${totals[@]}"
[[ $failures -eq 0 ]]
