#!/usr/bin/env bash
# Description: Record a ticket variation's automated tests, the JSON list on stdin — automated-tests:record <project> <ticket-key> <variation>.
set -euo pipefail

# Generate Automated Tests records the tests it wrote (ASS-180) into the
# ticket's folder, data/projects/<project>/work/<KEY>/automated-tests-<variation>.json,
# a WORK_MANAGED file work:write will not touch. Stdin, one JSON value, must
# be [] (manual-only, ASS-49) or a list of { "list": "<command>", "run":
# "<command>" }, each a string — the shape automated-tests.bash checks — and
# optionally "reproduces": true or false (ASS-227: red on master by design, see
# verify-success.sh). It is
# stored verbatim (byte for byte), under the file's lock, through a temp file
# renamed over it (json-file.bash replace_file), so a reader sees the old file
# or the new one. Fails, writing nothing, on an invalid path or input — and
# (ASS-353) on an entry whose run command brings a docker compose stack up
# under a fixed project name with no `docker compose down -v` before it
# (compose-reset.js): its volumes would carry one run's database into the
# next, so a migration a later step renumbered fails the next run before a
# test does.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

command=automated-tests:record
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation> < json" >&2; exit 1; }
file="$(work_path "$command" "$1" "$2" "$3" "automated-tests-$3.json")"

input="$(cat; echo x)"; input="${input%x}"
printf '%s' "$input" | jq -se 'length == 1 and (.[0] | type == "array" and all(.[]; type == "object" and (.list | type) == "string" and (.run | type) == "string" and ((.reproduces // false) | type) == "boolean"))' >/dev/null 2>&1 \
  || { echo "$command: stdin must be [] or a list of { \"list\": \"<command>\", \"run\": \"<command>\" }, each a string, with an optional boolean \"reproduces\": $(basename "$file") left as it was" >&2; exit 1; }

reusing="$(printf '%s' "$input" | node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/compose-reset.js")" \
  || { echo "$command: could not check the run commands' docker compose stacks: $(basename "$file") left as it was" >&2; exit 1; }
[[ -z "$reusing" ]] || { printf '%s: a run command brings a docker compose stack up reusing the volumes an earlier run left: run `docker compose down -v` first in it (or use a per-run-unique COMPOSE_PROJECT_NAME), so each run starts from a fresh database; %s left as it was:\n%s\n' "$command" "$(basename "$file")" "$reusing" >&2; exit 1; }

lock_on 9 "$file.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}" || { echo "$command: $(basename "$file") left as it was" >&2; exit 1; }
printf '%s' "$input" | replace_file "$file" || { echo "$command: the write failed: $(basename "$file") left as it was" >&2; exit 1; }
