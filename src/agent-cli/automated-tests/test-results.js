// ASS-99: is a red test run the ticket's fault, or master's? Called by
// automated-tests:verify-success (verify-success.sh) for a test command that
// failed on the ticket's branch:
//
//   node test-results.js <master's exit code> <master's output file> <exit code> <output file> [<exit code> <output file>]
//   node test-results.js timed-out <exit code> <output file>
//
// prints judge()'s verdict as JSON: the command's run on master, then its run
// on the branch and, when the first was judged failed, its re-run. For a
// check that reproduces the ticket's bug (ASS-227: "reproduces": true, red on
// master by design) master's exit code and file are each "-": no master. Node rather
// than bash: the outputs run to a megabyte of interleaved runner, psql and
// docker lines, and telling a test line from the rest, a TODO from a failure,
// a file that came up short of its plan, takes a parser — one that is tested
// here on its own against recorded output.
//
// judge(master, runs) — each { status, output }:
//   { verdict: 'passed' | 'failed' | 'blocked', new: [<name>], 'pre-existing': [<name>] }
// A run that exits 0 passes. A red run is read for its failed tests, each
// keyed by (file, description) — never its number, which shifts when a test
// is added — and its aborted files (a TAP file short of its plan, or with
// none, or bailed out); a test in an aborted file that reported is still
// compared on its own. Failures master has too are pre-existing; any other is
// new, and the run failed. A failure counts only if it fails in every run
// given (the re-run: a flake or a load spike does not count). Where the
// branch's run names no failure, or master's red run no test at all, there is
// nothing to compare by test: red on master and red here is blocked (for a
// human, with both outputs); green on master and red here failed. With no
// master (null: a reproducing check) every failure is new.
//
// ASS-329: a run stopped at verify-success's time limit (timedOut) never
// finished, so its output is not compared by test: timed out where master
// finished inside the limit, it failed (the timeout its one new failure);
// master timed out, with the branch red, it is blocked, nothing to compare. A
// re-run that finished is judged on its own failures, a timed-out run's
// standing in for any.
//
// timedOut(run) — { minutes, in: [<what was running when stopped>] }, or null
// for a run that did not hit the limit: exit 124 with the limit's own line
// in its output (a command's own 124 is a plain failure). `timed-out` prints
// it as "timed out after <minutes> minutes[, in <…>]", or nothing.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TEST = /^(\s*)(not ok|ok)\s+\d+\b\s*(?:-\s*)?(.*)$/;
const DIRECTIVE = /\s+#\s*(TODO|SKIP)\b.*$/i;

