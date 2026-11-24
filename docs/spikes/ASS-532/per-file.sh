#!/bin/bash
# ASS-532 spike: start one harness test file (or the whole suite with no
# argument) in a sandbox (PORT=<proxy port>), detached, logging to
# /home/agent/<name>.log; per-file.sh --show <name> prints node's summary and
# the seconds it took. Usage: PORT=... per-file.sh <name> [test/<file>.test.js]
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = --show ]; then
  PORT="$PORT" "$here/sx.sh" "grep -aE '^ℹ (tests|pass|fail) |^seconds=' /home/agent/$2.log || echo running: \$(grep -ac '✔' /home/agent/$2.log) passed so far" 30s; exit
fi
PORT="$PORT" "$here/sx.sh" "nohup sudo -u agent bash -c 'cd /repos/harness; s=\$(date +%s); bash test/run.sh $2 > /home/agent/$1.log 2>&1; echo seconds=\$(( \$(date +%s) - s )) >> /home/agent/$1.log' >/dev/null 2>&1 </dev/null & echo started $1" 20s
