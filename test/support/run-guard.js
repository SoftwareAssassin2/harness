// ASS-549 AC4: test/run.sh loads this (node --import) into each test file's
// process, so a file can't end its run silently short. Full-suite totals
// varied between runs (4241–4309) with no file failing: with
// --test-force-exit, node --test's child calls process.exit() as soon as its
// last test ends, and the reports still queued on its stdout pipe (async on
// macOS) were dropped — the tail of a file's tests never reached the runner,
// which saw a clean exit 0. A loaded Mac drains the pipe more slowly, so more
// was lost (a file of 400 tests, 16 runs at once: 4 lost 16–31 tests).
//
// In a test file's process (node --test's child: NODE_TEST_CONTEXT child-v8,
// its main module a *.test.js), with HARNESS_TEST_GUARD=<folder> set by
// run.sh:
// - its stdout is made blocking, so every report is written before it exits;
// - a report still unwritten as it exits, or a process.exit() not made by the
//   test runner (code under test ending the file mid-run: the runner counts
//   the tests it heard of and passes), leaves a note in <folder>, which
//   run.sh prints and fails the run on.
// Anything else (node itself, the processes tests start, a run without
// run.sh) is untouched.
import { writeFileSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';

const folder = process.env.HARNESS_TEST_GUARD;
const file = process.argv[1] ?? '';
if (folder && process.env.NODE_TEST_CONTEXT === 'child-v8' && /\.test\.[cm]?js$/.test(file)) {
  process.stdout._handle?.setBlocking?.(true);
  const name = file.startsWith(process.cwd() + '/') ? relative(process.cwd(), file) : file;
  const note = why => {
    const text = `${name}: ${why}\n`;
    try { writeFileSync(join(folder, `${process.pid}.txt`), text, { flag: 'a' }); } catch { writeSync(2, `test/run.sh guard: ${text}`); }
  };
  const exit = process.exit;
  process.exit = function (code) {
    const stack = new Error().stack.split('\n').slice(2);
    if (!stack.some(line => line.includes('node:internal/test_runner'))) {
      note(`cut short: process.exit(${code ?? ''}) called while its tests ran, not by the test runner — the tests after it never ran\n  ${stack.slice(0, 4).map(l => l.trim()).join('\n  ')}`);
    }
    return exit.apply(this, arguments);
  };
  process.on('exit', () => {
    const left = process.stdout.writableLength;
    if (left > 0) note(`cut short: ${left} bytes of its test reports were still unwritten as it exited — those tests are missing from the totals`);
  });
}
