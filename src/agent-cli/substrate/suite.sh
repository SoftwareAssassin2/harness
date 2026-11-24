#!/usr/bin/env bash
# Description: Run one of the project's declared test suites (services.yaml suites: the ones its compose files ran) inside a ticket variation's Substrate sandbox against the sandbox's own app stack, its log kept in the ticket's folder — substrate:suite <project> <ticket-key> <variation> <suite>; exits with the suite's exit code.
set -euo pipefail

# ASS-542 AC9. A project's compose-based suites (end-to-end tests that start
# their stack with `docker compose`) run in a sandbox against the stack the
# sandbox already runs natively: `sandbox-services suite <name>` there, as its
# user agent — what the suite names in `after` started first (substrate:stack-up
# brings up the rest), the suite's run in its workdir with its env, and, for one
# declared `docker: true`, the image's sandbox-docker first on its PATH as
# `docker` (compose up/ps/exec/run/logs against the stack; down a no-op).
# How each suite runs there is the project's declaration
# (data/projects/<p>/sandbox/services.yaml), never a change to its
# repositories. Its output streams here; its log is kept as
# data/projects/<p>/work/<KEY>/sandbox-stack-<var>/suite-<suite>.log and its
# result as suite-<suite>.json ({ suite, exit-code, seconds, at }).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"
source "$here/../machine.bash"

command=substrate:suite
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <suite>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" suite="$4"
[[ "$suite" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "$command: no suite '$suite' (lower-case letters, digits and -)" >&2; exit 1; }
declaration="$(node "$here/../../substrate/services-cli.js" read "$projects/$project/sandbox" 2>&1)" \
  || { echo "$command: $project's sandbox declaration is wrong: $declaration" >&2; exit 1; }
jq -e --arg s "$suite" '(.suites // []) | any(.name == $s)' <<< "$declaration" >/dev/null 2>&1 \
  || { echo "$command: $project declares no suite $suite (its sandbox/services.yaml suites: $(jq -r '[(.suites // [])[].name] | join(", ")' <<< "$declaration" 2>/dev/null))" >&2; exit 1; }
record="$(sandbox_of "$command" "$project" "$key" "$variation")" || { echo "$command: no $key variation $variation in $project's sprint" >&2; exit 1; }
[[ "$record" != null ]] || { echo "$command: $key $variation has no sandbox (substrate:sandbox-up first)" >&2; exit 1; }
name="substrate:$project:$(jq -r .machine <<< "$record"):$(jq -r .name <<< "$record")"
folder="$projects/$project/work/$key/sandbox-stack-$variation"
mkdir -p "$folder"
code=0
substrate_run "" "" "" "${name#substrate:}" sandbox-services suite "$suite" </dev/null || code=$?
machine_copy_out "$name" "/var/log/sandbox/suite-$suite.log" "$folder/suite-$suite.log" </dev/null >/dev/null 2>&1 || true
machine_copy_out "$name" "/var/lib/sandbox/stack/suites/$suite.json" "$folder/suite-$suite.json" </dev/null >/dev/null 2>&1 || true
exit "$code"
