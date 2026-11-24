// ASS-529: a workstation or cloud VM takes several of its project's tickets,
// up to its own memory and CPU limits (remote-seats.js), each seat-holder's
// step in a folder of its own there. AC1: another ticket is admitted while the
// machine's measured memory and CPU, plus one more ticket's expected use, stay
// under its limits (its own max-memory-percent / max-cpu-percent, else
// harness.json's); a machine not measured keeps one seat, one whose reading
// failed takes no new ticket. AC4: a machine that becomes unusable loses all
// its seats. AC5: it is needed only while a ticket on it needs it. AC6: two
// and three tickets on one machine, the limit reached, a lost machine — pure
// and through control's phases (budgetRemote, assignSeats).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineSeats, readingOf, limitsOf, budgetRemote, READING_STALE } from '../../src/control/remote-seats.js';
import { seatCapacity, keepSeats, placeSeats, remoteSeats } from '../../src/control/seat-kinds.js';
import { assignSeats, seatNeeds } from '../../src/control/seats.js';
import { workstationNeeds } from '../../src/control/workstations.js';
import { holdersOf, holderOf } from '../../src/control/workstation-connection.js';
import { devEnvironments, devEnvironmentsErrors, isolationOf } from '../../src/control/dev-environments.js';
import { runsTests } from '../../src/control/machine-steps.js';
import { testsOn } from '../../src/control/workstation-steps.js';
import { controlFixture } from './control-fixture.js';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
// usage(totalGib, usedGib, cores, cpu) — a fresh reading as workstation:usage records it (cpu: percent of one core, a sample a minute for 5 minutes).
const usage = (totalGib, usedGib, cores, cpu, at = NOW) => ({
  at: iso(at), error: null,
  memory: { 'total-bytes': totalGib * GIB, 'available-bytes': (totalGib - usedGib) * GIB },
  cpu: { cores, samples: [4, 3, 2, 1, 0].map(m => ({ at: iso(at - m * 60e3), percent: cpu })) },
});
const live = u => ({ connected: true, 'connected-at': iso(NOW - 3600e3), setup: { ok: true, 'checked-at': iso(NOW - 3600e3) }, usage: u });
const limits = { memory: 90, cpu: 90 };
const seats = (entry, held, pending = 0, harness = {}) => machineSeats({ entry, limits, held, pending, harness, now: NOW });

test('AC1: another ticket is admitted while measured memory and CPU plus one more ticket stay within the limits; two and three tickets on one machine', () => {
  // 64 GiB, 16 cores: 57.6 GiB and 1440% may be used. One ticket on it using 6 GiB and 150%: one more fits.
  let r = seats(live(usage(64, 6, 16, 150)), 1);
  assert.equal(r.state, 'measured');
  assert.equal(r.seats, 2, r.why);
  assert.equal(Math.round(r.per.memory / GIB), 6);   // its tickets' use shared out (above the 4 GiB floor)
  // Two on it (12 GiB, 300%): a third fits.
  assert.equal(seats(live(usage(64, 12, 16, 300)), 2).seats, 3);
  // Three on it (18 GiB, 450%): a fourth too — the machine is filled as far as it carries.
  assert.equal(seats(live(usage(64, 18, 16, 450)), 3).seats, 4);
  // With none on it, it always takes one (as before ASS-529), whatever it reads.
  assert.equal(seats(live(usage(8, 7.9, 1, 99)), 0).seats, 1);
});

