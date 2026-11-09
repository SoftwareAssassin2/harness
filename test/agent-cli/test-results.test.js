// ASS-99: judging a red test run against master's — test-results.js, the
// parsing and comparing behind automated-tests:verify-success. The fixture is
// a synthetic run (ASS-277) shaped as a real one was: an example project's
// pgTAP files under prove -v, inside Nx and docker compose output, red on
// master for reasons of its own — failed tests with their diagnostics, files
// aborted short of their plan, a failing TODO, skips and prove's summary.
// Master's run is that output without the one assertion EX-2402 added (ok 217
// in 48_order_detail_api.sql, its plan 217 instead of 216) — the only
// difference the ticket's diff makes to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judge, timedOut } from '../../src/agent-cli/automated-tests/test-results.js';

const branch = readFileSync(new URL('./fixtures/example-shop-api-db-e2e.txt', import.meta.url), 'utf8');
const PARITY = 'ok 217 - parity: search_result_browse.brand_names = product_overview.brand_names on a product that has brands';
const master = branch.replace(`\n${PARITY}\n`, '\n').replace(/(\/tests\/48_order_detail_api\.sql \.+ \n)1\.\.217\n/, '$11..216\n');
const red = output => ({ status: 1, output });

test('EX-2402 (AC2): every failure in its run is one master has too, so it passes, naming each pre-existing failure — the aborted files by name', () => {
  assert.notEqual(master, branch);
  const verdict = judge(red(master), [red(branch)]);
  assert.equal(verdict.verdict, 'passed');
  assert.deepEqual(verdict.new, []);
  assert.deepEqual(verdict['pre-existing'].toSorted(), [
    '/tests/03_order_rpcs.sql: aborted, short of its plan',
    '/tests/100_search_boolean_spike.sql: boolean AND: shoes AND laces does NOT match DOC_ONLY_L (laces only) — intersection',
    '/tests/100_search_boolean_spike.sql: boolean AND: shoes AND laces does NOT match DOC_ONLY_S (shoes only) — intersection',
    '/tests/100_search_boolean_spike.sql: boolean NOT: shoes NOT laces EXCLUDES DOC_BOTH (has both terms) — exclusion works',
    '/tests/100_search_boolean_spike.sql: case-sensitive: "shoes and laces" returns DIFFERENT products from "shoes AND laces"',
    '/tests/100_search_boolean_spike.sql: case-sensitive: "shoes not laces" returns DIFFERENT products from "shoes NOT laces"',
    '/tests/114_payment_ledger.sql: aborted, short of its plan',
    '/tests/135_cart_row_details.sql: aborted, short of its plan',
    '/tests/145_search_phrase.sql: (h) AND: only docs with both zqfoo and zqbar',
    '/tests/145_search_phrase.sql: (h) NOT: docs with zqfoo excluding those with zqbaz',
    '/tests/145_search_phrase.sql: (h) parse: AND activates the constraint path',
    '/tests/145_search_phrase.sql: (h) parse: NOT produces an exclusion constraint',
    '/tests/145_search_phrase.sql: (h) parse: lowercase or does not activate constraint',
    '/tests/192_product_embedding_ann.sql: V173 leaves unused side synchronization disabled',
    '/tests/48_order_detail_api.sql: order_document: a lines element carries exactly {line_id, sku, quantity, unit_price, discounts, tax_lines, text_version} (R6/R10, EX-2373)',
    '/tests/57_order_document_scoping.sql: aborted, short of its plan',
    '/tests/91_line_text_extraction_version.sql: V4139 allows any version from 2 up (NULL still passes), and is NOT VALID (no scan of the 36 GB table)',
    '/tests/91_line_text_extraction_version.sql: aborted, short of its plan',
  ]);
});

test('EX-2402 (AC3): a test of its own that fails in the same red suite is a new failure, named, beside the pre-existing ones', () => {
  const broken = branch.replace(`\n${PARITY}\n`, `\nnot ${PARITY}\n`);
  const verdict = judge(red(master), [red(broken)]);
  assert.equal(verdict.verdict, 'failed');
  assert.deepEqual(verdict.new, ['/tests/48_order_detail_api.sql: parity: search_result_browse.brand_names = product_overview.brand_names on a product that has brands']);
  assert.equal(verdict['pre-existing'].length, 18);
});

