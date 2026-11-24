#!/bin/bash
# ASS-532 spike: create (if needed) and resume a ticket sandbox, then proxy
# 127.0.0.1:<port> to its port 80. Usage: up.sh <actor> <port>. Times each step.
set -uo pipefail
ATE="${ATE:-kubectl-ate}"; a="$1"; port="$2"   # ATE: e.g. a wrapper adding --context
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
t0=$(ms); $ATE create actor "$a" -a harness-tickets --template "${TEMPLATE:-harness-ticket}" 2>&1 | grep -v Warning >/dev/null; t1=$(ms)
$ATE resume actor "$a" -a harness-tickets 2>&1 | grep -v Warning >/dev/null; t2=$(ms)
pkill -f "proxy actor $a " 2>/dev/null
nohup $ATE proxy actor "$a" "$port:80" -a harness-tickets >"/tmp/ASS-532/notes/proxy-$a.log" 2>&1 &
until curl -s -o /dev/null -m 2 -X POST -d '{"command":["true"]}' "http://127.0.0.1:$port/process"; do sleep 0.2; done; t3=$(ms)
echo "$a: create $((t1-t0)) ms, resume $((t2-t1)) ms, first /process answer after $((t3-t2)) ms"
