// ASS-469: a project's VM seats and workstation seats (one per workstation,
// AC9). seat-kinds.js: the capacity (VM seats plus one per usable
// workstation), a workstation's seat lost while it can't be used, and
// placeSeats — a free workstation seat taken first, a VM-seat holder moved
// into a freed one between its steps (never mid-step), the VM seat it leaves
// going to the next ticket; plan.js keeping the seated ahead of the rest;
// seats.js' tick phase recording seats.json, taking holders out of a lost
// workstation's seat (logged, on Health) and reseating them, and the seat
// coming back; seatNeeds, the keep-awake rule (AC6); workstation:claim
// --workstation claiming only the seat's workstation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatCapacity, lostWhy, keepSeats, placeSeats, seatedIn } from '../../src/control/seat-kinds.js';
import { planDispatch } from '../../src/control/plan.js';
import { assignSeats, seatNeeds, SEAT_HEALTH } from '../../src/control/seats.js';
import { workstationNeeds } from '../../src/control/workstations.js';
import { controlFixture } from './control-fixture.js';
import { wsFixture, closeAll, ID } from '../agent-cli/workstation-fixture.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
const at = '2026-11-16T00:00:00Z';
const usable = { connected: true, 'connected-at': at, setup: { ok: true, 'checked-at': at } };
const expired = { connected: false, 'last-error': { at, kind: 'expired', message: 'login expired' } };
const project = (mode, { vm = 2, list = ['ws-1', 'ws-2'], live = {}, seats = [] } = {}) => ({ id: 'p', json: {}, seatBudget: vm == null ? null : { seats: vm }, devEnvironments: { mode, workstations: list.map(ws) }, workstations: live, seats });
const r = (key, variation = 'A') => ({ key, variation });
const kinds = records => records.map(s => `${s.key} ${s.kind === 'vm' ? 'vm' : s.workstation}`);

test('AC1, AC9: the capacity is the VM seats plus one seat per usable workstation; vm mode has no workstation seats, workstation mode no VM seats', () => {
  assert.deepEqual(seatCapacity(project('vm+workstation')).total, 4);
  assert.deepEqual(seatCapacity(project('vm')).total, 2);
  assert.deepEqual(seatCapacity(project('workstation')).total, 2);
  assert.deepEqual(seatCapacity(project('workstation', { live: { 'ws-1': expired } })).workstations.map(w => [w.id, w.seats, Boolean(w.lost)]), [['ws-1', 1, true], ['ws-2', 1, false]]);
  assert.equal(seatCapacity(project('vm+workstation', { vm: null })).total, Infinity);
  assert.equal(seatCapacity(project('vm+workstation', { live: { 'ws-2': expired } })).total, 3);
  assert.equal(seatCapacity(project('vm+workstation', { live: { 'ws-2': expired } })).remote, 1);
  // ASS-528: the VM seats are the seat budget's, project.json's max-tickets-in-progress not read.
  assert.equal(seatCapacity({ json: { 'max-tickets-in-progress': 4 }, devEnvironments: { mode: 'vm', workstations: [ws('w')] } }).vm, Infinity);
  assert.equal(seatCapacity({ json: {}, seatBudget: { seats: 4 }, devEnvironments: { mode: 'vm', workstations: [ws('w')] } }).total, 4);
});

test('AC5: a workstation\'s seat is lost while its login lapsed, its setup failed or its last connect failed; one merely stopped keeps it', () => {
  assert.match(lostWhy(expired), /gcloud login/);
  assert.match(lostWhy({ connected: true, setup: { ok: false, error: 'no docker' } }), /setup failed: no docker/);
  assert.match(lostWhy({ connected: false, 'last-error': { kind: 'offline', message: 'unreachable' } }), /could not be reached or started: unreachable/);
  assert.equal(lostWhy({ connected: false, state: 'stopped' }), null);
  assert.equal(lostWhy(undefined), null);
  assert.equal(lostWhy(usable), null);
});

test('AC2: entering progress takes a free workstation seat first, else a free VM seat, else waits; planning has no seat kinds', () => {
  const capacity = seatCapacity(project('vm+workstation', { vm: 1, list: ['ws-1'] }));
  const out = placeSeats({ records: [], reserved: [r('T-1'), r('T-2'), r('T-3')], capacity });
  assert.deepEqual(kinds(out.records), ['T-1 ws-1', 'T-2 vm']);
  assert.deepEqual(kinds(out.seated), ['T-1 ws-1', 'T-2 vm']);
  assert.deepEqual(kinds(placeSeats({ records: [], reserved: [r('T-1'), r('T-2')], capacity: seatCapacity(project('workstation', { list: ['ws-1'] })) }).records), ['T-1 ws-1']);
  assert.deepEqual(kinds(placeSeats({ records: [], reserved: [r('T-1')], capacity: seatCapacity(project('vm', { vm: 1 })) }).records), ['T-1 vm']);
});