test('AC1, AC6: the limit reached — memory, CPU, or seats not yet running counted as one ticket each — admits no one more; nothing held is cut off', () => {
  // 16 GiB (14.4 usable): two tickets using 12 GiB; one more (6 GiB each) would pass the memory limit.
  let r = seats(live(usage(16, 12, 16, 100)), 2);
  assert.deepEqual([r.seats, r.over], [2, ['memory']], r.why);
  assert.match(r.why, /memory limit/);
  // 4 cores (360%): three tickets at 330% averaged; one more (at least one core) passes the CPU limit.
  r = seats(live(usage(64, 12, 4, 330)), 3);
  assert.deepEqual([r.seats, r.over], [3, ['cpu']]);
  // At the limit admits: 90% of 10 cores = 900%; eight tickets at 800% (one core each) + one more core = 900%.
  assert.equal(seats(live(usage(64, 8, 10, 800)), 8).seats, 9);
  assert.equal(seats(live(usage(64, 8, 10, 801)), 8).seats, 8);
  // A seat given but whose step has not claimed the machine yet is not in the reading: it counts as one ticket.
  assert.equal(seats(live(usage(16, 6, 16, 100)), 2, 1).seats, 2, 'one running (6 GiB) + one pending + one more = 18 GiB > 14.4');
  assert.equal(seats(live(usage(16, 6, 16, 100)), 1).seats, 2);
  // Never below those held, whatever it reads.
  assert.equal(seats(live(usage(16, 15.9, 2, 200)), 3).seats, 3);
});

