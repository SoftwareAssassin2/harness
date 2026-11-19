#!/bin/bash
# ASS-515: run the suite with its own per-run TMPDIR and remove it at exit (pass,
# fail or interrupt), so `npm test` leaves nothing in /tmp. A fixed /tmp root (not
# $TMPDIR) keeps unix-socket paths short on macOS (ControlPath <= 86 chars).
# Args pass through to node --test; none = the whole suite.
run="$(mktemp -d /tmp/harness-test.XXXXXX)" || exit
sweep() { chmod -R u+w "$run" 2>/dev/null; rm -rf "$run" 2>/dev/null; }
trap 'sweep; [[ -e $run ]] && { sleep 1; sweep; }' EXIT
[[ $# -gt 0 ]] || set -- 'test/**/*.test.js'
TMPDIR="$run" node --test --test-timeout=600000 --test-force-exit "$@"
