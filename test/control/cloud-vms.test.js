// ASS-481: cloud VMs (plain GCP Compute Engine VMs) as control sees them.
// AC1: dev-environments' cloud-vms — validated as workstations are (missing
// fields, ids unique across both lists, a bad gcloud-config, a bad
// ssh-user), read into the remote pool after the workstations, kind
// cloud-vm; a project without cloud-vms as before. AC3: each usable cloud VM
// is one remote seat (kind cloud-vm), preferred over VM seats, filled after
// the workstations', lost while it can't be used (a start that timed out
// too) and filled again once it can; the machine layer names it
// cloud-vm:<project>:<id>:<folder>. AC4: control's keep-awake rule starts a
// stopped cloud VM whose seat a ticket holds before anything is dispatched,
// and its idle disconnect never stops it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devEnvironments, devEnvironmentsErrors, cloudVmsOf, workstationsOf } from '../../src/control/dev-environments.js';
import { seatCapacity, placeSeats, keepSeats, lostWhy, seatWords } from '../../src/control/seat-kinds.js';
import { seatNeeds } from '../../src/control/seats.js';
import { setUp, workstationUsable } from '../../src/control/workstation-connection.js';
import { machineOf, onWorkstation, machinePaths, remoteName } from '../../src/control/machine.js';
import { cloudVmState, onWorkstationSeat } from '../../src/control/workstation-machines.js';
import { superviseWorkstations } from '../../src/control/workstations.js';
import { controlFixture } from './control-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const env = { HOME: '/home/me' };
const ws = { id: 'ada-dev', 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config' };
const vm = { id: 'ada-vm', 'gcp-project': 'example-gcp-project', zone: 'us-central1-a' };
const project = d => ({ name: 'P', 'dev-environments': d });
const at = '2026-11-17T00:00:00Z';
const usable = { connected: true, 'connected-at': at, setup: { ok: true, 'checked-at': at } };

test('AC1: cloud-vms are read after the workstations, kind cloud-vm, gcloud-config\'s ~ expanded, ssh-user kept; a project without them reads as before', () => {
  const d = devEnvironments(project({ mode: 'vm+workstation', workstations: [ws], 'cloud-vms': [{ ...vm, 'gcloud-config': '~/.config/example/gcloud', 'ssh-user': 'ada_lovelace_example_com', note: 'x' }, { ...vm, id: 'vm-2' }] }), env);
  assert.deepEqual(d, { mode: 'vm+workstation', workstations: [ws,
    { kind: 'cloud-vm', ...vm, 'gcloud-config': '/home/me/.config/example/gcloud', 'ssh-user': 'ada_lovelace_example_com' },
    { kind: 'cloud-vm', ...vm, id: 'vm-2' }] });
  assert.deepEqual(cloudVmsOf(d).map(w => w.id), ['ada-vm', 'vm-2']);
  assert.deepEqual(workstationsOf(d), [ws]);
  assert.deepEqual(devEnvironments(project({ mode: 'workstation', workstations: [ws] }), env), { mode: 'workstation', workstations: [ws] });
  assert.deepEqual(cloudVmsOf(null), []);
});

test('AC1: vm+workstation and workstation modes take a pool of cloud VMs alone; with neither they are refused as before; vm mode needs none', () => {
  for (const mode of ['vm+workstation', 'workstation']) assert.deepEqual(devEnvironmentsErrors(project({ mode, 'cloud-vms': [vm] })), [], mode);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation' })), ['dev-environments.workstations is missing: mode workstation needs at least one workstation']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': [] })), ['dev-environments.workstations is missing: mode workstation needs at least one workstation or cloud VM']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'vm', 'cloud-vms': [vm] })), []);
});

