#!/bin/bash
# agent.sh in a ticket variation's VM (ASS-74), installed by vm:start at
# /usr/local/bin/agent.sh: sends its arguments and this VM's token to the
# forwarder on the Mac (src/control/forwarder.js), which runs the real
# agent.sh there, for this VM's ticket variation alone, and replays its
# stdout, stderr and exit code. A refused call exits 77, saying why; a
# forwarder that cannot be reached, 125. stdin is read and sent, base64, only
# for the commands that take it, listed below (ASS-181, ASS-182: /mnt/ticket is
# read-only, so every write's content comes this way; ASS-238: a merge
# request's description and screenshots; ASS-239: a review thread's reply), at most 1 MB — over it, this
# fails (1) before sending anything; any other command's stdin is never read,
# so an open, idle one cannot hold it up. The forwarder's URL and the token are on
# tmpfs, written at every start: /run/harness/agent-url and agent-token
# (AGENT_FORWARDER_URL and AGENT_TOKEN_FILE override them, for tests).
# Needs curl, jq and base64.
set -uo pipefail
url="${AGENT_FORWARDER_URL:-$(cat /run/harness/agent-url 2>/dev/null)}"
token_file="${AGENT_TOKEN_FILE:-/run/harness/agent-token}"
token="$( [ -r "$token_file" ] && tr -d '[:space:]' < "$token_file" || true)"
STDIN_CAP=1048576
takes_stdin() { case "$1" in work:write|work:append|work:add-screenshot|automated-tests:record|ticket:set-demo-plan|ticket:post-comment|ticket:set-acceptance-criteria|ticket:set-merge-request-plan|merge-request:update|merge-request:upload-image|merge-request:reply) return 0 ;; *) return 1 ;; esac; }
if takes_stdin "${1:-}"; then
  # One more byte than the cap is read, to tell over it; base64 is 4 characters to 3 bytes, less its padding.
  stdin="$(head -c $((STDIN_CAP + 1)) | base64 | tr -d '\n')"
  pad="${stdin##*[!=]}"
  (( ${#stdin} / 4 * 3 - ${#pad} <= STDIN_CAP )) || { echo "agent.sh: stdin is over 1 MB: not sent" >&2; exit 1; }
  # Through jq's stdin, not an argument: Linux caps one argument at 128 KB.
  body="$(jq -cR --arg t "$token" '{ token: $t, argv: $ARGS.positional, stdin: . }' --args "$@" <<<"$stdin")"
else
  body="$(jq -cn --arg t "$token" '{ token: $t, argv: $ARGS.positional }' --args "$@")"
fi
rc=1
while IFS= read -r line; do
  if o=$(jq -er '.o // empty' <<<"$line"); then base64 -d <<<"$o"; fi
  if e=$(jq -er '.e // empty' <<<"$line"); then base64 -d <<<"$e" >&2; fi
  if r=$(jq -er '.refused // empty' <<<"$line"); then echo "agent.sh: refused by the host: $r" >&2; rc=77; fi
  if x=$(jq -er '.exit // empty' <<<"$line"); then rc=$x; fi
  if jq -e '.unreachable' <<<"$line" >/dev/null 2>&1; then echo "agent.sh: host forwarder unreachable at ${url:-(no /run/harness/agent-url)}" >&2; rc=125; fi
done < <(curl -sS -N --fail-with-body -X POST -H 'content-type: application/json' --data-binary @- "${url:-http://unset.invalid/}" <<<"$body" 2>/dev/null || [ $? = 22 ] || echo '{"unreachable":true}')
exit "$rc"
