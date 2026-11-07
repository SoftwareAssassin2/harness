// Control as the supervisor runs it: a real process (src/control/main.js) on
// a temp copy of the data, its output read line by line, its pidfile, its
// startup reconciliation, and how it ends.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { startControl } from '../../src/control/process.js';
import { controlFixture } from './control-fixture.js';
import { until, within } from '../support/until.js';
import { writeUsage } from '../../src/agents/session-usage.js';
import { sessionDir } from '../../src/agents/session.js';

const MAIN = join(import.meta.dirname, '..', '..', 'src', 'control', 'main.js');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const DEAD = spawnSync('true').pid;                                     // a process that has ended
// The control fixture with no agent seats (max-agents 0: no process is ever
// spawned by a test's control) and its own HARNESS_HOME for the pidfile.
function processFixture() {
  const f = controlFixture();
  const harness = f.harness();
  writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...harness, 'max-agents': 0 }));
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  return { ...f, home, env: { ...f.env, HARNESS_HOME: home }, pidfile: join(home, 'run.pid') };
}
// main.js run with the fixture's env and `args`, its stdout lines collected; resolves when it exits. Killed when
// its test ends, if it has not ended by then: a test that fails part way leaves nothing holding the run open (ASS-109).
const children = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });
// startControl, its process group added to what is killed when the test ends.
const supervised = options => { const c = startControl(options); children.push({ kill: () => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* ended */ } } }); return c; };
function run(f, args, { input = 'keep' } = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: f.env });
  children.push(child);
  const lines = [], errors = [];
  createInterface({ input: child.stdout }).on('line', line => lines.push(line));
  createInterface({ input: child.stderr }).on('line', line => errors.push(line));
  if (input === 'close') child.stdin.end();
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, lines, errors, exit };
}

test('control --once: logs its start, removes every assignment — stopping an earlier control\'s leftover agent — runs one tick and exits 0', async () => {
  const f = processFixture();
  const [stale] = JSON.parse((await f.agent('assignments:create', 'p', 'example-development', 'backlog', 'review-plan', '1', 'false', 'ABC-3', '-', '-')).stdout);
  await f.agent('assignments:set-process', stale['agent-name'], String(DEAD), '-');
  const [leftover] = JSON.parse((await f.agent('assignments:create', 'p', 'example-development', 'backlog', 'review-plan', '1', 'false', 'ABC-3', '-', '-')).stdout);
  const orphan = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });                   // an agent of a control that died: alive, in its own group, nobody's
  orphan.unref();
  children.push(orphan);
  await f.agent('assignments:set-process', leftover['agent-name'], String(orphan.pid), '-');
  const { lines, errors, exit } = run(f, ['--once']);
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z startup control \d+, tick every 2000ms$/);
  assert.ok(lines.some(l => l.endsWith(`startup removed the stale assignment of ${stale['agent-name']} (pid ${DEAD})`)), lines.join('\n'));
  assert.ok(lines.some(l => l.endsWith(`startup stopped ${leftover['agent-name']} (pid ${orphan.pid}), left by an earlier control, and removed its assignment`)), lines.join('\n'));
  assert.ok(lines.some(l => /startup 2 stale assignments removed$/.test(l)), lines.join('\n'));
  assert.ok(!alive(orphan.pid));
  assert.deepEqual(f.assignments().assignments, []);
  assert.ok(lines.some(l => / steps ABC-3 A backlog → committed$/.test(l)), lines.join('\n'));   // the tick ran
  assert.ok(lines.some(l => / shutdown control exiting$/.test(l)), lines.join('\n'));
  assert.deepEqual(errors, []);
});
test('the pidfile is written at start, refuses a second control while it names a live process, and is removed on exit', async () => {
  const f = processFixture();
  const first = run(f, ['--tick-ms', '200']);
  assert.ok(await until(() => existsSync(f.pidfile)));
  assert.equal(Number(readFileSync(f.pidfile, 'utf8')), first.child.pid);
  const second = run(f, ['--once']);
  assert.equal((await second.exit).code, 1);
  assert.match(second.errors.join('\n'), new RegExp(`control: already running as pid ${first.child.pid}`));
  first.child.stdin.end();
  assert.deepEqual(await first.exit, { code: 0, signal: null });
  assert.ok(!existsSync(f.pidfile));
  // A pidfile naming a dead process does not block.
  writeFileSync(f.pidfile, `${DEAD}\n`);
  assert.equal((await run(f, ['--once']).exit).code, 0);
});

