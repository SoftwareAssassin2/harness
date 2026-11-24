#!/usr/bin/env bash
# Description: Bring up the project's whole app stack in a ticket variation's Substrate sandbox — every declared service and init job in dependency order, the hostname map, the local CA, the app at its real local URL, the seeded user signed in — and keep its logs and start and resume times in the ticket's folder — substrate:stack-up <project> <ticket-key> <variation> [--after created|resumed|started <seconds>]; prints JSON, exits 3 when the stack fails.
set -euo pipefail

# ASS-542. Control runs it right after substrate:sandbox-up, beside the tick
# (src/control/sandboxes.js), every time it brings a variation's sandbox up;
# so does an operator by hand. In the sandbox, as its user agent:
#  1. `sandbox-services up` (src/substrate/image/sandbox-services): the host
#     map, each declared service and job in `after` order waiting for its
#     dependencies' health checks, jobs (migrations, bootstraps, seeds) once
#     per sandbox, the CA trusted, the app answering. A resumed sandbox kept
#     its processes and its jobs' marks, so this only checks the app then.
#  2. With a declared login: on the sandbox's first start `sandbox-services
#     login` (the headless browser signs in as the seeded user, its session
#     kept in the sandbox); after a resume `login --check` (the kept session
#     still loads the app signed in), and a fresh sign-in when it does not.
# The ticket's folder (data/projects/<p>/work/<KEY>/) gets
#   sandbox-stack-<var>/           the sandbox's /var/log/sandbox (each service's and job's log), its
#                                  stack.json, login.json: replaced by each run
#   sandbox-times-<var>.jsonl      a line per run: { at, machine, sandbox, after (created, resumed,
#                                  started), sandbox-seconds (sandbox-up's), stack-seconds, login-seconds,
#                                  total-seconds, state, session-kept }
#   sandbox-times-<var>.json       { first-start: <the first run that brought the stack up>, last-resume:
#                                  <the last resumed run that did>, made-at, runs } — of the variation's latest
#                                  sandbox (the runs since the last `created` one): time to first start and to
#                                  resume (AC6)
# --after says what sandbox-up did just before and how long it took (its
# output's created / resumed and seconds); without it, "started" and 0.
# A project with no stack (no service or job in its services.yaml) prints
# { stack: false } and does nothing. Prints { state: up|failed, stack: true,
# seconds, failed, login, folder }; a failure exits 3 with its reason — the
# service or job and its log in the ticket's folder — on stderr (control
# then sends the ticket to Blocked with it).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/sandbox.bash"
source "$here/../machine.bash"
source "$here/../json-file.bash"

