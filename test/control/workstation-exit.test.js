// ASS-470: control, run as the supervisor runs it (src/control/main.js, a
// real process), closes the workstation connections it owns on every way out
// — the supervisor's stop, a restart (75), SIGTERM, SIGINT, an uncaught
// exception (70) — and at its start those a control no longer running left;
// one opened by hand it leaves alone. Against test/support/fake-workstation.js.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlFixture } from './control-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';
import { controlPath } from '../../src/control/workstation-connection.js';
import { startControl } from '../../src/control/process.js';
import { until, within } from '../support/until.js';

const run = promisify(execFile);
const MAIN = join(import.meta.dirname, '..', '..', 'src', 'control', 'main.js');
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const ID = 'ada-dev';
const cleanup = [];
afterEach(async () => { for (const end of cleanup.splice(0)) await end(); });
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };

// The control fixture (no agent seats) with project p on workstation ada-dev, its ticket ABC-3 A held running on it
// for the operator (so control connects it) unless need is false; HARNESS_HOME the fake's short folder, for the
// master's socket and control's pidfile.
function fixture({ need = true } = {}) {
  const f = controlFixture(), w = fakeWorkstation(f.env);
  const at = (...rest) => join(f.dir, ...rest);
  edit(at('harness.json'), h => { h['max-agents'] = 0; h['forwarder-port'] = 7787; });
  edit(at('projects', 'p', 'project.json'), p => { p['dev-environments'] = { mode: 'vm+workstation', workstations: [{ id: ID, 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config' }] }; });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { const v = s.features[0].variations[0]; v.vm = { name: ID, kind: 'workstation' }; if (need) v['vm-hold'] = { by: 'ada', since: '2026-11-14T00:00:00Z', note: null }; });
  w.workstation(ID, 'STATE_RUNNING');
  cleanup.push(() => run(AGENT, ['workstation:disconnect', 'p', ID], { env: w.env }).catch(() => {}));
  const file = at('projects', 'p', 'workstations.json');
  const entry = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))[ID] ?? {} : {});
  return { f, w, env: w.env, entry, socket: controlPath(w.env, 'p', ID), home: w.harnessHome };
}

// main.js run with the fixture's env and `args`, its stdout lines collected.
function control(s, args = ['--tick-ms', '100'], env = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...s.env, ...env } });
  cleanup.push(() => child.kill('SIGKILL'));
  const lines = [];
  createInterface({ input: child.stdout }).on('line', line => lines.push(line));
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, lines, exit };
}

// Waits until control `pid` has the workstation connected, as its own — and set up (ASS-545): its connect job ended,
// which control's exit would otherwise wait for only so long (workstations.js disconnectWorkstations, 10 s) before
// leaving the close to the job — on a loaded Mac setup outlasted that, and the exit logged "still closing" instead.
const connectedBy = async (s, pid, lines) => assert.ok(await until(() => s.entry().connected === true && s.entry()['control-pid'] === pid && existsSync(s.socket) && s.entry().setup?.ok === true), lines.join('\n'));
// Then, once it has exited: the connection closed and the live data saying so.
async function closed(s, lines) {
  assert.ok(await until(() => !existsSync(s.socket) && s.entry().connected === false && s.entry()['control-pid'] === null), lines.join('\n'));
  assert.ok(lines.some(l => / workstation p ada-dev: disconnected as control exits$/.test(l)), lines.join('\n'));
}

for (const [how, end, code] of [
  ['SIGTERM', c => c.child.kill('SIGTERM'), 0],
  ['SIGINT', c => c.child.kill('SIGINT'), 0],
  ['stdin closing', c => c.child.stdin.end(), 0],
]) {
  test(`ASS-470 AC1: control stopped by ${how} closes the connection it opened, and the live data says disconnected`, async () => {
    const s = fixture();
    const c = control(s);
    await connectedBy(s, c.child.pid, c.lines);
    end(c);
    assert.deepEqual(await within(c.exit), { code, signal: null });
    await closed(s, c.lines);
  });
}

