// ASS-557 AC1, AC6: each remote machine's disk — the folder its tickets' work lives in — is measured with its memory
// and CPU (workstation:usage, recorded in workstations.json, carried into remote-seats.json), and a machine below its
// disk hold takes no new work, not even a first, until its disk is back above the warn level (capped so a small disk
// can come out of it), logged once when the hold starts and once when it ends — as the Mac's disk hold (disk.js).
// The reading against a fake machine (test/support/fake-workstation.js's df file); the hold pure and through control's
// phases (budgetRemote, assignSeats).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineSeats, diskHold, diskOf, diskLevelsOf, budgetRemote, DISK_RECHECK } from '../../src/control/remote-seats.js';
import { assignSeats } from '../../src/control/seats.js';
import { devEnvironments, devEnvironmentsErrors } from '../../src/control/dev-environments.js';
import { controlFixture } from './control-fixture.js';
import { wsFixture, closeAll, ID } from '../agent-cli/workstation-fixture.js';

afterEach(closeAll);

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const usage = (totalGib, usedGib, cores, cpu, disk, at = NOW) => ({
  at: iso(at), error: null,
  memory: { 'total-bytes': totalGib * GIB, 'available-bytes': (totalGib - usedGib) * GIB },
  cpu: { cores, samples: [4, 3, 2, 1, 0].map(m => ({ at: iso(at - m * 60e3), percent: cpu })) },
  disk: disk && { folder: '/home/u/harness', 'total-bytes': disk.total * 1e9, 'used-bytes': (disk.total - disk.free) * 1e9, 'available-bytes': disk.free * 1e9 },
});
const live = u => ({ connected: true, 'connected-at': iso(NOW - 3600e3), setup: { ok: true, 'checked-at': iso(NOW - 3600e3) }, usage: u });
const levels = diskLevelsOf({}, {});

test('ASS-557 AC1: workstation:usage reads the disk the work lives on with memory and CPU and records it in workstations.json (fake machine)', async () => {
  const s = wsFixture();
  let r = await s.result('workstation:connect', 'p', ID);
  assert.equal(r.code, 0, r.err);
  r = await s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 0, r.err);
  s.w.machine(64, 6, 16, { totalGib: 200, usedGib: 150 });
  r = await s.result('workstation:usage', 'p', ID);
  assert.equal(r.code, 0, r.err);
  const d = s.entry().usage.disk;
  assert.deepEqual([d['total-bytes'], d['used-bytes'], d['available-bytes']], [200 * GIB, 150 * GIB, 50 * GIB]);
  assert.match(d.folder, /harness$/, 'the work folder, ~/harness, once setup made it');
  assert.equal(s.entry().usage.memory['total-bytes'], 64 * GIB, 'memory read in the same call');
  assert.deepEqual(JSON.parse(r.out.trim().split('\n').pop()).usage.disk, d, 'printed too');
  // df unreadable: memory and CPU still recorded, the disk null.
  s.w.disk(0, 0);
  writeFileSync(join(s.w.dir, 'proc', 'df'), 'garbage\n');
  assert.equal((await s.result('workstation:usage', 'p', ID)).code, 0);
  assert.equal(s.entry().usage.disk, null);
  assert.equal(s.entry().usage.memory['total-bytes'], 64 * GIB);
});