command=substrate:stack-up
usage() { echo "usage: $command <project> <ticket-key> <variation> [--after created|resumed|started <seconds>]" >&2; exit 1; }
[[ $# -eq 3 || $# -eq 6 ]] || usage
project="$1" key="$(upper "$2")" variation="$3" after=started before=0
if [[ $# -eq 6 ]]; then
  [[ "$4" == --after && "$5" =~ ^(created|resumed|started)$ && "$6" =~ ^[0-9]+(\.[0-9]+)?$ ]] || usage
  after="$5" before="$6"
fi
declaration="$(node "$here/../../substrate/services-cli.js" read "$projects/$project/sandbox" 2>&1)" \
  || { echo "$command: $project's sandbox declaration is wrong: $declaration" >&2; exit 1; }
if [[ "$declaration" == null ]] || ! jq -e '.services | any(.kind == "service" or .kind == "job")' <<< "$declaration" >/dev/null; then
  jq -nc '{ stack: false }'; exit 0
fi
record="$(sandbox_of "$command" "$project" "$key" "$variation")" || { echo "$command: no $key variation $variation in $project's sprint" >&2; exit 1; }
[[ "$record" != null ]] || { echo "$command: $key $variation has no sandbox (substrate:sandbox-up first)" >&2; exit 1; }
machine="$(jq -r .machine <<< "$record")" actor="$(jq -r .name <<< "$record")"
name="substrate:$project:$machine:$actor"
work="$projects/$project/work/$key"
folder="$work/sandbox-stack-$variation"
mkdir -p "$work"
started=$SECONDS

# json_or <text> <default> — <text> when it is one JSON value, else <default>.
json_or() { if [[ -n "$1" ]] && jq -e . <<< "$1" >/dev/null 2>&1; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

# keep — the sandbox's logs, stack.json and login.json copied into the ticket's folder (whatever is there).
keep() {
  local tmp
  tmp="$(mktemp -d "$work/.sandbox-stack.XXXXXX")"
  machine_copy_out "$name" /var/log/sandbox "$tmp/logs" </dev/null >/dev/null 2>&1 || true
  machine_copy_out "$name" /var/lib/sandbox/stack/stack.json "$tmp/stack.json" </dev/null >/dev/null 2>&1 || true
  [[ -z "${login_out:-}" ]] || printf '%s\n' "$login_out" | replace_file "$tmp/login.json"
  rm -rf "$folder" && mv "$tmp" "$folder"
}

stack_out="$(substrate_run "" "" "" "${name#substrate:}" sandbox-services up </dev/null 2>"$work/.stack-up-$variation.err")" && code=0 || code=$?
stack_out="$(json_or "$(tail -n 1 <<< "$stack_out")" '{}')"
stack_seconds="$(jq -r '.seconds // 0' <<< "$stack_out")"
state="$(jq -r '.state // empty' <<< "$stack_out")"
login_out="" login_seconds=0 session=null
if [[ $code -eq 0 && "$state" == up ]] && jq -e '.login != null' <<< "$declaration" >/dev/null; then
  if [[ "$after" == resumed ]]; then
    login_out="$(substrate_run "" "" "" "${name#substrate:}" sandbox-services login --check </dev/null 2>>"$work/.stack-up-$variation.err" | tail -n 1)" || true
    session="$(jq '.ok == true' <<< "$(json_or "$login_out" "{}")" 2>/dev/null || echo false)"
  fi
  if [[ "$after" != resumed || "$session" != true ]]; then
    login_out="$(substrate_run "" "" "" "${name#substrate:}" sandbox-services login </dev/null 2>>"$work/.stack-up-$variation.err" | tail -n 1)" || true
  fi
  login_seconds="$(jq -r '.seconds // 0' <<< "$(json_or "$login_out" "{}")")"
  if ! jq -e '.ok == true' <<< "$(json_or "$login_out" "{}")" >/dev/null 2>&1; then
    state=failed code=3
    stack_out="$(jq -c --arg why "$(jq -r '.why // "no answer"' <<< "$(json_or "$login_out" "{}")" 2>/dev/null || echo 'no answer')" \
      '.state = "failed" | .failed = { name: "login", kind: "login", why: $why, log: null }' <<< "$stack_out")"
  fi
fi
keep
total="$(awk -v a="$before" -v b="$((SECONDS - started))" 'BEGIN { printf "%.1f", a + b }')"
[[ "$state" == up ]] || state=failed
line="$(jq -nc --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg m "$machine" --arg a "$actor" --arg after "$after" --arg b "$before" \
  --arg s "$stack_seconds" --arg l "$login_seconds" --arg t "$total" --arg state "$state" --argjson session "$session" \
  '{ at: $at, machine: $m, sandbox: $a, after: $after, "sandbox-seconds": ($b | tonumber), "stack-seconds": ($s | tonumber),
     "login-seconds": ($l | tonumber), "total-seconds": ($t | tonumber), state: $state, "session-kept": $session }')"
append_line "$work/sandbox-times-$variation.jsonl" "$line"
jq -sc '(([to_entries[] | select(.value.after == "created") | .key] | last) // 0) as $made | .[$made:] as $this
  | { "first-start": ($this | map(select(.state == "up")) | first), "last-resume": ($this | map(select(.after == "resumed" and .state == "up")) | last),
      "made-at": ($this[0].at // null), runs: length }' \
  "$work/sandbox-times-$variation.jsonl" | replace_file "$work/sandbox-times-$variation.json"

if [[ "$state" != up ]]; then
  why="$(jq -r 'if .failed then (if .failed.kind == .failed.name then .failed.name else "\(.failed.kind) \(.failed.name)" end) + ": \(.failed.why)" else empty end' <<< "$stack_out" 2>/dev/null || true)"
  failed_log="$(jq -r '.failed.log // empty | split("/") | last' <<< "$stack_out" 2>/dev/null || true)"
  [[ -n "$why" ]] || why="sandbox-services up gave no answer (exit $code): $(tail -n 3 "$work/.stack-up-$variation.err" 2>/dev/null | tr '\n' ' ')"
  [[ -z "$failed_log" ]] || why+=" — its log: $folder/logs/$failed_log"
  rm -f "$work/.stack-up-$variation.err"
  jq -c --arg f "$folder" '. + { stack: true, folder: $f }' <<< "$(json_or "$stack_out" "{}")" 2>/dev/null || jq -nc --arg f "$folder" '{ state: "failed", stack: true, folder: $f }'
  echo "$command: $key $variation's app stack in its sandbox $actor on $machine failed: $why" >&2
  exit 3
fi
rm -f "$work/.stack-up-$variation.err"
jq -c --arg f "$folder" --argjson login "$(json_or "$login_out" null)" --argjson session "$session" \
  '{ state, stack: true, seconds, app, failed, login: $login, "session-kept": $session, folder: $f }' <<< "$stack_out"