test('AC3: a freed workstation seat goes to the highest-ranked VM-seat holder between steps — one mid-step is passed over and moves once its step ends — and the VM seat it leaves goes to the next ticket', () => {
  const capacity = seatCapacity(project('vm+workstation', { vm: 2, list: ['ws-1'] }));
  const records = [{ key: 'T-1', variation: 'A', kind: 'vm', since: at }, { key: 'T-2', variation: 'A', kind: 'vm', since: at }];
  // T-0 left the workstation seat (Done): T-1 is mid-step, so T-2 moves; T-3 takes the VM seat T-2 left.
  let out = placeSeats({ records, reserved: [r('T-1'), r('T-2'), r('T-3')], capacity, midStep: key => key === 'T-1' });
  assert.deepEqual(out.moved, [{ key: 'T-2', variation: 'A', workstation: 'ws-1' }]);
  assert.deepEqual(kinds(out.records), ['T-1 vm', 'T-2 ws-1', 'T-3 vm']);
  assert.deepEqual(kinds(out.seated), ['T-3 vm']);
  // Both mid-step: neither moves this tick; a newcomer takes the free workstation seat (workstation first).
  out = placeSeats({ records, reserved: [r('T-1'), r('T-2'), r('T-3')], capacity, midStep: () => true });
  assert.deepEqual(out.moved, []);
  assert.deepEqual(kinds(out.records), ['T-1 vm', 'T-2 vm', 'T-3 ws-1']);
  // No newcomer, T-1 mid-step: it stays; at a later tick, its step ended, it moves.
  out = placeSeats({ records: records.slice(0, 1), reserved: [r('T-1')], capacity, midStep: () => true });
  assert.deepEqual(kinds(out.records), ['T-1 vm']);
  out = placeSeats({ records: out.records, reserved: [r('T-1')], capacity, midStep: () => false });
  assert.deepEqual(kinds(out.records), ['T-1 ws-1']);
  // One no longer in progress leaves its seat.
  out = placeSeats({ records: [{ key: 'T-9', variation: 'A', kind: 'workstation', workstation: 'ws-1' }], reserved: [], capacity });
  assert.deepEqual([out.records, kinds(out.left)], [[], ['T-9 ws-1']]);
});

test('AC5, AC9: a lost workstation\'s holder is taken out of its seat; never two on one workstation; a VM seat over a lowered count is given up, the latest first', () => {
  const capacity = seatCapacity(project('vm+workstation', { vm: 1, list: ['ws-1', 'ws-2'], live: { 'ws-2': expired } }));
  const out = keepSeats([
    { key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-2' },
    { key: 'T-2', variation: 'A', kind: 'workstation', workstation: 'ws-1', since: '2026-11-16T01:00:00Z' },
    { key: 'T-3', variation: 'A', kind: 'workstation', workstation: 'ws-1', since: '2026-11-16T02:00:00Z' },
    { key: 'T-4', variation: 'A', kind: 'vm', since: '2026-11-16T01:00:00Z' },
    { key: 'T-5', variation: 'A', kind: 'vm', since: '2026-11-16T03:00:00Z' },
    { key: 'T-6', variation: 'A', kind: 'workstation', workstation: 'gone' },
  ], capacity);
  assert.deepEqual(out.lost.map(l => [l.key, l.workstation, /gcloud login|no longer/.test(l.why)]), [['T-1', 'ws-2', true], ['T-6', 'gone', true]]);
  assert.deepEqual(kinds(out.unseated), ['T-5 vm', 'T-3 ws-1']);
  assert.deepEqual(kinds(out.kept), ['T-2 ws-1', 'T-4 vm']);
});

test('the planner keeps a recorded seat ahead of the rest: when the seats shrink (a workstation lost), those taken out wait, not the lowest-ranked', () => {
  const engine = { steps: [{ id: 'build', sequence: 1, action: { type: 'prompt', prompt: 'b' } }] };
  const ranked = ['T-1', 'T-2', 'T-3'].map(key => ({ key, variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }] }));
  const plan = seated => planDispatch({ ranked, engine, harness: {}, seats: { mac: 2, remote: 0 }, seated }).reserved.map(s => s.key);
  assert.deepEqual(plan(), ['T-1', 'T-2']);   // as before: rank order
  const p = { seats: [{ key: 'T-2', variation: 'A', kind: 'vm' }, { key: 'T-3', variation: 'A', kind: 'vm' }] };   // T-1 was taken out of a lost seat
  assert.deepEqual(plan(seatedIn(p)), ['T-2', 'T-3']);
  assert.deepEqual(planDispatch({ ranked, engine, harness: {}, seats: { mac: 2, remote: 0 }, seated: seatedIn(p) }).waiting, [{ key: 'T-1', variation: 'A' }]);
});