test('AC1: a cloud VM missing a field, with a bad one, or with an id a workstation or an earlier cloud VM has, is refused naming the field', () => {
  for (const field of ['id', 'gcp-project', 'zone']) {
    const { [field]: _, ...missing } = { ...vm, id: 'other' };
    assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': [vm, missing] })), [`dev-environments.cloud-vms[1].${field} is missing`]);
  }
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': [{ ...vm, zone: ' ' }] })), ['dev-environments.cloud-vms[0].zone is not a non-empty string']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': vm })), ['dev-environments.workstations is missing: mode workstation needs at least one workstation or cloud VM', 'dev-environments.cloud-vms is not a list']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': ['ada-vm'] })), ['dev-environments.cloud-vms[0] is not an object']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': [{ ...vm, id: 'a b' }] })), ['dev-environments.cloud-vms[0].id "a b" has a character other than A-Z, a-z, 0-9, _ and -']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': [{ ...vm, 'gcloud-config': 'gcloud' }] })), ['dev-environments.cloud-vms[0].gcloud-config is not a folder starting with /, ~ or $HOME']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': [{ ...vm, 'ssh-user': 'Ada Lovelace' }] })), ['dev-environments.cloud-vms[0].ssh-user is not a user name (a-z, 0-9, _, . and -)']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', workstations: [ws], 'cloud-vms': [{ ...vm, id: 'ada-dev' }] })), ['dev-environments.cloud-vms[0].id "ada-dev" is used by a workstation too']);
  assert.deepEqual(devEnvironmentsErrors(project({ mode: 'workstation', 'cloud-vms': [vm, { ...vm, zone: 'europe-west1-b' }] })), ['dev-environments.cloud-vms[1].id "ada-vm" is used by an earlier cloud VM too']);
  assert.throws(() => devEnvironments(project({ mode: 'workstation', 'cloud-vms': [{ id: 'x' }] }), env), /cloud-vms\[0\]\.gcp-project is missing; dev-environments\.cloud-vms\[0\]\.zone is missing/);
});

// A project in `mode` on workstation ws-1 and cloud VMs vm-1, vm-2 (the pool), `vms` VM seats, live data `live`.
const pool = (mode, { vms = 1, live = {}, seats = [] } = {}) => ({
  id: 'p', json: { 'max-tickets-in-progress': vms }, workstations: live, seats,
  devEnvironments: devEnvironments(project({ mode, workstations: [{ ...ws, id: 'ws-1' }], 'cloud-vms': [{ ...vm, id: 'vm-1' }, { ...vm, id: 'vm-2' }] }), env),
});
const r = (key, variation = 'A') => ({ key, variation });
const kinds = records => records.map(s => `${s.key} ${s.kind}${s.workstation ? ` ${s.workstation}` : ''}`);

test('AC3: each cloud VM is one remote seat, kind cloud-vm; free seats are filled workstations first, then cloud VMs in list order, then VM seats', () => {
  const capacity = seatCapacity(pool('vm+workstation'));
  assert.equal(capacity.total, 4);
  assert.deepEqual(capacity.workstations.map(w => [w.id, w.kind ?? 'workstation']), [['ws-1', 'workstation'], ['vm-1', 'cloud-vm'], ['vm-2', 'cloud-vm']]);
  const out = placeSeats({ records: [], reserved: [r('T-1'), r('T-2'), r('T-3'), r('T-4'), r('T-5')], capacity });
  assert.deepEqual(kinds(out.records), ['T-1 workstation ws-1', 'T-2 cloud-vm vm-1', 'T-3 cloud-vm vm-2', 'T-4 vm']);
  assert.equal(seatWords(out.records[1]), 'a cloud VM seat on vm-1');
  assert.equal(seatCapacity(pool('vm')).workstations.length, 0, 'vm mode ignores cloud VMs');
  assert.equal(seatCapacity(pool('workstation')).total, 3);
});