test('control keeps ticking, quietly, while its stdin is open and exits 0 soon after it closes, or on SIGTERM', async () => {
  const f = processFixture();
  const open = run(f, ['--tick-ms', '50']);
  let signalled = null;
  try {
    // The ticks ran: the ticket went as far as it goes without an agent seat. Its move's last line is awaited, not
    // "committed → plan": each line is a write of its own, and under load the next could arrive in the quiet (ASS-267).
    assert.ok(await until(() => open.lines.some(l => / steps ABC-3 A committed → plan$/.test(l)) && open.lines.some(l => / steps ABC-3 ticket system status → In Progress$/.test(l))), open.lines.join('\n'));
    const logged = open.lines.length;
    await new Promise(r => setTimeout(r, 500));                      // ten more ticks with nothing to do: alive, and not a line about it
    assert.ok(alive(open.child.pid));
    assert.deepEqual(open.lines.slice(logged), []);
    open.child.stdin.end();
    assert.deepEqual(await within(open.exit), { code: 0, signal: null });
    signalled = run(f, ['--tick-ms', '100']);                              // after the first is gone: the pidfile allows one control
    assert.ok(await until(() => signalled.lines.length >= 2));
    signalled.child.kill('SIGTERM');
    assert.deepEqual(await signalled.exit, { code: 0, signal: null });
    assert.ok(!alive(signalled.child.pid));
  } finally {
    open.child.kill('SIGKILL');
    signalled?.child.kill('SIGKILL');
  }
});

test('with harness.json\'s forwarder-port, control serves the VMs\' forwarder on 127.0.0.1 while it runs (ASS-74); a second control finds it held and leaves it be', async () => {
  const f = processFixture();
  const port = await new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...f.harness(), 'forwarder-port': port }));
  const first = run(f, ['--tick-ms', '50']);
  let second = null;
  try {
    assert.ok(await until(() => first.lines.some(l => l.endsWith(` forwarder listening on 127.0.0.1:${port}`))), first.lines.join('\n'));
    const refused = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', body: JSON.stringify({ token: 'nope', argv: ['ticket:questions-answered', 'p', 'ABC-3'] }) });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { refused: 'unknown token' });
    second = run({ ...f, env: { ...f.env, HARNESS_HOME: mkdtempSync(join(tmpdir(), 'harness-home-')) } }, ['--tick-ms', '50', '--project', 'p']);
    assert.ok(await until(() => second.lines.some(l => l.endsWith(` forwarder 127.0.0.1:${port} is held, by another control: it serves every VM`))), second.lines.join('\n'));
    first.child.stdin.end();
    assert.deepEqual(await first.exit, { code: 0, signal: null });
  } finally {
    first.child.kill('SIGKILL');
    second?.child.kill('SIGKILL');
  }
});

test('control, run for the supervisor, hands each line on with its stream and time, and stop ends its process group and reports the exit', async () => {
  const f = processFixture();
  const lines = [];
  let exited = null;
  const control = supervised({ onLine: line => lines.push(line), onExit: (code, signal) => { exited = { code, signal }; }, env: f.env, args: ['--tick-ms', '100'] });
  try {
    assert.ok(alive(control.pid));
    assert.ok(await until(() => lines.length >= 3), `got ${lines.length} lines`);
    assert.match(lines[0].text, /^\S+ startup control \d+/);
    assert.ok(lines.every(l => l.stream === 'stdout' && l.at instanceof Date));
  } finally {
    control.stop();
  }
  await control.exited;                                                 // settles once it has ended, after onExit
  assert.deepEqual(exited, { code: 0, signal: null });                  // a clean shutdown on SIGTERM
  assert.ok(await until(() => !alive(control.pid)));
  assert.equal(lines.at(-1).text, 'control exited (code 0)');
  assert.equal(lines.at(-1).stream, 'stderr');
});