test('AC6: a workstation is needed while its seat is held, while it is free and a ticket waits for a seat or sits in a VM seat to move, and while lost with tickets in progress; never with nobody seated and nobody waiting', () => {
  const plan = (over = {}) => ({ reserved: [], waiting: [], ready: [], memoryWaiting: [], ...over });
  const p = (seats, live = {}) => project('vm+workstation', { vm: 2, list: ['ws-1'], live, seats });
  assert.match(seatNeeds({}, p([{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1' }]), plan({ reserved: [r('T-1')] })).get('ws-1'), /its seat: T-1 A/);
  assert.match(seatNeeds({}, p([]), plan({ waiting: [r('T-2')] })).get('ws-1'), /a free seat: T-2 A waiting/);
  assert.match(seatNeeds({}, p([], {}), plan({ ready: [r('T-2')] })).get('ws-1'), /T-2 A waiting/);
  assert.match(seatNeeds({}, p([{ key: 'T-3', variation: 'A', kind: 'vm' }]), plan({ reserved: [r('T-3')] })).get('ws-1'), /T-3 A to move into it/);
  assert.match(seatNeeds({}, p([{ key: 'T-3', variation: 'A', kind: 'vm' }], { 'ws-1': expired }), plan({ reserved: [r('T-3')] })).get('ws-1'), /its seats lost/);
  assert.equal(seatNeeds({}, p([]), plan()).size, 0, 'nobody seated, nobody waiting: it may stop itself');
  assert.equal(seatNeeds({}, p([], { 'ws-1': expired }), plan()).size, 0);
  // workstationNeeds takes them in, a step's own want first.
  const proj = { ...p([]), tickets: [] };
  assert.equal(workstationNeeds({ assignments: [] }, proj, {}, new Map(), new Map([['ws-1', 'its seat: T-1 A']])).get('ws-1'), 'its seat: T-1 A');
  assert.equal(workstationNeeds({ assignments: [] }, proj, {}, new Map([['ws-1', 'T-1 A wants it for a step (its seat)']]), new Map([['ws-1', 'its seat: T-1 A']])).get('ws-1'), 'T-1 A wants it for a step (its seat)');
});

// vmSeats(at, n) — ASS-528: the project's VM seats, as control's seat budget would record them (seat-budget.json).
const vmSeats = (at, n) => writeFileSync(at('projects', 'p', 'seat-budget.json'), JSON.stringify({ seats: n }));

// The control fixture's p in vm+workstation mode on ada-dev, one VM seat, ABC-3 A, ABC-4 A and ABC-5 A at build (in
// progress), ranked in that order; harness.json's cap out of the way.
function seated() {
  const c = controlFixture();
  const at2 = (...rest) => join(c.dir, ...rest);
  // ASS-527: a seat only at a step that uses its machine — the fixture's build, a host script, made one run in the VM.
  edit(at2('engines', 'example-development', 'workflow.yaml'), e => { e.steps.find(s => s.id === 'build')['run-location'] = 'vm'; });
  edit(at2('projects', 'p', 'project.json'), p => { p['dev-environments'] = { mode: 'vm+workstation', workstations: [ws(ID)] }; });
  vmSeats(at2, 1);   // ASS-528: one VM seat, the seat budget's (this phase runs alone, with no budget phase before it)
  edit(at2('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
    sp.features = ['ABC-3', 'ABC-4', 'ABC-5'].map((key, i) => ({ key, 'manual-priority': i + 1, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'example-development' }, 'state-changes': [] }] }));
  });
  const seats = () => (existsSync(at2('projects', 'p', 'seats.json')) ? kinds(JSON.parse(readFileSync(at2('projects', 'p', 'seats.json'), 'utf8')).seats) : []);
  const live = entry => writeFileSync(at2('projects', 'p', 'workstations.json'), JSON.stringify({ [ID]: entry }));
  const variation = key => c.sprint().features.find(t => t.key === key).variations[0];
  return { c, at: at2, seats, live, variation, phase: () => assignSeats(c.ctx, c.ctx.load()), log: () => c.lines.join('\n') };
}

test('AC2, AC3, AC5: the tick phase records the seats; a lost workstation\'s holder is taken out (logged, on Health) and takes the next free seat; the seat coming back is filled by a move, the VM seat freed going to the next', async () => {
  const s = seated();
  await s.phase();
  assert.deepEqual(s.seats(), ['ABC-3 ada-dev', 'ABC-4 vm'], s.log());
  assert.ok(s.c.lines.includes('seats ABC-3 A: takes a workstation seat on ada-dev'), s.log());
  assert.ok(s.c.lines.includes('seats ABC-4 A: takes a VM seat'), s.log());
  await s.phase();
  assert.deepEqual(s.seats(), ['ABC-3 ada-dev', 'ABC-4 vm'], 'kept as it is');

  // ada-dev's login lapses: ABC-3 A is taken out; ABC-4 A keeps the one VM seat; ABC-3 A waits, its Health saying why.
  s.live(expired);
  await s.phase();
  assert.deepEqual(s.seats(), ['ABC-4 vm'], s.log());
  assert.ok(s.c.lines.some(l => /^seats ABC-3 A: taken out of its workstation seat on ada-dev: ada-dev can't be used \(its gcloud login needs reauthentication\); it takes the next free seat of either kind$/.test(l)), s.log());
  assert.ok(s.variation('ABC-3')['ai-feedback-long'].startsWith(`${SEAT_HEALTH} ada-dev can't be used (its gcloud login needs reauthentication)`), s.variation('ABC-3')['ai-feedback-long']);

  // ABC-4 A is done: its VM seat goes to ABC-3 A, ahead of ABC-5 A; its Health cleared.
  edit(s.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { sp.features[1].variations[0]['harness-status'].state = 'done'; });
  await s.phase();
  assert.deepEqual(s.seats(), ['ABC-3 vm'], s.log());
  assert.equal(s.variation('ABC-3')['ai-feedback-long'] ?? null, null);

  // The login renewed: the workstation seat is back; ABC-3 A, between steps, moves into it, and ABC-5 A takes the VM seat it left.
  s.live({ connected: false, 'last-error': null });
  await s.phase();
  assert.deepEqual(s.seats(), ['ABC-3 ada-dev', 'ABC-5 vm'], s.log());
  assert.ok(s.c.lines.includes('seats ABC-3 A: moves from a VM seat to a workstation seat on ada-dev, between its steps; its VM seat is free for the next ticket'), s.log());
  const moved = s.c.lines.indexOf('seats ABC-3 A: moves from a VM seat to a workstation seat on ada-dev, between its steps; its VM seat is free for the next ticket');
  assert.ok(s.c.lines.indexOf('seats ABC-5 A: takes a VM seat') > moved, s.log());
});

test('AC3: a VM-seat holder whose step runs on its machine does not move until that step has ended', async () => {
  const s = seated();
  writeFileSync(s.at('projects', 'p', 'seats.json'), JSON.stringify({ seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', since: at }] }));
  vmSeats(s.at, 2);
  edit(s.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { sp.features = sp.features.slice(0, 1); });
  // Its step's lease holds its VM (workstation-steps.js): mid-step.
  s.c.ctx.memory.workstationSteps = new Map([['p/ABC-3/A', { project: 'p', key: 'ABC-3', variation: 'A', state: 'vm', scripts: new Set(), dispatching: 0 }]]);
  await s.phase();
  assert.deepEqual(s.seats(), ['ABC-3 vm'], s.log());
  s.c.ctx.memory.workstationSteps.get('p/ABC-3/A').state = 'wanted';   // its step ended; the next waits for a machine
  await s.phase();
  assert.deepEqual(s.seats(), ['ABC-3 ada-dev'], s.log());
});

// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard; a fixed one a loaded Mac outlasts.
test('AC4: workstation:claim --workstation claims that workstation alone, or none (exit 4)', async t => {
  t.after(closeAll);
  const s = wsFixture({ ids: [ID, 'ws-2'] });
  for (const id of [ID, 'ws-2']) {
    assert.equal((await s.result('workstation:connect', 'p', id)).code, 0);
    assert.equal((await s.result('workstation:setup', 'p', id)).code, 0);
  }
  const claimed = await s.result('workstation:claim', 'p', 'ABC-3', 'A', '--workstation', 'ws-2');
  assert.equal(claimed.code, 0, claimed.err);
  assert.equal(JSON.parse(claimed.out).name, 'ws-2');
  assert.equal(s.entry(ID).holder, undefined);
  const busy = await s.result('workstation:claim', 'p', 'ABC-3', 'A', '--workstation', 'ws-2');
  assert.equal(busy.code, 4);
  assert.match(busy.err, /ws-2: ABC-3 A holds a step there already/);   // ASS-529: another ticket would take a slot beside it
  assert.equal(s.entry(ID).holder, undefined, 'never another one');
  const unknown = await s.result('workstation:claim', 'p', 'ABC-3', 'A', '--workstation', 'nope');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no workstation 'nope'/);
});
