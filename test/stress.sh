#!/bin/bash
# ASS-545: the stress check — the suite (or the files given) run several times at once, as the overnight build of
# 2026-11-22 ran four worktrees' suites side by side (load 50-85 on 14 cores), to show the tests do not depend on the
# machine's speed. `npm run test:stress [-- [-n <runs>] [<test files>…]]`: <runs> (default 4, or STRESS_RUNS)
# copies of test/run.sh at once, each its own TMPDIR (run.sh's), its output kept in a log under one folder; prints
# each run's pass and fail counts and the failing tests, and exits 1 when any run failed.
runs="${STRESS_RUNS:-4}"
if [[ "${1-}" == -n ]]; then runs="$2"; shift 2; fi
[[ "$runs" =~ ^[1-9][0-9]*$ ]] || { echo "test:stress: -n wants a number of runs above 0, not '$runs'" >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd)"
logs="$(mktemp -d /tmp/harness-stress.XXXXXX)" || exit
echo "test:stress: $runs runs at once of ${*:-the whole suite}; logs in $logs"
began=$SECONDS
for ((i = 1; i <= runs; i++)); do
  ( cd "$here" && bash test/run.sh "$@" > "$logs/run-$i.log" 2>&1; echo $? > "$logs/run-$i.exit" ) &
done
wait
failed=0
for ((i = 1; i <= runs; i++)); do
  code="$(cat "$logs/run-$i.exit")"
  pass="$(grep -m1 -E '^ℹ pass ' "$logs/run-$i.log" | awk '{print $3}')"
  fail="$(grep -m1 -E '^ℹ fail ' "$logs/run-$i.log" | awk '{print $3}')"
  echo "run $i: exit $code, ${pass:-?} passed, ${fail:-?} failed"
  if [[ "$code" != 0 ]]; then
    failed=1
    sed -n '/^✖ failing tests:/,$p' "$logs/run-$i.log" | grep -E '^✖ ' | grep -v 'failing tests:' | grep -v '^✖ test/run.sh:' | sed 's/^/  /'
    # ASS-549: the files run.sh's guard found cut short (their tests missing from the totals)
    sed -n '/^✖ test\/run.sh: test files cut short/,$p' "$logs/run-$i.log" | grep -E '^  [^ ]' | sed 's/^  /  cut short: /'
  fi
done
echo "test:stress: $(( SECONDS - began ))s; load averages now: $(uptime | sed 's/.*averages*: //')"
exit "$failed"