test('AC3: a freed cloud VM seat goes to a VM-seat holder between its steps; a cloud VM that can\'t be used loses its seat (a start that timed out too), its holder taken out, and its seat is filled again once it can', () => {
  const capacity = seatCapacity(pool('vm+workstation', { live: { 'ws-1': usable } }));
  const held = [{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', since: at }, { key: 'T-2', variation: 'A', kind: 'vm', since: at }];
  const moved = placeSeats({ records: held, reserved: [r('T-1'), r('T-2')], capacity });
  assert.deepEqual(kinds(moved.records), ['T-1 workstation ws-1', 'T-2 cloud-vm vm-1']);
  assert.deepEqual(moved.moved, [{ key: 'T-2', variation: 'A', workstation: 'vm-1', kind: 'cloud-vm' }]);

  const timedOut = { connected: false, 'last-error': { at, kind: 'timeout', message: 'its SSH did not answer' } };
  assert.match(lostWhy(timedOut), /^its start timed out: its SSH did not answer/);
  const lost = seatCapacity(pool('vm+workstation', { live: { 'vm-1': timedOut, 'vm-2': { 'last-error': { kind: 'expired' } } } }));
  assert.equal(lost.total, 2);
  const kept = keepSeats(moved.records, lost);
  assert.deepEqual(kept.lost, [{ key: 'T-2', variation: 'A', workstation: 'vm-1', kind: 'cloud-vm', why: lostWhy(timedOut) }]);
  const reseated = placeSeats({ records: kept.kept, reserved: [r('T-1'), r('T-2')], capacity: lost });
  assert.deepEqual(kinds(reseated.records), ['T-1 workstation ws-1', 'T-2 vm'], 'it takes the next free seat of either kind');
  const back = placeSeats({ records: reseated.records, reserved: [r('T-1'), r('T-2')], capacity: seatCapacity(pool('vm+workstation')) });
  assert.deepEqual(kinds(back.records), ['T-1 workstation ws-1', 'T-2 cloud-vm vm-1'], 'back once usable');
  // Seat records name their remote's kind; an id moved from one list to the other is corrected, not lost.
  assert.deepEqual(kinds(keepSeats([{ key: 'T-3', variation: 'A', kind: 'workstation', workstation: 'vm-2', since: at }], capacity).kept), ['T-3 cloud-vm vm-2']);
  const p = { ...pool('workstation', { seats: back.records }), tickets: [{ key: 'T-2', variations: [{ name: 'A' }] }] };
  assert.ok(onWorkstationSeat(p, p.tickets[0].variations[0]), 'a cloud VM seat holder takes no Mac memory');
});

test('AC4: a cloud VM is needed while its seat is held, and while free with a ticket waiting; never with nobody seated and nobody waiting', () => {
  const p = pool('workstation', { seats: [{ key: 'T-1', variation: 'A', kind: 'cloud-vm', workstation: 'vm-1', since: at }] });
  const none = { reserved: [], waiting: [], ready: [] };
  const needs = seatNeeds({}, p, none);
  assert.equal(needs.get('vm-1'), 'its seat: T-1 A');
  assert.equal(needs.has('vm-2'), false);
  assert.match(seatNeeds({}, p, { ...none, waiting: [r('T-9')] }).get('vm-2'), /a free seat: T-9 A waiting for one/);
  assert.equal(seatNeeds({}, { ...p, seats: [] }, none).size, 0);
});

test('AC3: a cloud VM set up under the boot it runs now stays set up across a reconnect (its disk persists); a new boot, or a new version, wants setup again; a workstation\'s rule is unchanged', () => {
  const later = '2026-11-17T01:00:00Z';
  const entry = { connected: true, 'connected-at': later, 'boot-id': 'b1', setup: { ok: true, 'checked-at': at, 'boot-id': 'b1', version: 'v1' } };
  assert.ok(setUp(entry, 'v1'));
  assert.ok(workstationUsable(entry, 'v1'));
  assert.ok(!setUp(entry, 'v2'), 'a new version');
  assert.ok(!setUp({ ...entry, 'boot-id': 'b2' }, 'v1'), 'a new boot');
  const { 'boot-id': _, ...workstation } = entry;
  assert.ok(!setUp(workstation, 'v1'), 'a workstation: set up since its connection opened, as before');
});

test('AC2: the machine layer names a cloud VM\'s claim cloud-vm:<project>:<id>:<folder>, and tells the agent it is on a cloud VM', () => {
  const folder = '/home/ada_lovelace_example_com/harness';
  const machine = machineOf({ vm: { name: 'x-1' }, workstation: { name: 'vm-1', project: 'p', folder, kind: 'cloud-vm' } });
  assert.equal(machine, `cloud-vm:p:vm-1:${folder}`);
  assert.equal(machineOf({ vm: { name: 'vm-1', kind: 'cloud-vm', project: 'p', folder } }), machine);
  assert.deepEqual(onWorkstation(machine), { project: 'p', id: 'vm-1', folder, kind: 'cloud-vm' });
  assert.equal(remoteName(machine), `p:vm-1:${folder}`);
  assert.equal(remoteName('ass-1-a'), null);
  assert.equal(machinePaths(machine).repos, `${folder}/repos/`);
  assert.match(machinePaths(machine).where, /^on the GCP cloud VM vm-1, in its shared repositories/);
  assert.equal(machineOf({ workstation: { name: 'ws-1', project: 'p', folder } }), `workstation:p:ws-1:${folder}`, 'a workstation\'s as before');
});

test('AC5: a cloud VM\'s state words', () => {
  assert.equal(cloudVmState(undefined), 'stopped');
  assert.equal(cloudVmState(usable), 'running');
  assert.equal(cloudVmState({ connected: true, 'connected-at': at }), 'connecting');
  assert.equal(cloudVmState({ state: 'starting', 'state-at': at }), 'starting');
  assert.equal(cloudVmState({ state: 'starting', 'state-at': at, 'last-error': { at: '2026-11-17T00:00:05Z', kind: 'offline' } }), 'stopped', 'a start that failed since');
  assert.equal(cloudVmState({ connected: false, 'last-error': { at, kind: 'timeout' } }), 'start timed out');
  assert.equal(cloudVmState({ 'last-error': { at, kind: 'expired' } }), 'sign in needed');
  assert.equal(cloudVmState({ connected: true, setup: { ok: false } }), 'setup failed');
});

// AC4 against the real workstation:* commands and a fake cloud VM: its seat held, a stopped VM is started and
// connected before any step; idle, it is disconnected — never stopped.
const VM = 'vm-1';
const opened = [];
afterEach(async () => { for (const e of opened.splice(0)) await run(AGENT, ['workstation:disconnect', 'p', VM], { env: e }).catch(() => {}); });

test('AC4: keep-awake — a TERMINATED cloud VM whose seat a ticket holds is started and connected by control before its step; with nobody seated it is disconnected after the idle time and left to stop itself, never stopped by control', async () => {
  const c = controlFixture(), w = fakeWorkstation(c.env);
  const file = (...rest) => join(c.dir, ...rest);
  const edit = (f, change) => { const json = JSON.parse(readFileSync(f, 'utf8')); change(json); writeFileSync(f, JSON.stringify(json, null, 4)); };
  edit(file('projects', 'p', 'project.json'), p => { p['dev-environments'] = { mode: 'vm+workstation', 'cloud-vms': [{ id: VM, 'gcp-project': 'example-gcp-project', zone: 'us-central1-a' }] }; });
  edit(file('harness.json'), h => { h['forwarder-port'] = 7787; });
  w.cloudVm(VM, 'TERMINATED');
  c.ctx.env = { ...w.env, HARNESS_CONTROL_PID: String(process.pid), CLOUD_VM_PROBE_SECONDS: '2' };
  opened.push(c.ctx.env);
  let now = Date.parse('2026-11-17T12:00:00Z');
  c.ctx.now = () => new Date(now);
  const pass = async () => { superviseWorkstations(c.ctx, c.ctx.load()); await c.ctx.memory.workstations?.get('p')?.job; };
  const seats = file('projects', 'p', 'seats.json');
  writeFileSync(seats, JSON.stringify({ seats: [{ key: 'ABC-3', variation: 'A', kind: 'cloud-vm', workstation: VM, since: at }] }));
  await pass();
  const log = () => c.lines.join('\n');
  assert.equal(w.status(VM), 'RUNNING', log());
  assert.match(log(), /^workstation p vm-1: connected \(the cloud VM had stopped; started it\), the forwarder, Hindsight and zot forwarded to its loopback \(its seat: ABC-3 A\)$/m);
  const entry = () => JSON.parse(readFileSync(file('projects', 'p', 'workstations.json'), 'utf8'))[VM];
  assert.ok(workstationUsable(entry()), 'set up before anything is dispatched to it');
  const socket = join(w.env.HARNESS_HOME, 'workstations', `p-${VM}.sock`);
  writeFileSync(seats, JSON.stringify({ seats: [] }));
  await pass();
  now += 301_000;
  await pass();
  assert.ok(!existsSync(socket), log());
  assert.match(log(), /vm-1: disconnected: nothing on it has needed it for 5m/);
  assert.equal(w.status(VM), 'RUNNING', 'left to stop itself');
  assert.ok(!w.gcloudCalls().some(x => /^(stop|suspend|reset|delete)$/.test(x.argv.filter(a => !a.startsWith('--'))[2] ?? '')), 'control never stops it');
});
