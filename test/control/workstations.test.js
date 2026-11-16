// Control's workstation connections (ASS-433 AC3, AC4, AC5): a workstation
// something needs is connected (and started), checked, reconnected when its
// connection drops or the workstation stops, and disconnected once nothing
// has needed it for a while; a connect failing on an expired gcloud login sets
// the project's gcloud-requires-reauthentication, the TUI showing the login
// to run with its CLOUDSDK_CONFIG, and clears it once it works. The real
// workstation:* commands, against test/support/fake-gcloud.js and fake-ssh.js.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlFixture } from './control-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';
import { superviseWorkstations, workstationNeeds, disconnectWorkstations, disconnectAtExit, closeLeftovers, CHECK_EVERY, EXPIRED_RETRY } from '../../src/control/workstations.js';
import { checkGcloud } from '../../src/control/triggers.js';
import { controlPath, workstationUsable, expiredLogins, loginCommand } from '../../src/control/workstation-connection.js';
import { loadProjects } from '../../src/tui/load.js';
import { headerWarnings } from '../../src/tui/screens/frame.js';
import { initialState } from '../../src/tui/app.js';
import { until } from '../support/until.js';

const run = promisify(execFile);
const ID = 'ada-dev';
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const opened = [];
afterEach(async () => { for (const env of opened.splice(0)) await run(AGENT, ['workstation:disconnect', 'p', ID], { env }).catch(() => {}); });

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };

