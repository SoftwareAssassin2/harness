#!/bin/bash
# ASS-532 spike: memory and CPU time of each worker pod in a namespace (its
# whole pod cgroup, the gVisor sandbox included), read inside the kind node.
# Usage: worker-mem.sh [namespace] [context] [node]
ns="${1:-harness-tickets}"; ctx="${2:-kind-ass532}"; node="${3:-ass532-control-plane}"
kubectl --context "$ctx" -n "$ns" get pods -o jsonpath='{range .items[*]}{.metadata.name} {.metadata.uid}{"\n"}{end}' |
while read -r name uid; do
  docker exec "$node" bash -c "d=\$(find /sys/fs/cgroup/kubelet.slice -maxdepth 3 -type d -name '*pod${uid//-/_}.slice' | head -1)
    echo \"$name mem=\$(( \$(cat \$d/memory.current) / 1048576 ))MiB peak=\$(( \$(cat \$d/memory.peak) / 1048576 ))MiB cpu_s=\$(( \$(grep usage_usec \$d/cpu.stat | cut -d' ' -f2) / 1000000 ))\""
done