test('AC1: the limits are the machine entry\'s own max-memory-percent / max-cpu-percent, else harness.json\'s, else 90; checked in project.json', () => {
  assert.deepEqual(limitsOf({}, {}), { memory: 90, cpu: 90 });
  assert.deepEqual(limitsOf({}, { 'max-memory-percent': 80, 'max-cpu-percent': 70 }), { memory: 80, cpu: 70 });
  assert.deepEqual(limitsOf({ 'max-memory-percent': 50 }, { 'max-memory-percent': 80, 'max-cpu-percent': 70 }), { memory: 50, cpu: 70 });
  // 32 GiB at 50%: 16 GiB. Two using 12 GiB (6 each): no third.
  assert.equal(machineSeats({ entry: live(usage(32, 12, 16, 100)), limits: { memory: 50, cpu: 90 }, held: 2, now: NOW }).seats, 2);
  assert.equal(machineSeats({ entry: live(usage(32, 12, 16, 100)), limits: { memory: 90, cpu: 90 }, held: 2, now: NOW }).seats, 3);
  const ws = { id: 'w', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' };
  const json = d => ({ 'dev-environments': { mode: 'workstation', workstations: [ws], ...d } });
  assert.deepEqual(devEnvironments(json({ workstations: [{ ...ws, 'max-memory-percent': 75, 'max-cpu-percent': 60 }], 'ticket-isolation': 'one-at-a-time' })), { mode: 'workstation', workstations: [{ ...ws, 'max-memory-percent': 75, 'max-cpu-percent': 60 }], 'ticket-isolation': 'one-at-a-time' });
  assert.deepEqual(devEnvironmentsErrors(json({ workstations: [{ ...ws, 'max-memory-percent': 150 }], 'ticket-isolation': 'never' })), [
    'dev-environments.ticket-isolation "never" is not one of one-at-a-time, separate',
    'dev-environments.workstations[0].max-memory-percent is not a percentage above 0 and at most 100',
  ]);
  assert.deepEqual(devEnvironmentsErrors({ 'dev-environments': { mode: 'workstation', 'cloud-vms': [{ id: 'v', 'gcp-project': 'g', zone: 'z', 'max-cpu-percent': 0 }] } }), ['dev-environments.cloud-vms[0].max-cpu-percent is not a percentage above 0 and at most 100']);
});

test('AC1: no reading — not measured keeps the one-seat rule (its held ones, at least one); a failed reading takes no new ticket; a stale one is not used; CPU averaged over 5 minutes', () => {
  assert.equal(seats({ connected: false }, 0).seats, 1);
  assert.equal(seats({ connected: false }, 2).seats, 2);
  assert.equal(seats(live(undefined), 0).state, 'unmeasured');
  assert.equal(seats(live(usage(64, 1, 16, 0, NOW - READING_STALE - 1)), 1).state, 'unmeasured', 'stale');
  const failed = live({ ...usage(64, 1, 16, 0, NOW - 120e3), error: { at: iso(NOW - 60e3), message: 'cat: /proc/meminfo: denied' } });
  assert.deepEqual([seats(failed, 2).seats, seats(failed, 2).state], [2, 'unread']);
  assert.equal(seats(failed, 0).seats, 0, 'no new ticket while its reading fails');
  // CPU: the samples within the window averaged — one busy minute out of five does not shut it.
  const u = usage(64, 6, 4, 0);
  u.cpu.samples = [{ at: iso(NOW - 10 * 60e3), percent: 400 }, { at: iso(NOW - 4 * 60e3), percent: 50 }, { at: iso(NOW - 60e3), percent: 350 }, { at: iso(NOW), percent: 0 }];
  assert.equal(readingOf(live(u), NOW).cpu.used, 400 / 3);
  assert.equal(seats(live(u), 1).seats, 2);
});

const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
const project = (live = {}, remoteBudget = null, seatsHeld = []) => ({ id: 'p', json: {}, seatBudget: { seats: 0 }, devEnvironments: { mode: 'workstation', workstations: ['ws-1', 'ws-2'].map(ws) }, workstations: live, remoteBudget, seats: seatsHeld });
const r = key => ({ key, variation: 'A' });
const on = records => records.map(s => `${s.key} ${s.workstation}`);
const rec = (key, w = 'ws-1') => ({ key, variation: 'A', kind: 'workstation', workstation: w, since: '2026-11-22T00:00:00Z' });

test('AC6: two and three tickets on one machine — seats placed up to its seats, the first machine filled before the next', () => {
  assert.equal(remoteSeats(project(), 'ws-1'), 1, 'no reading phase yet: one each, as before');
  const cap = n => seatCapacity(project({}, { 'ws-1': { seats: n }, 'ws-2': { seats: 1 } }));
  assert.deepEqual([cap(3).remote, cap(3).workstations.map(w => w.seats)], [4, [3, 1]]);
  let out = placeSeats({ records: [], reserved: [r('T-1'), r('T-2')], capacity: cap(2) });
  assert.deepEqual(on(out.records), ['T-1 ws-1', 'T-2 ws-1']);
  out = placeSeats({ records: out.records, reserved: [r('T-1'), r('T-2'), r('T-3')], capacity: cap(3) });
  assert.deepEqual(on(out.records), ['T-1 ws-1', 'T-2 ws-1', 'T-3 ws-1']);
  out = placeSeats({ records: out.records, reserved: [r('T-1'), r('T-2'), r('T-3'), r('T-4'), r('T-5')], capacity: cap(3) });
  assert.deepEqual(on(out.records), ['T-1 ws-1', 'T-2 ws-1', 'T-3 ws-1', 'T-4 ws-2'], 'the limit reached: T-5 waits');
});

test('AC4, AC6: a machine that becomes unusable loses all its seats, every ticket on it taken out', () => {
  const expired = { connected: false, 'last-error': { at: '2026-11-22T00:00:00Z', kind: 'expired', message: 'login expired' } };
  const cap = seatCapacity(project({ 'ws-1': expired }, { 'ws-1': { seats: 3 }, 'ws-2': { seats: 1 } }));
  assert.equal(cap.remote, 1);
  const out = keepSeats([rec('T-1'), rec('T-2'), rec('T-3'), rec('T-4', 'ws-2')], cap);
  assert.deepEqual(out.lost.map(l => [l.key, l.workstation, /gcloud login/.test(l.why)]), [['T-1', 'ws-1', true], ['T-2', 'ws-1', true], ['T-3', 'ws-1', true]]);
  assert.deepEqual(on(out.kept), ['T-4 ws-2']);
});

test('AC5: the machine is needed while any ticket on it holds a seat or a step there; with none, it may disconnect and stop itself', () => {
  const plan = (over = {}) => ({ reserved: [], waiting: [], ready: [], memoryWaiting: [], ...over });
  const p = held => project({}, { 'ws-1': { seats: 3 }, 'ws-2': { seats: 1 } }, held);
  assert.match(seatNeeds({}, p([rec('T-1'), rec('T-2')]), plan({ reserved: [r('T-1'), r('T-2')] })).get('ws-1'), /its seats: T-1 A, T-2 A/);
  assert.match(seatNeeds({}, p([rec('T-2')]), plan({ reserved: [r('T-2')] })).get('ws-1'), /its seat: T-2 A/, 'T-1 left: T-2 still needs it');
  assert.equal(seatNeeds({}, p([]), plan()).size, 0, 'nobody on it: not needed');
  // A holder's step still to end (one of several) keeps it needed; none, not.
  const entry = { holder: { ticket: 'T-1', variation: 'A', folder: '/h/harness' }, holders: { 2: { ticket: 'T-3', variation: 'A', folder: '/h/harness/slots/2', slot: 2 } } };
  assert.deepEqual(holdersOf(entry).map(h => [h.ticket, h.slot]), [['T-1', 0], ['T-3', 2]]);
  assert.equal(holderOf(entry, 't-3', 'A').folder, '/h/harness/slots/2');
  const proj = { ...p([]), tickets: [] };
  assert.equal(workstationNeeds({ assignments: [] }, proj, { 'ws-1': entry }).get('ws-1'), "T-1 A, T-3 A's steps to end");
  assert.equal(workstationNeeds({ assignments: [] }, proj, { 'ws-1': {} }).size, 0);
});

test('AC3: the steps that run tests or CI checks run one at a time per machine — the default — unless the project opts into ticket-isolation separate', () => {
  const script = command => ({ action: { type: 'script', command }, 'run-location': 'vm' });
  assert.equal(runsTests(script('./agent.sh automated-tests:verify-success {project} {ticket} {variation}')), true);
  assert.equal(runsTests(script('./agent.sh ci-checks:verify {project} {ticket} {variation}')), true);
  assert.equal(runsTests(script('./agent.sh vm:refresh-repositories {project} {ticket} {variation}')), false);
  assert.equal(runsTests({ action: { type: 'prompt' }, 'exit-events': [{ condition: { all: [{ 'script-succeeds': './agent.sh automated-tests:verify-exist-and-runnable p t v' }] } }] }), true);
  assert.equal(runsTests({ action: { type: 'prompt' }, 'runs-tests': true }), true);
  assert.equal(runsTests({ action: { type: 'prompt' } }), false);
  // one-at-a-time (the default, unset too): a test step waits while another ticket's test step holds the same machine; separate never.
  const one = { id: 'p', devEnvironments: { mode: 'workstation', 'ticket-isolation': 'one-at-a-time' } };
  const lease = (key, over) => ({ project: 'p', key, variation: 'A', ws: 'ws-1', tests: true, state: 'held', ...over });
  const mine = lease('T-2', { state: 'wanted', ws: null });
  const other = lease('T-1');
  assert.equal(testsOn([other, mine], one, mine, 'ws-1'), other);
  assert.equal(testsOn([other, mine], one, mine, 'ws-2'), null, 'another machine');
  assert.equal(testsOn([lease('T-1', { tests: false }), mine], one, mine, 'ws-1'), null, 'its step runs no tests');
  assert.equal(testsOn([other, mine], one, { ...mine, tests: false }, 'ws-1'), null, 'this step runs no tests');
  assert.equal(testsOn([other, mine], { ...one, devEnvironments: { mode: 'workstation' } }, mine, 'ws-1'), other, 'unset: one at a time, the default');
  assert.equal(testsOn([other, mine], { ...one, devEnvironments: { mode: 'workstation', 'ticket-isolation': 'separate' } }, mine, 'ws-1'), null, 'separate: tests run side by side');
  assert.equal(isolationOf({ mode: 'workstation' }), 'one-at-a-time');
});

// The control fixture's p in workstation mode on one machine, ws-1, with ABC-3..ABC-6 A at build (a step on its machine),
// ranked in that order; `entry` its live data.
function onOneMachine() {
  const c = controlFixture();
  const at = (...rest) => join(c.dir, ...rest);
  const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
  edit(at('engines', 'example-development', 'workflow.yaml'), e => { e.steps.find(s => s.id === 'build')['run-location'] = 'vm'; });
  edit(at('projects', 'p', 'project.json'), p => { p['dev-environments'] = { mode: 'workstation', workstations: [{ ...ws('ws-1'), 'max-memory-percent': 75 }] }; });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
    sp.features = ['ABC-3', 'ABC-4', 'ABC-5', 'ABC-6'].map((key, i) => ({ key, 'manual-priority': i + 1, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'example-development' }, 'state-changes': [] }] }));
  });
  c.ctx.now = () => new Date(NOW);
  const entry = e => writeFileSync(at('projects', 'p', 'workstations.json'), JSON.stringify({ 'ws-1': e }));
  const seated = () => (existsSync(at('projects', 'p', 'seats.json')) ? JSON.parse(readFileSync(at('projects', 'p', 'seats.json'), 'utf8')).seats.map(s => s.key) : []);
  const tick = async () => { const state = c.ctx.load(); await budgetRemote(c.ctx, state); await assignSeats(c.ctx, state); };
  const budget = () => JSON.parse(readFileSync(at('projects', 'p', 'remote-seats.json'), 'utf8'))['ws-1'];
  return { c, at, entry, seated, tick, budget, log: () => c.lines.join('\n') };
}