test('ASS-557 AC1: the disk hold — below its hold no new ticket, not even a first; held until back above the warn level (capped for a small disk); per-machine levels', () => {
  assert.deepEqual(levels, { hold: 15e9, warn: 50e9 });
  assert.deepEqual(diskLevelsOf({ 'disk-free-hold-gb': 5 }, { 'disk-free-hold-gb': 20, 'disk-free-warn-gb': 40 }), { hold: 5e9, warn: 40e9 });
  const disk = (total, free) => diskOf(live(usage(64, 6, 16, 100, { total, free })));
  assert.deepEqual(disk(200, 10), { folder: '/home/u/harness', total: 200e9, used: 190e9, free: 10e9, at: iso(NOW) });
  assert.equal(diskOf(live(usage(64, 6, 16, 100, null))), null);
  // Below 15 GB: held; 30 GB free after it: still held (below 50); 60: released. Never held: 30 is fine.
  assert.equal(diskHold({ disk: disk(200, 10), levels }).held, true);
  assert.equal(diskHold({ disk: disk(200, 30), levels, was: true }).held, true);
  assert.equal(diskHold({ disk: disk(200, 60), levels, was: true }).held, false);
  assert.equal(diskHold({ disk: disk(200, 30), levels }).held, false);
  // A 40 GB disk can't reach 50 GB free: it is released at (15 + 40) / 2 = 27.5.
  assert.equal(diskHold({ disk: disk(40, 28), levels, was: true }).held, false);
  assert.equal(diskHold({ disk: disk(40, 27), levels, was: true }).held, true);
  // Not measured: a hold its last reading set lasts DISK_RECHECK, then the one-seat rule again.
  assert.equal(diskHold({ disk: disk(200, 10), levels, was: true, measured: false, now: NOW + DISK_RECHECK - 1 }).held, true);
  assert.equal(diskHold({ disk: disk(200, 10), levels, was: true, measured: false, now: NOW + DISK_RECHECK + 1 }).held, false);
  assert.equal(diskHold({ disk: null, levels, was: true }).held, false, 'a disk df cannot read holds nothing');
  // Admission: held takes no new ticket, not even a first; those held are kept.
  const lim = { memory: 90, cpu: 90 };
  let r = machineSeats({ entry: live(usage(64, 6, 16, 100, { total: 200, free: 10 })), limits: lim, held: 0, now: NOW, diskHeld: true });
  assert.deepEqual([r.seats, r.admit, r.over], [0, false, ['work-disk']]);
  assert.match(r.why, /its disk is below its hold/);
  r = machineSeats({ entry: live(usage(64, 6, 16, 100, { total: 200, free: 10 })), limits: lim, held: 2, now: NOW, diskHeld: true });
  assert.equal(r.seats, 2);
  r = machineSeats({ entry: { connected: false, usage: usage(64, 6, 16, 100, { total: 200, free: 10 }) }, limits: lim, held: 0, now: NOW, diskHeld: true });
  assert.deepEqual([r.seats, r.state], [0, 'unmeasured'], 'not measured but held: no ticket starts it');
  assert.equal(machineSeats({ entry: live(usage(64, 6, 16, 100, { total: 200, free: 100 })), limits: lim, held: 1, now: NOW }).seats, 2);
  // project.json: per-machine levels pass through and are checked.
  const ws = { id: 'w', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' };
  const json = w => ({ 'dev-environments': { mode: 'workstation', workstations: [w] } });
  assert.deepEqual(devEnvironments(json({ ...ws, 'disk-free-hold-gb': 5, 'disk-free-warn-gb': 20 })).workstations[0], { ...ws, 'disk-free-hold-gb': 5, 'disk-free-warn-gb': 20 });
  assert.deepEqual(devEnvironmentsErrors(json({ ...ws, 'disk-free-hold-gb': -1 })), ['dev-environments.workstations[0].disk-free-hold-gb is not a positive number of GB']);
  assert.deepEqual(devEnvironmentsErrors(json({ ...ws, 'disk-free-hold-gb': 30, 'disk-free-warn-gb': 20 })), ['dev-environments.workstations[0].disk-free-hold-gb is above its disk-free-warn-gb']);
});

test('ASS-557 AC1: control holds new work off a machine whose disk is below its hold, logged once, records the disk in remote-seats.json, and gives work again once it is freed', async () => {
  const s = onOneMachine();
  const claimed = { holder: { ticket: 'ABC-3', variation: 'A', folder: '/home/u/harness' } };
  // Plenty of disk: ABC-3 runs there, a second fits.
  s.entry({ ...live(usage(64, 5, 16, 100, { total: 200, free: 120 })), ...claimed });
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3'], s.log());
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3', 'ABC-4'], s.log());
  assert.deepEqual(s.budget().disk, { folder: '/home/u/harness', 'total-bytes': 200e9, 'used-bytes': 80e9, 'free-bytes': 120e9, at: iso(NOW), 'hold-bytes': 15e9, 'warn-bytes': 50e9, 'release-bytes': 50e9, held: false });
  // Its disk falls below 15 GB: no new ticket; those held keep running; logged once.
  s.entry({ ...live(usage(64, 5, 16, 100, { total: 200, free: 10 })), ...claimed });
  await s.tick();
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3', 'ABC-4'], s.log());
  assert.equal(s.budget().disk.held, true);
  assert.deepEqual(s.budget().seats, 2);
  const holds = () => s.c.lines.filter(l => /^hold p ws-1: its disk \(\/home\/u\/harness\) has 9\.3 GiB free of 186\.3, below its 15 GB hold — no new tickets on it until 50 GB is free; the 2 it holds keep running$/.test(l)).length;
  assert.equal(holds(), 1, s.log());
  // 30 GB free: still held (below the 50 GB warn level), not logged again.
  s.entry({ ...live(usage(64, 5, 16, 100, { total: 200, free: 30 })), ...claimed });
  await s.tick();
  assert.equal(s.budget().disk.held, true);
  assert.equal(holds(), 1);
  // 80 GB free: released, logged once, a third ticket seated.
  s.entry({ ...live(usage(64, 5, 16, 100, { total: 200, free: 80 })), ...claimed });
  await s.tick();
  assert.equal(s.budget().disk.held, false);
  assert.deepEqual(s.seated(), ['ABC-3', 'ABC-4', 'ABC-5'], s.log());
  assert.equal(s.c.lines.filter(l => /^hold p ws-1: its disk has 74\.5 GiB free again, back above 50 GB: it takes tickets again$/.test(l)).length, 1, s.log());
  // Per machine: its own hold of 100 GB holds it at 80 GB free.
  s.edit(s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].workstations[0]['disk-free-hold-gb'] = 100; p['dev-environments'].workstations[0]['disk-free-warn-gb'] = 150; });
  await s.tick();
  assert.equal(s.budget().disk.held, true);
  assert.equal(s.budget()['disk']['hold-bytes'], 100e9);
});

