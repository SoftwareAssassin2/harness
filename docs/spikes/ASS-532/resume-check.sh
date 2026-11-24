#!/bin/bash
# ASS-532 spike: after `kubectl ate suspend actor <a>`, wait WAIT seconds, resume it
# (timed), re-open the proxy, give the tlshold processes CHECK seconds, then
# show whether they, their connections and the checkout survived.
# Usage: ATE=<kate> resume-check.sh <actor> <port>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; a="$1"; port="$2"; ATE="${ATE:-kubectl-ate}"
sleep "${WAIT:-40}"
date -u +"resume at %T"; /usr/bin/time -p $ATE resume actor "$a" -a harness-tickets 2>&1 | grep -E '^real|STATE|ERR|rror'
pkill -f "proxy actor $a " 2>/dev/null; nohup $ATE proxy actor "$a" "$port:80" -a harness-tickets >/dev/null 2>&1 &
sleep "${CHECK:-30}"
PORT=$port "$here/sx.sh" 'echo "tlshold processes: $(pgrep -fc tlshold)"; cat /repos/harness/HIBERNATE-TEST.txt; for n in A B C; do [ -f /home/agent/tls-$n.log ] || continue; echo "== $n"; grep -vE "tick$" /home/agent/tls-$n.log | tail -5 | cut -c1-220; grep -E "tick$" /home/agent/tls-$n.log | tail -4 | cut -c1-40; done' 30s
