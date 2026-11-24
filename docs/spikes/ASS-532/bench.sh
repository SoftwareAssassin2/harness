#!/bin/bash
# ASS-532 spike: tiny process/filesystem benchmark, run the same way on the Mac,
# in a gVisor sandbox and in a microVM sandbox (cwd: a harness checkout).
t() { local s=$(date +%s%N 2>/dev/null); "$@" >/dev/null 2>&1; echo "$(( ($(date +%s%N) - s) / 1000000 ))"; }
echo "500 x /bin/true (fork+exec): $(t bash -c 'for i in $(seq 500); do /bin/true; done') ms"
echo "200 x bash -c jq: $(t bash -c 'for i in $(seq 200); do echo {} | jq . ; done') ms"
echo "git status x20: $(t bash -c 'for i in $(seq 20); do git status --short; done') ms"
echo "node -e 0 x20: $(t bash -c 'for i in $(seq 20); do node -e 0; done') ms"
echo "write+read 2000 small files: $(t bash -c 'd=$(mktemp -d); for i in $(seq 2000); do echo $i > $d/$i; done; cat $d/* > /dev/null; rm -rf $d') ms"