// Project p on workstation ada-dev; its ticket ABC-3 A records the workstation as its machine (as ASS-435 places one),
// held running for the operator (needed) unless need is false. pass() runs the phase and waits for its job.
function setup({ need = true, check = false } = {}) {
  const c = controlFixture(), w = fakeWorkstation(c.env);
  const at = (...rest) => join(c.dir, ...rest);
  edit(at('projects', 'p', 'project.json'), p => {
    p['dev-environments'] = { mode: 'vm+workstation', workstations: [{ id: ID, 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config', 'gcloud-config': '~/.config/example/gcloud' }] };
    if (check) p['check-for-expired-gcloud-auth'] = true;
  });
  edit(at('harness.json'), h => { h['forwarder-port'] = 7787; });
  const sprint = at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const hold = on => edit(sprint, s => { const v = s.features[0].variations[0]; v.vm = { name: ID, kind: 'workstation' }; if (on) v['vm-hold'] = { by: 'ada', since: '2026-11-14T00:00:00Z', note: null }; else delete v['vm-hold']; });
  hold(need);
  w.workstation(ID, 'STATE_STOPPED');
  c.ctx.env = { ...w.env, HARNESS_CONTROL_PID: String(process.pid) };   // ASS-470: as main.js gives it, this test runner standing for the control
  opened.push(w.env);
  let now = Date.parse('2026-11-14T12:00:00Z');
  c.ctx.now = () => new Date(now);
  const pass = async () => { superviseWorkstations(c.ctx, c.ctx.load()); await c.ctx.memory.workstations?.get('p')?.job; };
  const entry = () => JSON.parse(readFileSync(at('projects', 'p', 'workstations.json'), 'utf8'))[ID];
  const flag = () => (existsSync(at('projects', 'p', 'gcloud-requires-reauthentication')) ? readFileSync(at('projects', 'p', 'gcloud-requires-reauthentication'), 'utf8') : undefined);
  const gone = async file => { for (let i = 0; i < 50 && existsSync(file); i++) await new Promise(r => setTimeout(r, 100)); };
  return { c, w, at, pass, hold, entry, flag, gone, socket: controlPath(w.env, 'p', ID), later: ms => { now += ms; }, log: () => c.lines.join('\n') };
}

test('workstationNeeds (ASS-468): a workstation is needed while a step runs on it or wants it, while a holder\'s step is to end, or while held for the operator — never for a variation merely at a step that runs its machine', () => {
  const engine = { steps: [{ id: 'build', vm: 'running', action: { type: 'prompt' } }, { id: 'qa', action: { type: 'human' } }] };
  const project = (v, t = {}) => ({ id: 'p', engineName: 'e', engines: { e: engine }, devEnvironments: { mode: 'workstation', workstations: [{ id: ID }] }, tickets: [{ key: 'ABC-3', ...t, variations: [{ name: 'A', vm: { name: ID, kind: 'workstation' }, ...v }] }] });
  const at = state => ({ 'harness-status': { state, 'state-engine': 'e' } });
  const none = { assignments: [] };
  assert.equal(workstationNeeds(none, project(at('build'))).size, 0, 'AC5: no connection kept between its steps');
  assert.equal(workstationNeeds(none, project(at('build')), {}, new Map([[ID, 'ABC-3 A wants it for a step']])).get(ID), 'ABC-3 A wants it for a step');
  assert.equal(workstationNeeds(none, project(at('qa')), { [ID]: { holder: { ticket: 'ABC-3', variation: 'A' } } }).get(ID), "ABC-3 A's step to end");
  assert.equal(workstationNeeds(none, project({ ...at('qa'), 'vm-hold': { by: 'c' } })).get(ID), 'ABC-3 A held running for the operator');
  assert.equal(workstationNeeds({ assignments: [{ project: 'p', 'work-item': 'ABC-3', variation: 'A' }] }, project({ ...at('build'), workstation: { name: ID, project: 'p', folder: '/home/u/harness' } })).get(ID), "ABC-3 A's agent works on it");
  assert.equal(workstationNeeds(none, project({ ...at('build'), vm: { name: 'abc-3-a' }, 'vm-hold': { by: 'c' } })).size, 0, 'a VM is not a workstation');
  assert.equal(workstationNeeds(none, project({ ...at('build'), 'is-deleted': true, 'vm-hold': { by: 'c' } })).size, 0);
});

test('AC3: a needed workstation is started and connected, logged with why; checked no more than every minute; nothing connects one nothing needs', async () => {
  const s = setup();
  await s.pass();
  assert.equal(s.w.state(ID), 'STATE_RUNNING');
  assert.equal(s.entry().connected, true);
  assert.match(s.log(), /^workstation p ada-dev: connected \(the workstation had stopped; started it\), the forwarder, Hindsight and zot forwarded to its loopback \(ABC-3 A held running for the operator\)$/m);
  assert.ok(workstationUsable(s.entry()));
  const calls = s.w.sshCalls().length;
  s.later(CHECK_EVERY - 1000);
  await s.pass();
  assert.equal(s.w.sshCalls().length, calls, 'not checked within the minute');
  s.later(2000);
  await s.pass();
  assert.ok(s.w.sshCalls().length > calls, 'checked once the minute is up');
  assert.ok(!/reconnect/.test(s.log()));

  const t = setup({ need: false });
  await t.pass();
  assert.deepEqual(t.w.gcloudCalls(), []);
  assert.equal(t.w.state(ID), 'STATE_STOPPED');
});

test('AC3: a dropped connection is noticed and reconnected, and so is a workstation that stopped — started again — each logged', async () => {
  const s = setup();
  await s.pass();
  s.w.mark(ID, 'drop');
  await s.gone(s.socket);
  s.later(CHECK_EVERY);
  await s.pass();
  assert.match(s.log(), /^workstation p ada-dev: its connection dropped; reconnected, the forwarder, Hindsight and zot forwarded to its loopback \(ABC-3 A held running for the operator\)$/m);
  assert.equal(s.entry().connected, true);
  s.w.setState(ID, 'STATE_STOPPED');   // its idle stop, say: every SSH session ends
  await s.gone(s.socket);
  s.later(CHECK_EVERY);
  await s.pass();
  assert.match(s.log(), /^workstation p ada-dev: its connection dropped; reconnected \(the workstation had stopped; started it\)/m);
  assert.equal(s.w.state(ID), 'STATE_RUNNING');
  assert.ok(existsSync(s.socket));
});

test('AC3: once nothing needs it, the connection is closed after workstation-idle-disconnect-seconds, logged, the workstation left to stop itself', async () => {
  const s = setup();
  await s.pass();
  s.hold(false);
  await s.pass();
  s.later(299_000);
  await s.pass();
  assert.ok(existsSync(s.socket), 'still open inside the grace');
  s.later(2000);
  await s.pass();
  assert.ok(!existsSync(s.socket));
  assert.equal(s.entry().connected, false);
  assert.equal(s.w.state(ID), 'STATE_RUNNING');
  assert.match(s.log(), /^workstation p ada-dev: disconnected: nothing on it has needed it for 5m; it stops itself once idle$/m);
  // Needed again: connected again.
  s.hold(true);
  await s.pass();
  assert.equal(s.entry().connected, true);
});

test('control\'s shutdown closes the connections it opened', async () => {
  const s = setup();
  await s.pass();
  assert.equal(s.entry()['control-pid'], process.pid, 'ASS-470: recorded as its control\'s');
  await disconnectWorkstations(s.c.ctx);
  assert.ok(!existsSync(s.socket));
  assert.equal(s.entry().connected, false);
  assert.equal(s.entry()['control-pid'], null);
  assert.match(s.log(), /workstation p ada-dev: disconnected as control exits/);
});

// ASS-470: who owns a connection (the live data's control-pid), and what control closes as it exits and as it starts.
const connect = (env, extra = {}) => run(AGENT, ['workstation:connect', 'p', ID], { env: { ...env, ...extra } });
const fakeControl = () => { const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '/x/src/control/main.js'], { stdio: 'ignore' }); kills.push(p); return p; };
const kills = [];
afterEach(() => { for (const p of kills.splice(0)) p.kill('SIGKILL'); });

test('ASS-470 AC1: a connection a command control ran opened (workstation:connect under its HARNESS_CONTROL_PID, as vm:create or a step\'s claim runs it) is closed as control exits, though its phase never connected it', async () => {
  const s = setup({ need: false });
  await connect(s.c.ctx.env);
  assert.equal(s.entry()['control-pid'], process.pid);
  assert.ok(existsSync(s.socket));
  await disconnectWorkstations(s.c.ctx);
  assert.ok(!existsSync(s.socket));
  assert.equal(s.entry().connected, false);
  assert.match(s.log(), /^workstation p ada-dev: disconnected as control exits$/m);
});

test('ASS-470 AC1: process \'exit\'s last resort starts the disconnect detached, and it ends the connection after control has gone', async () => {
  const s = setup();
  await s.pass();
  disconnectAtExit(s.c.ctx);
  await s.gone(s.socket);
  assert.ok(!existsSync(s.socket));
  assert.ok(await until(() => s.entry().connected === false));
  disconnectAtExit(s.c.ctx);   // nothing owned any more, nothing started twice
});

test('ASS-470 AC1, AC3: a connection opened by hand, and one another running control owns, are left open as control exits and at its start', async () => {
  const s = setup({ need: false });
  await connect(s.w.env);   // the operator's shell: no HARNESS_CONTROL_PID
  assert.equal(s.entry()['control-pid'], null);
  await disconnectWorkstations(s.c.ctx);
  await closeLeftovers(s.c.ctx);
  assert.ok(existsSync(s.socket), 'opened by hand: left open');
  // Another control takes it as its own; this control's phase, finding it open, leaves it that control's.
  const other = fakeControl();
  await connect(s.w.env, { HARNESS_CONTROL_PID: String(other.pid) });
  assert.equal(s.entry()['control-pid'], other.pid);
  s.hold(true);
  await s.pass();
  assert.equal(s.entry()['control-pid'], other.pid, 'not taken from a running control');
  await disconnectWorkstations(s.c.ctx);
  await closeLeftovers(s.c.ctx);
  assert.ok(existsSync(s.socket), 'another running control\'s: left open');
  assert.doesNotMatch(s.log(), /disconnected as control exits|closed the connection/);
  // That control dies (a kill -9): at the next start its connection is a leftover, closed and logged.
  other.kill('SIGKILL');
  await until(() => { try { process.kill(other.pid, 0); return false; } catch { return true; } });
  await closeLeftovers(s.c.ctx);
  assert.ok(!existsSync(s.socket));
  assert.equal(s.entry().connected, false);
  assert.equal(s.entry()['control-pid'], null);
  assert.match(s.log(), new RegExp(`^workstation p ada-dev: closed the connection control ${other.pid} left \\(it is no longer running\\)$`, 'm'));
});

test('ASS-470: a hand connect takes over a connection no running control owns; a connect for a control that has exited opens nothing', async () => {
  const s = setup({ need: false });
  const gone = fakeControl();
  await connect(s.w.env, { HARNESS_CONTROL_PID: String(gone.pid) });
  gone.kill('SIGKILL');
  await until(() => { try { process.kill(gone.pid, 0); return false; } catch { return true; } });
  await connect(s.w.env);   // the operator connects by hand: now theirs
  assert.equal(s.entry()['control-pid'], null);
  await closeLeftovers(s.c.ctx);
  assert.ok(existsSync(s.socket));
  await run(AGENT, ['workstation:disconnect', 'p', ID], { env: s.w.env });
  await assert.rejects(connect(s.w.env, { HARNESS_CONTROL_PID: String(gone.pid) }), /the control that ran it \(pid \d+\) has exited: not connected/);
  assert.ok(!existsSync(s.socket));
});

test('AC4: an expired login sets gcloud-requires-reauthentication, says the login to run with its CLOUDSDK_CONFIG, holds the workstation from dispatch, retries every 2 minutes at most, and clears once it connects', async () => {
  const s = setup({ check: true });
  s.c.ctx.gcloud = async () => 'live';   // the Mac's own gcloud login is fine
  s.w.mark(null, 'expired');
  await s.pass();
  assert.equal(s.flag(), 'true');
  assert.equal(s.entry()['last-error'].kind, 'expired');
  assert.ok(!workstationUsable(s.entry()));
  assert.match(s.log(), /^gcloud p: the gcloud login of workstation ada-dev has expired; nothing is dispatched to it until it connects again; run 'CLOUDSDK_CONFIG=~\/\.config\/example\/gcloud gcloud auth login'$/m);
  assert.match(s.log(), /^error workstation p ada-dev: workstation:connect failed \(1 in a row; next try in 30s\): .*Reauthentication failed/m);
  // The Mac's check finds its own login live, but leaves the flag: the workstation's is not.
  await checkGcloud(s.c.ctx, s.c.ctx.load());
  assert.equal(s.flag(), 'true');
  // The TUI says which login to run, with its CLOUDSDK_CONFIG.
  const [p] = loadProjects(join(s.c.dir, 'projects'));
  assert.equal(p.gcloudReauthentication, true);
  const chip = headerWarnings({ ...initialState({ projects: [p], workflows: [], assignments: [] }), project: 0 }).find(w => w.id === 'gcloud-login');
  assert.equal(chip.text, "run 'CLOUDSDK_CONFIG=~/.config/example/gcloud gcloud auth login' asap");
  assert.equal(chip.todo, 'Run CLOUDSDK_CONFIG=~/.config/example/gcloud gcloud auth login in a terminal');
  // Backed off, but never past 2 minutes.
  for (let i = 0; i < 6; i++) { s.later(EXPIRED_RETRY); await s.pass(); }
  assert.match(s.log(), /7 in a row; next try in 2m/);
  const tries = s.w.gcloudCalls().length;
  s.later(60_000);
  await s.pass();
  assert.equal(s.w.gcloudCalls().length, tries);
  // The operator signs in again: the next try connects, and the flag clears.
  s.w.unmark(null, 'expired');
  s.later(EXPIRED_RETRY);
  await s.pass();
  assert.equal(s.entry().connected, true);
  assert.equal(s.entry()['last-error'], null);
  assert.equal(s.flag(), 'false');
  assert.match(s.log(), /^workstation p ada-dev: connected again \(the workstation had stopped; started it\)/m);
  assert.match(s.log(), /^gcloud p: the workstations' gcloud login is live again$/m);
});

test('AC4: a network failure is not an expiry: the flag stays unset', async () => {
  const s = setup();
  s.w.mark(null, 'offline');
  await s.pass();
  assert.equal(s.flag(), undefined);
  assert.equal(s.entry()['last-error'].kind, 'offline');
  assert.match(s.log(), /^error workstation p ada-dev: workstation:connect failed \(1 in a row; next try in 30s\): .*NameResolutionError/m);
});

test('expiredLogins and loginCommand: one login per gcloud config, the home shown as ~; none without an expired workstation', () => {
  const settings = { workstations: [{ id: 'a', 'gcloud-config': '/Users/x/.config/example/gcloud' }, { id: 'b', 'gcloud-config': '/Users/x/.config/example/gcloud' }, { id: 'c' }] };
  const expired = { 'last-error': { kind: 'expired' } };
  assert.deepEqual(expiredLogins(settings, { a: expired, b: expired, c: { 'last-error': { kind: 'offline' } } }, '/Users/x'), [{ ids: ['a', 'b'], config: '/Users/x/.config/example/gcloud', command: 'CLOUDSDK_CONFIG=~/.config/example/gcloud gcloud auth login' }]);
  assert.deepEqual(expiredLogins(settings, { c: expired }, '/Users/x'), [{ ids: ['c'], config: null, command: 'gcloud auth login' }]);
  assert.deepEqual(expiredLogins(null, { a: expired }), []);
  assert.equal(loginCommand('/opt/gcloud', '/Users/x'), 'CLOUDSDK_CONFIG=/opt/gcloud gcloud auth login');
});

// ASS-434: control sets a workstation up after every connect and when the setup's version changes, before anything is dispatched.
test('ASS-434 AC2: control runs workstation:setup after the connect, before the workstation is usable; again only when the version changes or the workstation restarted', async () => {
  const s = setup();
  await s.pass();
  const e = s.entry();
  assert.equal(e.setup.ok, true);
  assert.ok(e.setup['checked-at'] >= e['connected-at']);
  assert.ok(workstationUsable(e));
  assert.match(s.log(), /^workstation p ada-dev: set up: made the runtime folder .*; installed agent\.sh /m);
  const setups = () => s.w.sshCalls().filter(c => c.argv.at(-1)?.includes('workstation-setup')).length;
  assert.equal(setups(), 1);
  // The minute's check: same version, nothing run.
  s.later(CHECK_EVERY);
  await s.pass();
  assert.equal(setups(), 1);
  // The tools list changes: a new version, set up at the next check.
  edit(s.at('projects', 'p', 'project.json'), p => { p['golden-image'] = { ...p['golden-image'], tools: ['git'] }; });
  s.later(CHECK_EVERY);
  await s.pass();
  assert.equal(setups(), 2);
  assert.match(s.log(), /^workstation p ada-dev: set up: recorded setup /m);
  // A restart (its idle stop): reconnected, started, and set up again — the runtime folder made anew, nothing reinstalled.
  s.w.setState(ID, 'STATE_STOPPED');
  await s.gone(s.socket);
  s.later(CHECK_EVERY);
  await s.pass();
  assert.equal(setups(), 3);
  assert.ok(s.entry().setup.did.some(d => /^made the runtime folder/.test(d)));
  assert.ok(workstationUsable(s.entry()));
});

test('ASS-434 AC3: a setup that fails (Docker not usable) is logged naming it, holds the workstation from dispatch, shows in the TUI, is retried after the backoff, and clears once fixed', async () => {
  const s = setup();
  s.w.mark(ID, 'docker-broken');
  await s.pass();
  assert.equal(s.entry().connected, true);
  assert.equal(s.entry().setup.ok, false);
  assert.ok(!workstationUsable(s.entry()));
  assert.match(s.log(), /^error workstation p ada-dev: workstation:setup failed \(1 in a row; next try in 30s\); nothing is dispatched to it until it is set up: docker: not usable \(docker info failed\): permission denied/m);
  const [p] = loadProjects(join(s.c.dir, 'projects'));
  const chip = headerWarnings({ ...initialState({ projects: [p], workflows: [], assignments: [] }), project: 0 }).find(w => w.id === `workstation-setup:${ID}`);
  assert.equal(chip.text, `Workstation ${ID} setup failed`);
  assert.equal(chip.chip, true);
  assert.match(chip.todo, /^Fix workstation ada-dev's setup \(nothing is dispatched to it meanwhile\): docker: not usable/);
  // Within the backoff: not tried again, even at the minute's check.
  const setups = () => s.w.sshCalls().filter(c => c.argv.at(-1)?.includes('workstation-setup')).length;
  s.later(20_000);
  await s.pass();
  assert.equal(setups(), 1);
  // Fixed: the next try after the backoff sets it up.
  s.w.unmark(ID, 'docker-broken');
  s.later(CHECK_EVERY);
  await s.pass();
  assert.equal(setups(), 2);
  assert.ok(workstationUsable(s.entry()));
  assert.match(s.log(), /^workstation p ada-dev: set up again/m);
  const [q] = loadProjects(join(s.c.dir, 'projects'));
  assert.equal(headerWarnings({ ...initialState({ projects: [q], workflows: [], assignments: [] }), project: 0 }).find(w => w.id === `workstation-setup:${ID}`), undefined);
});

test('ASS-469 AC6: a stopped workstation whose seat a ticket holds is started at once and kept connected between its steps; with no seat-holder and nobody waiting it is disconnected after the idle time, to stop itself', async () => {
  const s = setup({ need: false });
  const seats = s.at('projects', 'p', 'seats.json');
  writeFileSync(seats, JSON.stringify({ seats: [{ key: 'ABC-3', variation: 'A', kind: 'workstation', workstation: ID, since: '2026-11-16T00:00:00Z' }] }));
  await s.pass();
  assert.equal(s.w.state(ID), 'STATE_RUNNING');
  assert.match(s.log(), /^workstation p ada-dev: connected \(the workstation had stopped; started it\), the forwarder, Hindsight and zot forwarded to its loopback \(its seat: ABC-3 A\)$/m);
  s.later(10 * 60_000);   // no step on it all this while: its seat keeps it
  await s.pass();
  assert.ok(existsSync(s.socket), 'kept while its seat is held');
  writeFileSync(seats, JSON.stringify({ seats: [] }));
  await s.pass();
  s.later(301_000);
  await s.pass();
  assert.ok(!existsSync(s.socket), s.log());
  assert.match(s.log(), /ada-dev: disconnected: nothing on it has needed it for 5m/);
});
