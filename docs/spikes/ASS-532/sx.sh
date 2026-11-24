#!/bin/bash
# ASS-532 spike: run a shell command in a sandbox actor through `kubectl ate
# proxy actor` (already running on 127.0.0.1:$PORT) and the actor's /process
# server. Substrate has no exec API, so this is how the harness would have to
# run commands in a sandbox. Usage: PORT=8000 sx.sh '<shell command>' [timeout]
# Prints stdout, then stderr, and exits with the command's exit code.
set -euo pipefail
out="$(jq -n --arg c "$1" --arg t "${2:-280s}" '{command:["bash","-lc",$c], timeout:$t, cwd:"/repos/harness"}' \
  | curl -sS --max-time 300 -X POST -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:${PORT:-8000}/process")"
jq -r '.stdout' <<<"$out"; jq -r '.stderr | select(. != "")' <<<"$out" >&2
exit "$(jq -r '.exitCode' <<<"$out")"
