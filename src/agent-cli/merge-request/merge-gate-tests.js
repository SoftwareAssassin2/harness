// ASS-394: the merge gate's (merge-in-turn.sh --gate) reading of a red test
// run — which tests to run again, and whether the ones that failed twice fail
// on the latest master too. It reads the outputs with automated-tests'
// test-results.js (ASS-99), so a failure is keyed as verify-success keys it:
// (file, test name), never its number.
//
//   node merge-gate-tests.js files <output-file>
//     The files of the failed tests, one a line, when the output is node
//     --test's spec reporter ("test at <file>:<line>:<col>" before each
//     failure) and every failure names its file: the gate re-runs those files
//     alone (node --test). Nothing otherwise — another runner, or a failure
//     with no test named — and the gate re-runs the whole command.
//
//   node merge-gate-tests.js judge <re-run's exit> <re-run's output> <master's exit> <master's output>
//     { master: true|false, tests: [<name>], new: [<name>] } — master: every
//     test that failed again fails on master too (or, no test named, the
//     command is red on master too: tests is then empty, for the gate to name
//     the command); new: those that do not, the ticket's; tests: those that
//     do, master's.
import { readFileSync } from 'node:fs';
import { failures, judge } from '../automated-tests/test-results.js';

const [what, ...args] = process.argv.slice(2);
const read = file => readFileSync(file, 'utf8');

if (what === 'files') {
  const output = read(args[0]);
  const keys = [...failures(output).failed.keys()].map(k => JSON.parse(k)[0]);
  if (/^test at /m.test(output) && keys.length && keys.every(Boolean)) console.log([...new Set(keys)].join('\n'));
} else if (what === 'judge') {
  const [status, file, masterStatus, masterFile] = args;
  const r = judge({ status: Number(masterStatus), output: read(masterFile) }, [{ status: Number(status), output: read(file) }]);
  const master = Number(masterStatus) !== 0 && (r.verdict === 'blocked' || (r.verdict === 'passed' && r['pre-existing'].length > 0));
  console.log(JSON.stringify({ master, tests: r['pre-existing'], new: r.new }));
} else {
  console.error('usage: merge-gate-tests.js files <output-file> | judge <exit> <output-file> <master-exit> <master-output-file>');
  process.exit(1);
}