test('every line control prints is appended to its log file, with its time and, for stderr, its stream; the file is only ever appended to', async () => {
  const f = processFixture();
  const logFile = join(mkdtempSync(join(tmpdir(), 'control-')), 'logs', 'control.log');   // the folder is made if it is missing
  const lines = [];
  let inFile = 0;
  const first = supervised({ onLine: line => { lines.push(line); inFile = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length; }, env: f.env, args: ['--tick-ms', '100'], logFile });
  assert.ok(await until(() => lines.length >= 2));
  assert.equal(inFile, lines.length);                                    // each line is in the file the moment it is handed on
  first.stop();
  assert.ok(await until(() => readFileSync(logFile, 'utf8').includes('control exited')));
  const logged = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.match(logged[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z  \S+ startup control \d+/);
  assert.equal(logged[0], `${lines[0].at.toISOString()}  ${lines[0].text}`);
  assert.ok(logged.some(l => /^\S+  \[supervisor\] stopping control$/.test(l)));
  assert.match(logged.at(-1), /^\S+  \[stderr\] control exited \(code 0\)$/);

  writeFileSync(logFile, 'earlier run\n');                              // appended to, never truncated
  const second = supervised({ onLine: () => {}, env: f.env, args: ['--once'], logFile });
  assert.ok(await until(() => readFileSync(logFile, 'utf8').includes('control exited')));
  second.stop();
  assert.ok(readFileSync(logFile, 'utf8').startsWith('earlier run\n'));
});

test('startControl runs another script the same way when given one, naming it by its folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-'));
  mkdirSync(join(dir, 'downloader'));
  const script = join(dir, 'downloader', 'main.js');
  writeFileSync(script, "console.log('hello'); process.stdin.on('end', () => process.exit(0)).resume();\n");
  const lines = [];
  let exited = null;
  const child = supervised({ onLine: line => lines.push(line), onExit: (code, signal) => { exited = { code, signal }; }, script });
  assert.ok(await until(() => lines.length >= 1));
  assert.equal(lines[0].text, 'hello');
  child.stop();
  assert.ok(await until(() => exited !== null));
  assert.equal(lines.at(-1).text, `downloader exited (${exited.signal ?? `code ${exited.code}`})`);
});

test('control exits with code 75, its agents stopped, when harness:request-restart named it; the request stays for harness:restarted', async () => {
  const f = processFixture();
  const control = run(f, ['--tick-ms', '100']);
  try {
    assert.ok(await until(() => existsSync(f.pidfile)));
    const pid = Number(readFileSync(f.pidfile, 'utf8'));
    writeFileSync(join(f.home, 'restart-requested.json'), JSON.stringify({ tickets: ['HD-1', 'HD-2'], since: '2026-10-11T22:00:00Z', 'control-pids': [pid] }));
    assert.deepEqual(await within(control.exit), { code: 75, signal: null });
    assert.ok(control.lines.some(l => / shutdown a restart was requested \(self-healing, HD-1, HD-2\); control exits with code 75 to be started again$/.test(l)), control.lines.join('\n'));
    assert.ok(existsSync(join(f.home, 'restart-requested.json')));                           // harness:restarted stamps it, once a new control runs
    assert.ok(!existsSync(f.pidfile));
    // A request naming another control is not this one's: it keeps ticking.
    const other = run(f, ['--tick-ms', '100']);
    try {
      assert.ok(await until(() => existsSync(f.pidfile)));
      writeFileSync(join(f.home, 'restart-requested.json'), JSON.stringify({ ticket: 'HD-1', since: '2026-10-11T22:00:00Z', 'control-pid': pid }));
      await new Promise(r => setTimeout(r, 400));
      assert.ok(alive(other.child.pid));
      other.child.stdin.end();
      assert.deepEqual(await within(other.exit), { code: 0, signal: null });
    } finally {
      other.child.kill('SIGKILL');
    }
  } finally {
    control.child.kill('SIGKILL');
  }
});

