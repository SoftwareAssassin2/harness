#!/bin/bash
# ASS-532 spike: hibernate a sandbox while Claude Code waits on a model call.
# The "model" is the echo server's /delay45 (answers after 45 s; no real API,
# placeholder key). Starts `claude -p` in the actor, suspends it 12 s later,
# resumes after WAIT, then shows Claude Code's outcome and how many model calls
# the upstream saw. Usage: ATE=<kate> PORT=<proxy port> midturn.sh <actor>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; a="$1"; ATE="${ATE:-kubectl-ate}"
"$here/sx.sh" 'cd /home/agent; rm -f midturn.log; sudo -u agent env HOME=/home/agent ANTHROPIC_BASE_URL=http://echo.spike-echo.svc.cluster.local/delay45 ANTHROPIC_API_KEY=placeholder CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 setsid nohup bash -c "date -u +start=%T; time claude -p \"say hi\" --model claude-sonnet-4-5; echo exit=\$?; date -u +end=%T" > /home/agent/midturn.log 2>&1 < /dev/null & sleep 2; pgrep -fc "claude -p"' 20s
sleep 12; date -u +"suspend %T"; $ATE suspend actor "$a" -a harness-tickets --mode=sync | tail -1
WAIT="${WAIT:-20}" CHECK=100 "$here/resume-check.sh" "$a" "$PORT" | head -3
"$here/sx.sh" 'cat /home/agent/midturn.log | grep -v "^\s*$" | cut -c1-200 | tail -12' 20s
kubectl --context "${KCTX:-kind-ass532}" -n spike-echo logs deploy/echo --since=5m | grep -E 'messages' | cut -c1-70