test('a file that aborts on the branch but ran to its plan on master is a new failure; its tests that reported are still compared one by one', () => {
  // 192 stops after its first (pre-existing) failure: the file is new, the failure is not.
  const aborted = branch.replace(/(not ok 1 - V173 leaves unused side synchronization disabled\n(?:#.*\n)*)ok 2 - [\s\S]*?(?=\/tests\/193_)/, '$1');
  const verdict = judge(red(master), [red(aborted)]);
  assert.equal(verdict.verdict, 'failed');
  assert.deepEqual(verdict.new, ['/tests/192_product_embedding_ann.sql: aborted, short of its plan']);
  assert.ok(verdict['pre-existing'].includes('/tests/192_product_embedding_ann.sql: V173 leaves unused side synchronization disabled'));
});

test('a failure is keyed by its file and description, not its number: a test added before it moves no failure', () => {
  const before = 'x.sql ....... \n1..2\nok 1 - a\nnot ok 2 - b\n';
  const after = 'x.sql ....... \n1..3\nok 1 - a\nok 2 - new\nnot ok 3 - b\n';
  assert.equal(judge(red(before), [red(after)]).verdict, 'passed');
  // The same description in another file is another test.
  assert.deepEqual(judge(red(before), [red('y.sql ....... \n1..1\nnot ok 1 - b\n')]).new, ['y.sql: b']);
});

test('a failure counts only when the re-run fails it too: a test that fails once (a spike) passes', () => {
  const clean = 'x.sql ....... \n1..2\nok 1 - a\nok 2 - b\n', spiked = 'x.sql ....... \n1..2\nnot ok 1 - a\nok 2 - b\n';
  assert.equal(judge(red(clean), [red(spiked)]).verdict, 'failed');
  assert.equal(judge(red(clean), [red(spiked), red('x.sql ....... \n1..2\nok 1 - a\nnot ok 2 - b\n')]).verdict, 'passed');
  assert.equal(judge(red(clean), [red(spiked), { status: 0, output: clean }]).verdict, 'passed');
  assert.deepEqual(judge(red(clean), [red(spiked), red(spiked)]).new, ['x.sql: a']);
});

test('where the output names no test: red on master and still red is blocked, for a human; green on master is a new failure', () => {
  const opaque = 'Error: something broke\n';
  assert.deepEqual(judge(red('make: *** [all] Error 2\n'), [red(opaque)]), { verdict: 'blocked', new: [], 'pre-existing': [] });
  assert.deepEqual(judge({ status: 0, output: 'all good\n' }, [red(opaque)]).new, ['the command exits 1, and 0 on master']);
  // Tests on the branch, none on master's red run (it never got as far): nothing to compare them with.
  assert.equal(judge(red(opaque), [red('x.sql ....... \n1..1\nnot ok 1 - a\n')]).verdict, 'blocked');
  // A red run whose tests all pass: its failure is somewhere no test names.
  assert.equal(judge(red(master), [red('x.sql ....... \n1..1\nok 1 - a\n')]).verdict, 'blocked');
});

// node --test --test-reporter=tap: subtests nested by indentation, each after its "# Subtest:" line.
const nodeTap = failing => `TAP version 13
# Subtest: suite A
    # Subtest: x
    ${failing === 'A' ? 'not ok' : 'ok'} 1 - x
      ---
      duration_ms: 0.1
      ...
    1..1
${failing === 'A' ? 'not ok' : 'ok'} 1 - suite A
# Subtest: suite B
    # Subtest: x
    ${failing === 'B' ? 'not ok' : 'ok'} 1 - x
    # Subtest: someday
    not ok 2 - someday # TODO
    1..2
${failing === 'B' ? 'not ok' : 'ok'} 2 - suite B
1..2
# fail 1
`;

test('node --test\'s TAP: a nested test is named by its suites, so the same name in another suite is another test; a TODO is no failure', () => {
  assert.deepEqual(judge(red(nodeTap('A')), [red(nodeTap('B'))]).new, ['suite B > x', 'suite B']);
  assert.deepEqual(judge(red(nodeTap('A')), [red(nodeTap('A'))])['pre-existing'], ['suite A > x', 'suite A']);
});

// vitest's default reporter: a FAIL line per failed test (file > suite > test), and per file that failed to load.
const vitest = (...failing) => ` RUN  v3.2.4 /repo

 ✓ src/a.spec.ts (3 tests) 5ms
 ❯ src/app/project-mappers.spec.ts (12 tests | 1 failed) 23ms
   × formatUpdatedLabel > formats the day 5ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${failing.length} ⎯⎯⎯⎯⎯⎯⎯

${failing.map(f => ` FAIL  ${f}\nAssertionError: expected 'Updated Dec 24' to be 'Updated Dec 25'\n`).join('\n')}
 Test Files  1 failed | 300 passed (301)
      Tests  1 failed | 4411 passed (4412)
`;

test('vitest\'s default reporter: each FAIL line is a test, keyed by its file and suites; a file that failed to load is aborted', () => {
  const flaky = 'src/app/project-mappers.spec.ts > formatUpdatedLabel > formats the day';
  assert.deepEqual(judge(red(vitest(flaky)), [red(vitest(flaky))])['pre-existing'], [flaky.replace(' > ', ': ')]);
  assert.deepEqual(judge(red(vitest(flaky)), [red(vitest(flaky, 'src/b.spec.ts > b > works', 'src/c.spec.ts [ src/c.spec.ts ]'))]).new,
    ['src/b.spec.ts: b > works', 'src/c.spec.ts: aborted, short of its plan']);
});

// jest's default reporter: FAIL <file>, then a ● line per failed test (suite › test), repeated in the summary.
const jest = (...blocks) => `${blocks.map(([file, ...tests]) => `FAIL ${file}\n${tests.map(t => `  ● ${t}\n\n    expect(received).toBe(expected)\n`).join('\n')}`).join('\n')}
Summary of all failing tests
${blocks.map(([file, ...tests]) => `FAIL ${file}\n${tests.map(t => `  ● ${t}\n`).join('')}`).join('')}
Tests:       1 failed, 3 passed, 4 total
`;

test('jest\'s default reporter: each ● under a FAIL file is a test; "Test suite failed to run" is the file aborted', () => {
  const old = ['src/a.test.js', 'a › old'];
  assert.equal(judge(red(jest(old)), [red(jest(old))]).verdict, 'passed');
  assert.deepEqual(judge(red(jest(old)), [red(jest(['src/a.test.js', 'a › old', 'a › new'], ['src/b.test.js', 'Test suite failed to run']))]).new,
    ['src/a.test.js: a › new', 'src/b.test.js: aborted, short of its plan']);
});

// node --test's default (spec) reporter, as npm test prints it: the failures listed again at the end, each under "test at <file>:<line>:<column>".
const spec = (...failing) => `▶ suite
  ✔ inner ok (0.2ms)
ℹ tests 5
ℹ fail ${failing.length}

✖ failing tests:
${failing.map(([file, line, name]) => `\ntest at ${file}:${line}:3\n✖ ${name} (0.06ms)\n  Error: x\n`).join('')}
test at test/a.test.js:9:1
⚠ someday (0.03ms) # TODO
  Error: z
`;

test('node --test\'s spec reporter: each test in its failing-tests list, keyed by its file — not its line, which moves — and name', () => {
  const old = ['test/a.test.js', 2, 'inner bad'];
  assert.deepEqual(judge(red(spec(old)), [red(spec(['test/a.test.js', 40, 'inner bad']))])['pre-existing'], ['test/a.test.js: inner bad']);
  assert.deepEqual(judge(red(spec(old)), [red(spec(old, ['test/b.test.js', 1, 'b broke']))]).new, ['test/b.test.js: b broke']);
});

// jest --json and vitest --reporter=json: one object, on a line of its own or pretty-printed, among whatever else the command prints.
const report = (failing, broken = []) => ({
  numFailedTests: failing.length,
  testResults: [
    { name: '/repo/src/a.test.ts', status: failing.length ? 'failed' : 'passed', message: '', assertionResults: [{ fullName: 'a ok', status: 'passed' }, ...failing.map(fullName => ({ fullName, status: 'failed' }))] },
    ...broken.map(name => ({ name, status: 'failed', message: 'Cannot find module ./x', assertionResults: [] })),
  ],
});

test('a jest or vitest JSON report: each failed assertion is a test, keyed by its file and full name; a failed file with none is aborted', () => {
  const line = (...args) => `> nx run web:test\n{"action": "unchanged"}\n${JSON.stringify(report(...args))}\ndone\n`;
  const pretty = (...args) => `> nx run web:test\n${JSON.stringify(report(...args), null, 2)}\n`;
  assert.deepEqual(judge(red(line(['a old'])), [red(pretty(['a old']))])['pre-existing'], ['/repo/src/a.test.ts: a old']);
  assert.deepEqual(judge(red(line(['a old'])), [red(line(['a old', 'a new'], ['/repo/src/b.test.ts']))]).new,
    ['/repo/src/a.test.ts: a new', '/repo/src/b.test.ts: aborted, short of its plan']);
});

// ASS-227: an entry marked "reproduces" is red on master by design — the check reproduces the ticket's bug — so there is no master to compare with (null): any red run is the fix falling short.
test('ASS-227: with no master to compare (a reproducing check), a red run failed — named tests or none — and a green run, or a green re-run, passed', () => {
  assert.deepEqual(judge(null, [red('Error: something broke\n')]), { verdict: 'failed', new: ['the command exits 1: the ticket\'s bug still reproduces'], 'pre-existing': [] });
  assert.deepEqual(judge(null, [red('x.sql ....... \n1..1\nnot ok 1 - a\n'), red('x.sql ....... \n1..1\nnot ok 1 - a\n')]).new, ['x.sql: a']);
  assert.equal(judge(null, [{ status: 0, output: 'ok\n' }]).verdict, 'passed');
  assert.equal(judge(null, [red('boom\n'), { status: 0, output: 'ok\n' }]).verdict, 'passed');
});

// ASS-329: a run stopped at automated-tests:verify-success's time limit — exit
// 124, its output ending with the limit's own line — and what node --test
// prints when stopped: its spec reporter lists each file it was running as a
// failed one, with its time (one never started has none); its TAP reporter
// leaves the running test's "# Subtest:" with no result.
const STOPPED = 'automated-tests:verify-success: timed out after 30 minutes\n';
const stopped = output => ({ status: 124, output: output + STOPPED });
const SPEC_STOPPED = `✔ a quick one (0.773708ms)
✖ test/agents/process.test.js (2973.976ms)
✔ b one (0.606459ms)
ℹ tests 3
ℹ cancelled 2

✖ failing tests:

test at test/agents/process.test.js:1:1
✖ test/agents/process.test.js (2973.976ms)
  'Promise resolution is still pending but the event loop has already resolved'

test at test/c.test.js:1:1
✖ test/c.test.js
  'Promise resolution is still pending but the event loop has already resolved'
`;

test('ASS-329 AC2: a run that hit the time limit timed out — after its minutes, naming what node --test was running when stopped — and no other run did', () => {
  assert.deepEqual(timedOut(stopped(SPEC_STOPPED)), { minutes: '30', in: ['test/agents/process.test.js'] });
  assert.deepEqual(timedOut(stopped('TAP version 13\n# Subtest: suite\n    # Subtest: first\n    ok 1 - first\n    # Subtest: hangs\n')), { minutes: '30', in: ['suite > hangs'] });
  assert.deepEqual(timedOut(stopped('# Subtest: a\nok 1 - a\n')), { minutes: '30', in: [] });
  assert.deepEqual(timedOut(stopped('starting\n')), { minutes: '30', in: [] });
  assert.equal(timedOut({ status: 124, output: 'exit 124 of its own\n' }), null);   // no limit's line: the command's own 124
  assert.equal(timedOut({ status: 1, output: STOPPED }), null);
  assert.equal(timedOut({ status: 0, output: 'ok\n' }), null);
});

test('ASS-329 AC3: a branch run that timed out, master finishing inside the limit, is a new failure — named tests on master or not — and passes only on a green or pre-existing re-run', () => {
  const tap = 'x.sql ....... \n1..2\nok 1 - a\nnot ok 2 - b\n';
  const failed = judge({ status: 0, output: 'ok\n' }, [stopped(SPEC_STOPPED)]);
  assert.deepEqual(failed, { verdict: 'failed', new: ['the command timed out after 30 minutes, in test/agents/process.test.js; on master it finished (exit 0)'], 'pre-existing': [] });
  assert.equal(judge(red(tap), [stopped(SPEC_STOPPED)]).verdict, 'failed');                         // master red, but it finished
  assert.equal(judge(red(tap), [stopped('x.sql ....... \n1..2\nok 1 - a\nnot ok 2 - b\n')]).verdict, 'failed');   // its failures master's, but it never finished
  assert.equal(judge(red(tap), [stopped(SPEC_STOPPED), stopped(SPEC_STOPPED)]).verdict, 'failed');   // timed out again on its re-run
  assert.deepEqual(judge(red(tap), [stopped(SPEC_STOPPED), red('x.sql ....... \n1..2\nnot ok 1 - a\nnot ok 2 - b\n')]).new, ['x.sql: a']);   // a re-run that finished: its new failures
  assert.equal(judge(red(tap), [stopped(SPEC_STOPPED), red(tap)]).verdict, 'passed');                 // re-run red only as master is
  assert.equal(judge({ status: 0, output: 'ok\n' }, [stopped(SPEC_STOPPED), { status: 0, output: 'ok\n' }]).verdict, 'passed');
  assert.deepEqual(judge(null, [stopped('starting\n')]).new, ['the command timed out after 30 minutes']);   // a reproducing check
});

test('ASS-329 AC3: master\'s run timed out too — or master timed out where the branch finished red — is blocked, nothing to compare; a green branch run still passes', () => {
  assert.equal(judge(stopped(SPEC_STOPPED), [stopped(SPEC_STOPPED)]).verdict, 'blocked');
  assert.equal(judge(stopped(SPEC_STOPPED), [red('x.sql ....... \n1..1\nnot ok 1 - a\n')]).verdict, 'blocked');
  assert.equal(judge(stopped(SPEC_STOPPED), [{ status: 0, output: 'ok\n' }]).verdict, 'passed');
});