test('control --project p: its own pidfile, only p\'s stale assignments removed, and a restart request naming it among every control\'s pids', async () => {
  const f = processFixture();
  const [mine] = JSON.parse((await f.agent('assignments:create', 'p', 'example-development', 'backlog', 'review-plan', '1', 'false', 'ABC-3', '-', '-')).stdout);
  await f.agent('assignments:set-process', mine['agent-name'], String(DEAD), '-');
  const file = join(f.dir, 'assignments.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.assignments.push({ ...data.assignments[0], 'agent-name': 'Other-Agent', project: 'x' });   // another project's: another control's to judge
  writeFileSync(file, JSON.stringify(data));
  const once = run(f, ['--once', '--project', 'p']);
  assert.deepEqual(await once.exit, { code: 0, signal: null });
  assert.deepEqual(f.assignments().assignments.map(a => a['agent-name']), ['Other-Agent']);
  const pidfile = join(f.home, 'run-p.pid');
  const control = run(f, ['--tick-ms', '100', '--project', 'p']);
  try {
    assert.ok(await until(() => existsSync(pidfile)));
    const pid = Number(readFileSync(pidfile, 'utf8'));
    writeFileSync(join(f.home, 'restart-requested.json'), JSON.stringify({ ticket: 'ASS-8', since: '2026-10-13T22:00:00Z', 'control-pids': [1, pid] }));
    assert.deepEqual(await within(control.exit), { code: 75, signal: null });
    assert.ok(!existsSync(pidfile));
  } finally {
    control.child.kill('SIGKILL');
  }
});

// ASS-268: a stale record's agent died with its control, or is a leftover stopped here; what its session cost is in its usage.json.
test('ASS-268 AC2: control\'s startup clean-up records what each stale agent cost from its usage.json — an unfinished turn\'s estimate flagged, billing as the session said, 0 on a subscription — before removing it', async () => {
  const f = processFixture();
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const s = JSON.parse(readFileSync(sprint, 'utf8'));
  s.features[0].variations[0]['state-changes'] = [{ 'state-engine': 'example-development', 'from-state': null, 'to-state': 'backlog', timestamp: '2026-10-29T00:00:00Z', 'agent-dispatch-log': [] }];
  writeFileSync(sprint, JSON.stringify(s));
  const stale = [];
  for (const usage of [
    { model: 'claude-opus-5', tokens: { input: 100, output: 2000, cacheRead: 300000, cacheWrite: 40000 }, costUsd: 20.48, costExact: false, billing: 'api' },
    { model: 'claude-opus-5', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 1.5, costExact: true, billing: 'subscription' },
    null,                                                                          // never got as far as usage.json
  ]) {
    const [record] = JSON.parse((await f.agent('assignments:create', 'p', 'example-development', 'backlog', 'review-plan', '1', 'false', 'ABC-3', 'A', '-')).stdout);
    await f.agent('assignments:set-process', record['agent-name'], String(DEAD), '-');
    const dir = sessionDir(f.dir, record['agent-name'], record['start-time']);   // where its process wrote usage.json
    mkdirSync(dir, { recursive: true });
    if (usage) writeUsage(dir, usage);
    stale.push(record['agent-name']);
  }
  const { lines, exit } = run(f, ['--once']);
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.ok(lines.some(l => /startup 3 stale assignments removed$/.test(l)), lines.join('\n'));
  const log = JSON.parse(readFileSync(sprint, 'utf8')).features[0].variations[0]['state-changes'][0]['agent-dispatch-log'];
  const spend = name => { const d = log.find(x => x['dispatched-to'] === name); return [d['cost-usd'], d['cost-estimated'] ?? false, d.billing ?? null, d.tokens, Boolean(d['completed-timestamp'])]; };
  assert.deepEqual(spend(stale[0]), [20.48, true, 'api', { input: 100, output: 2000, 'cache-read': 300000, 'cache-write': 40000 }, true]);
  assert.deepEqual(spend(stale[1]), [0, false, 'subscription', { input: 1, output: 2, 'cache-read': 3, 'cache-write': 4 }, true]);
  assert.deepEqual(spend(stale[2]), [null, false, null, null, true]);
});
