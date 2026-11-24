#!/bin/bash
# ASS-515: run the suite with its own per-run TMPDIR and remove it at exit (pass,
# fail or interrupt), so `npm test` leaves nothing in /tmp. A fixed /tmp root (not
# $TMPDIR) keeps unix-socket paths short on macOS (ControlPath <= 86 chars).
# Args pass through to node --test; none = the whole suite.
# ASS-549 AC4: each test file's process loads test/support/run-guard.js, which
# keeps its reports from being lost at --test-force-exit's exit (the cause of the
# suite's varying totals) and notes, in the run's guard folder, a file cut short
# (reports still unwritten at its exit, or a process.exit() of its own mid-run).
# A run with any note fails (exit 1), the notes printed after node's summary.
run="$(mktemp -d /tmp/harness-test.XXXXXX)" || exit
sweep() { chmod -R u+w "$run" 2>/dev/null; rm -rf "$run" 2>/dev/null; }
trap 'sweep; [[ -e $run ]] && { sleep 1; sweep; }' EXIT
[[ $# -gt 0 ]] || set -- 'test/**/*.test.js'
guard="$run/.guard"
mkdir "$guard" || exit
TMPDIR="$run" HARNESS_TEST_GUARD="$guard" node --import "$(cd "$(dirname "$0")" && pwd)/support/run-guard.js" --test --test-timeout=600000 --test-force-exit "$@"
status=$?
if compgen -G "$guard/*" > /dev/null; then
  echo "✖ test/run.sh: test files cut short — their totals above are incomplete:"
  cat "$guard"/* | sed 's/^/  /'
  [[ $status -ne 0 ]] || status=1
fi
exit "$status"
