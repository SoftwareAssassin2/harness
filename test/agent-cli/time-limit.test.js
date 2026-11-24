// ASS-549 AC3: automated-tests.bash's time_limited (TIME_LIMIT) never puts
// bash's job-control noise into a run's output. With job control on (set -m),
// each forked child puts itself in a process group of its own, and on macOS
// that setpgid sometimes fails: the child says "bash: child setpgid (N to N):
// Operation not permitted" on the shell's stderr before the command's own
// redirections apply. Unfixed it showed in about 1 run in 300 even on an idle
// Mac (5 of 1,600 here), so the test makes many runs at once and checks none
// says it, and that the command's own output, stderr and exit code still
// come through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const LIB = fileURLToPath(new URL('../../src/agent-cli/automated-tests.bash', import.meta.url));
const SETPGID = /child setpgid/;

// <runs> time-limited runs of a command printing to stdout and stderr and exiting 3, one after another in one bash;
// each run's stdout and stderr captured together (as verify-success's run_test does), one line of totals per run.
const batch = runs => run('bash', ['-c', `source "$1"
limited="$(time_limited 1 'echo out; echo err >&2; exit 3')"
for ((i = 0; i < $2; i++)); do
  o="$(bash -c "$limited" 2>&1)"; s=$?
  printf '%s|%s\\n' "$s" "$(printf '%s' "$o" | tr '\\n' ' ')"
done`, 'batch', LIB, String(runs)], { maxBuffer: 64 * 1024 * 1024 });

test('ASS-549 AC3: a time-limited run\'s output never holds bash\'s "child setpgid" job-control line, and keeps the command\'s own stdout, stderr and exit code', async () => {
  const outs = await Promise.all(Array.from({ length: 8 }, () => batch(250)));
  const lines = outs.flatMap(r => r.stdout.trim().split('\n'));
  assert.equal(lines.length, 2000);
  assert.deepEqual(lines.filter(l => SETPGID.test(l)), [], 'no run\'s output has the job-control line');
  assert.deepEqual([...new Set(lines)], ['3|out err'], 'every run: exit 3, its stdout and stderr');
  assert.deepEqual(outs.map(r => r.stderr).filter(Boolean), []);
});

test('ASS-549 AC3: a run stopped at its limit still says so on stderr, exit 124 (the shell\'s stderr given back after the forks)', async () => {
  const r = await run('bash', ['-c', `source "$1"; dir="$(mktemp -d)"; gate="$dir/gate"
AUTOMATED_TESTS_LIMIT_GATE="$gate"; limited="$(time_limited 0.5 "echo started; touch '$gate'; sleep 600")"
o="$(bash -c "$limited" 2>&1)"; s=$?; rm -rf "$dir"; printf '%s|%s' "$s" "$o"`, 'stop', LIB]);
  assert.equal(r.stdout, 'started\nautomated-tests:verify-success: timed out after 0.5 minutes'.replace(/^/, '124|'));
});