// The failures in a run's output: { found (any per-test result at all), failed: Map(key → name) }.
// TAP — prove -v's (a "<file> ....." line before each file's), node --test's
// (nested by indentation under "# Subtest:" lines) or a bare stream — node
// --test's spec reporter, vitest's and jest's default reporters, and their
// JSON reports.
function failures(output) {
  const failed = new Map(), seen = new Map(), suites = [];
  let found = false, file = null, jestFile = '', specFile = null, yaml = false;
  const fail = (where, test, n = 1) => failed.set(JSON.stringify([where, test, n]), `${where ? `${where}: ` : ''}${test}${n > 1 ? ` (#${n})` : ''}`);
  const abort = where => failed.set(JSON.stringify([where]), `${where}: aborted, short of its plan`);
  const close = () => { if (file && (file.plan === null || file.ran < file.plan || file.bailed)) abort(file.name); };
  const lines = output.replace(ANSI, '').split('\n').map(line => line.replace(/\r$/, ''));
  for (const { testResults } of jsonReports(lines)) {
    found = true;
    for (const { name, status, assertionResults = [] } of testResults) {
      const failing = assertionResults.filter(a => a.status === 'failed');
      for (const a of failing) fail(name, a.fullName);
      if (status === 'failed' && !failing.length) abort(name);
    }
  }
  for (const line of lines) {
    if (yaml) { yaml = !/^\s*\.\.\.$/.test(line); continue; }
    if (/^\s+---$/.test(line)) { yaml = true; continue; }
    let m;
    if ((m = line.match(/^(\s*)# Subtest: (.*)$/))) { suites.splice(m[1].length / 4, Infinity, m[2]); continue; }
    if ((m = line.match(/^(\S+) \.{2,} ?$/))) { close(); file = { name: m[1], plan: null, ran: 0, bailed: false }; continue; }
    if ((m = line.match(/^1\.\.(\d+)/))) { if (file) file.plan = Number(m[1]); found = true; continue; }
    if (/^Bail out!/.test(line)) { if (file) file.bailed = true; continue; }
    if ((m = line.match(/^test at (.+?):\d+:\d+$/))) { specFile = m[1]; continue; }                       // node --test's spec reporter
    if (specFile !== null) { const at = specFile; specFile = null; if ((m = line.match(/^✖ (.+) \([\d.]+m?s\)$/))) { fail(at, m[1]); continue; } }
    if (/^ℹ tests \d/.test(line)) { found = true; continue; }
    if ((m = line.match(/^ FAIL  (\S+) > (.+?)\s*$/))) { fail(m[1], m[2]); continue; }                  // vitest
    if ((m = line.match(/^ FAIL  (\S+) \[ /))) { abort(m[1]); continue; }
    if (/^\s+(Test Files|Tests:)\s/.test(line) || /^Tests:\s/.test(line)) { found = true; continue; }   // vitest's and jest's totals
    if ((m = line.match(/^FAIL (\S+)/))) { jestFile = m[1]; continue; }                                   // jest
    if ((m = line.match(/^\s+● (.+?)\s*$/))) { if (m[1] === 'Test suite failed to run') abort(jestFile); else fail(jestFile, m[1]); continue; }
    if (!(m = line.match(TEST))) continue;
    found = true;
    const [, indent, result, rest] = m;
    if (file && !indent) file.ran++;
    if (result === 'ok' || rest.match(DIRECTIVE)?.[1]?.toUpperCase() === 'TODO') continue;
    const where = file?.name ?? '', test = [...suites.slice(0, indent.length / 4), rest.replace(DIRECTIVE, '')].join(' > ');
    const n = (seen.get(JSON.stringify([where, test])) ?? 0) + 1;
    seen.set(JSON.stringify([where, test]), n);
    fail(where, test, n);
  }
  close();
  return { found: found || failed.size > 0, failed };
}

// jest --json's and vitest --reporter=json's reports: an object with testResults, on a line of its own or pretty-printed from a "{" line to a "}" line.
function jsonReports(lines) {
  const reports = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('{')) return;
    const end = line === '{' ? lines.indexOf('}', i) : i;
    try {
      const report = JSON.parse(lines.slice(i, end + 1).join('\n'));
      if (Array.isArray(report?.testResults)) reports.push(report);
    } catch { /* not a report */ }
  });
  return reports;
}

// The limit's line, which verify-success's TIME_LIMIT (automated-tests.bash) prints when it stops a run.
const LIMIT = /^automated-tests:verify-success: timed out after (\S+) minutes$/m;

export function timedOut({ status, output }) {
  const m = status === 124 && output.match(LIMIT);
  return m ? { minutes: m[1], in: running(output) } : null;
}

// What was running when a run was stopped, as its output shows it: node
// --test's spec reporter lists each file it was running as failed, with its
// time (a file not started has none), named as given — its "test at" line
// may give it relative to the folder instead; its TAP reporter leaves the
// running test's "# Subtest:" lines with no result, nested by indentation.
function running(output) {
  const lines = output.replace(ANSI, '').split('\n').map(line => line.replace(/\r$/, ''));
  const files = [], base = path => path.slice(path.lastIndexOf('/') + 1);
  lines.forEach((line, i) => {
    const at = line.match(/^test at (.+?):\d+:\d+$/)?.[1], file = lines[i + 1]?.match(/^✖ (.+) \([\d.]+m?s\)$/)?.[1];
    if (at && file && base(file) === base(at) && !files.includes(file)) files.push(file);
  });
  if (files.length) return files;
  const open = [];
  for (const line of lines) {
    let m;
    if ((m = line.match(/^(\s*)# Subtest: (.*)$/))) open.splice(m[1].length / 4, Infinity, m[2]);
    else if ((m = line.match(TEST))) open.splice(m[1].length / 4);
  }
  return open.length ? [open.join(' > ')] : [];
}

const described = t => `timed out after ${t.minutes} minutes${t.in.length ? `, in ${t.in.join(', ')}` : ''}`;

function judgeRun(master, run) {
  if (run.status === 0) return { verdict: 'passed', new: new Map(), pre: new Map() };
  const out = timedOut(run);
  if (master && timedOut(master)) return { verdict: 'blocked', new: new Map(), pre: new Map() };
  if (out) return { verdict: 'failed', new: new Map([['timed out', `the command ${described(out)}${master ? `; on master it finished (exit ${master.status})` : ''}`]]), pre: new Map(), timedOut: true };
  const here = failures(run.output);
  const there = master ? failures(master.output) : { found: true, failed: new Map() };
  if (here.failed.size === 0 || (master?.status !== 0 && !there.found)) {
    if (!master) return { verdict: 'failed', new: new Map([['command', `the command exits ${run.status}: the ticket's bug still reproduces`]]), pre: new Map() };
    if (master.status !== 0) return { verdict: 'blocked', new: new Map(), pre: new Map() };
    return { verdict: 'failed', new: new Map([['command', `the command exits ${run.status}, and 0 on master`]]), pre: new Map() };
  }
  const fresh = new Map(), pre = new Map();
  for (const [key, name] of here.failed) (there.failed.has(key) ? pre : fresh).set(key, name);
  return { verdict: fresh.size ? 'failed' : 'passed', new: fresh, pre };
}

export function judge(master, runs) {
  const each = runs.map(run => judgeRun(master, run));
  const shape = (verdict, fresh, pre) => ({ verdict, new: [...fresh.values()], 'pre-existing': [...pre.values()] });
  const passed = each.find(r => r.verdict === 'passed');
  if (passed) return shape('passed', new Map(), passed.pre);
  if (each.some(r => r.verdict === 'blocked')) return shape('blocked', new Map(), new Map());
  const finished = each.filter(r => !r.timedOut);
  const fresh = finished.length ? new Map([...finished[0].new].filter(([key]) => finished.every(r => r.new.has(key)))) : each[0].new;
  return shape(fresh.size ? 'failed' : 'passed', fresh, (finished[0] ?? each[0]).pre);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'timed-out') {
  const t = timedOut({ status: Number(process.argv[3]), output: readFileSync(process.argv[4], 'utf8') });
  if (t) console.log(described(t));
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [masterStatus, masterFile, ...rest] = process.argv.slice(2);
  const read = (status, file) => ({ status: Number(status), output: readFileSync(file, 'utf8') });
  const runs = [];
  for (let i = 0; i < rest.length; i += 2) runs.push(read(rest[i], rest[i + 1]));
  console.log(JSON.stringify(judge(masterFile === '-' ? null : read(masterStatus, masterFile), runs)));
}