const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
// The control fixture's p in workstation mode on one machine, ws-1, with ABC-3..ABC-6 A at build (as remote-seats.test.js's).
function onOneMachine() {
  const c = controlFixture();
  const at = (...rest) => join(c.dir, ...rest);
  const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
  edit(at('engines', 'example-development', 'workflow.yaml'), e => { e.steps.find(s => s.id === 'build')['run-location'] = 'vm'; });
  edit(at('projects', 'p', 'project.json'), p => { p['dev-environments'] = { mode: 'workstation', workstations: [ws('ws-1')] }; });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
    sp.features = ['ABC-3', 'ABC-4', 'ABC-5', 'ABC-6'].map((key, i) => ({ key, 'manual-priority': i + 1, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'example-development' }, 'state-changes': [] }] }));
  });
  c.ctx.now = () => new Date(NOW);
  const entry = e => writeFileSync(at('projects', 'p', 'workstations.json'), JSON.stringify({ 'ws-1': e }));
  const seated = () => (existsSync(at('projects', 'p', 'seats.json')) ? JSON.parse(readFileSync(at('projects', 'p', 'seats.json'), 'utf8')).seats.map(s => s.key) : []);
  const tick = async () => { const state = c.ctx.load(); await budgetRemote(c.ctx, state); await assignSeats(c.ctx, state); };
  const budget = () => JSON.parse(readFileSync(at('projects', 'p', 'remote-seats.json'), 'utf8'))['ws-1'];
  return { c, at, edit, entry, seated, tick, budget, log: () => c.lines.join('\n') };
}
