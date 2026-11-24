#!/bin/bash
# ASS-532 spike: start N ticket sandboxes (d1..dN) from TEMPLATE, each holding an
# idle Claude-Code-sized process (node holding HOLD_MB of touched heap), and
# report the memory before, with them running, and after
# suspending them all. Usage: ATE=<kate> density.sh <N>
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; n="$1"; ATE="${ATE:-kubectl-ate}"; node="${NODE:-ass532-control-plane}"
# gVisor's guest memory is a memfd (shmem, not anon), so the figure is the sum
# of the worker pods' cgroups (worker-mem.sh), plus the node's anon for the rest.
anon() { echo "workers $("$here/worker-mem.sh" | sed -E 's/.*mem=([0-9]+)MiB.*/\1/' | paste -sd+ - | bc) MiB, node anon $(docker exec "$node" bash -c 'echo $(( $(grep "^anon " /sys/fs/cgroup/memory.stat | cut -d" " -f2)/1048576 ))')"; }
echo "node anon before: $(anon) MiB"
for i in $(seq 1 "$n"); do TEMPLATE="${TEMPLATE:-harness-v2}" ATE="$ATE" "$here/up.sh" "d$i" "$((8100+i))"; done
for i in $(seq 1 "$n"); do
  PORT=$((8100+i)) "$here/sx.sh" "sudo -u agent setsid nohup node -e 'const b=Buffer.alloc(${HOLD_MB:-300}*1048576, 1); setInterval(()=>b[0]++, 1000)' >/dev/null 2>&1 </dev/null & echo -n" 20s
done
sleep 10; echo "node anon with $n running, each holding ${HOLD_MB:-300} MB: $(anon) MiB"
s=$(date +%s); for i in $(seq 1 "$n"); do $ATE suspend actor "d$i" -a harness-tickets >/dev/null & done; wait
echo "suspended all $n in $(( $(date +%s) - s )) s"; sleep 10; echo "node anon with $n suspended: $(anon) MiB"