test('ASS-470 AC1: the supervisor\'s stop (SIGTERM to control\'s process group) closes the connection', async () => {
  const s = fixture();
  const lines = [];
  const c = startControl({ onLine: l => lines.push(l.text), env: s.env, args: ['--tick-ms', '100'] });
  cleanup.push(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* ended */ } });
  await connectedBy(s, c.pid, lines);
  c.stop();
  await within(c.exited);
  assert.equal(lines.at(-1), 'control exited (code 0)');
  await closed(s, lines);
});

test('ASS-470 AC1: a restart (exit 75) closes the connection', async () => {
  const s = fixture();
  const c = control(s);
  await connectedBy(s, c.child.pid, c.lines);
  writeFileSync(join(s.home, 'restart-requested.json'), JSON.stringify({ ticket: 'HD-1', since: '2026-11-16T00:00:00Z', 'control-pid': c.child.pid }));
  assert.deepEqual(await within(c.exit), { code: 75, signal: null });
  await closed(s, c.lines);
});

test('ASS-470 AC1: an uncaught exception (exit 70) closes the connection — one still being opened as it struck too', async () => {
  // ASS-545: the exception strikes when the test says (CONTROL_TEST_FAULT_WHEN's file), not after the first tick —
  // where the connect stood then was the machine's speed. First once control owns the open connection: exit 70 closes
  // it, logged.
  let s = fixture(), when = join(s.home, 'strike');
  let c = control(s, ['--tick-ms', '100'], { CONTROL_TEST_FAULT: 'uncaught', CONTROL_TEST_FAULT_WHEN: when });
  await connectedBy(s, c.child.pid, c.lines);
  writeFileSync(when, '');
  assert.deepEqual(await within(c.exit), { code: 70, signal: null });
  await closed(s, c.lines);
  // Then while the connect is still under way (its ssh begun): nothing is left open.
  s = fixture(); when = join(s.home, 'strike');
  c = control(s, ['--tick-ms', '100'], { CONTROL_TEST_FAULT: 'uncaught', CONTROL_TEST_FAULT_WHEN: when });
  assert.ok(await until(() => s.w.gcloudCalls().some(call => call.argv[1] === 'ssh')), `it begins connecting: ${c.lines.join('\n')}`);
  writeFileSync(when, '');
  assert.deepEqual(await within(c.exit), { code: 70, signal: null });
  assert.ok(await until(() => !existsSync(s.socket) && s.entry()['control-pid'] == null && s.entry().connected !== true), c.lines.join('\n'));
});

test('ASS-470 AC2: at its start control closes, logged, a connection left by a control that is no longer running (a kill -9), before its first tick', async () => {
  const s = fixture({ need: false });
  const first = control(s);
  await until(() => existsSync(join(s.home, 'run.pid')));
  await run(AGENT, ['workstation:connect', 'p', ID], { env: { ...s.env, HARNESS_CONTROL_PID: String(first.child.pid) } });   // a command it ran opened it
  assert.equal(s.entry()['control-pid'], first.child.pid);
  first.child.kill('SIGKILL');
  await first.exit;
  assert.ok(existsSync(s.socket), 'a kill -9 closes nothing');
  const next = control(s, ['--once'], { CONTROL_TEST_TICK_LINES: '1' });
  assert.deepEqual(await within(next.exit), { code: 0, signal: null });
  const at = next.lines.findIndex(l => new RegExp(` workstation p ada-dev: closed the connection control ${first.child.pid} left \\(it is no longer running\\)$`).test(l));
  assert.ok(at >= 0, next.lines.join('\n'));
  assert.ok(next.lines.findIndex(l => / test tick ran$/.test(l)) > at, `before the first tick: ${next.lines.join('\n')}`);
  assert.ok(!existsSync(s.socket));
  assert.equal(s.entry().connected, false);
});

test('ASS-470 AC3: a connection opened by hand is left open by a control that never used it, at its start and as it exits', async () => {
  const s = fixture({ need: false });
  await run(AGENT, ['workstation:connect', 'p', ID], { env: s.env });
  assert.equal(s.entry()['control-pid'], null);
  const c = control(s, ['--once']);
  assert.deepEqual(await within(c.exit), { code: 0, signal: null });
  assert.ok(existsSync(s.socket), c.lines.join('\n'));
  assert.equal(s.entry().connected, true);
  assert.ok(!c.lines.some(l => / workstation p ada-dev: (closed|disconnected)/.test(l)), c.lines.join('\n'));
});