test('AC1, AC4, AC6: control seats tickets on one machine one more at a time while it reads under its limits, stops at its limit, and loses them all when it can\'t be used', async () => {
  const s = onOneMachine();
  // Not measured yet (just connected): one seat.
  s.entry(live(undefined));
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3'], s.log());
  // Measured: 32 GiB (75%: 24 GiB), 16 cores. ABC-3's step there (claimed) uses 5 GiB: a second fits.
  const claimed = (...keys) => ({ holder: { ticket: keys[0], variation: 'A', folder: '/home/u/harness' }, holders: Object.fromEntries(keys.slice(1).map((k, i) => [String(i + 1), { ticket: k, variation: 'A', folder: `/home/u/harness/slots/${i + 1}`, slot: i + 1 }])) });
  s.entry({ ...live(usage(32, 5, 16, 100)), ...claimed('ABC-3') });
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3', 'ABC-4'], s.log());
  assert.match(s.log(), /^remote p ws-1: 2 seats — holds 1; memory 5\.0 of 24\.0 GiB, CPU 100% of 1440% \(its limits 75% and 90%\)/m);
  // ABC-4 seated but not running yet: it counts as one ticket; 5 + 5 + 5 = 15 <= 24 — a third.
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3', 'ABC-4', 'ABC-5'], s.log());
  assert.equal(s.budget().pending, 1, 'as the phase found it, before ABC-5 took its seat');
  // Three on it, 19 GiB used (6.3 each): one more passes 24 GiB — ABC-6 waits; the limit reached.
  s.entry({ ...live(usage(32, 19, 16, 300)), ...claimed('ABC-3', 'ABC-4', 'ABC-5') });
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3', 'ABC-4', 'ABC-5'], s.log());
  assert.deepEqual([s.budget().seats, s.budget().held, s.budget().state], [3, 3, 'measured']);
  assert.match(s.log(), /^remote p ws-1: 3 seats — holds 3;.*one more ticket would pass its memory limit$/m);
  // Its reading fails: no new ticket, those held keep running; logged once.
  s.entry({ ...live({ ...usage(32, 19, 16, 300, NOW - 60e3), error: { at: iso(NOW), message: 'its memory and CPU could not be read: timeout' } }), ...claimed('ABC-3', 'ABC-4', 'ABC-5') });
  await s.tick();
  await s.tick();
  assert.deepEqual(s.seated(), ['ABC-3', 'ABC-4', 'ABC-5']);
  assert.equal(s.c.lines.filter(l => /^remote p ws-1: can't read its memory or CPU/.test(l)).length, 1, s.log());
  // Its setup fails: it can't be used — every ticket on it loses its seat.
  s.entry({ connected: true, setup: { ok: false, error: 'no docker' } });
  await s.tick();
  assert.deepEqual(s.seated(), [], s.log());
  for (const key of ['ABC-3', 'ABC-4', 'ABC-5']) assert.ok(s.c.lines.some(l => l.startsWith(`seats ${key} A: taken out of its workstation seat on ws-1: ws-1 can't be used (its setup failed: no docker)`)), s.log());
});
