// ASS-525: control's seat queue (seat-queue.js) — the ticket variations waiting
// for a seat, in the order control gives them one, from the planner's own
// outputs (plan.js planFor): those in motion holding none (waiting, and those
// waiting for memory in their rank place), then the ready for build, then
// those not yet started at committed; written to seat-queue.json each tick
// only when it changes, removed when nobody waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { planDispatch } from '../../src/control/plan.js';
import { seatQueue, recordSeatQueue, loadSeatQueue, SEAT_QUEUE_FILE } from '../../src/control/seat-queue.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const planning = { 'is-planning-stage': true };

// committed → plan (a planning prompt) → prepare (a planning group whose run, done, is a finished plan) → build (a
// script) → review (a prompt) → done — tick-ready-for-build.test.js's engine.
const steps = [
  { id: 'committed', sequence: 2, ...planning, action: { type: 'none' }, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'plan' }] },
  { id: 'plan', sequence: 4, ...planning, action: { type: 'prompt', prompt: 'review-plan' } },
  { id: 'prepare', sequence: 6, ...planning, action: { type: 'state-engine', engine: 'test' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'build' }] },
  { id: 'build', sequence: 7, action: { type: 'script', command: 'true' }, 'exit-events': ok('review') },
  { id: 'review', sequence: 8, action: { type: 'prompt', prompt: 'test' } },
  { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } },
];

// line(tickets, own) — the control fixture on that engine, p's own limits `own` (harness.json's out of the way), its
// sprint `tickets`: [key, state, manual-priority] each, titled "Title <key>" — 'planned' for one at prepare whose run
// is done; `memory`, the keys control refused a seat for want of memory (memory-wait.json).
function line(tickets, { own = {}, memory = [], seats = Infinity } = {}) {
  const f = controlFixture();
  const dir = join(f.dir, 'projects', 'p'), sprint = join(dir, 'sprints', 'sprint-10', 'sprint.json');
  f.seats(seats);   // ASS-528: the pool's seats, the seat budget's
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = steps; });
  edit(join(dir, 'project.json'), p => Object.assign(p, own));
  edit(sprint, s => {
    s.features = tickets.map(([key, state, rank]) => ({ key, title: `Title ${key}`, 'manual-priority': rank, variations: [{ name: 'A', 'harness-status': state === 'planned' ? { ...hs('prepare'), 'sub-status': { state: 'done', 'state-engine': 'test' } } : hs(state), 'state-changes': [] }] }));
  });
  edit(join(f.dir, 'assignments.json'), a => {
    a['transient-state-engines'] = tickets.filter(([, state]) => state === 'planned').map(([key]) => ({ id: `run-${key}`, project: 'p', 'state-engine': 'test', state: 'done', 'is-done': true, 'structured-output': null, parent: { 'work-item': key, variation: 'A', 'state-engine': 'example-development', state: 'prepare' } }));
  });
  if (memory.length) writeFileSync(join(dir, 'memory-wait.json'), JSON.stringify({ waiting: memory.map(key => ({ key, variation: 'A' })) }));
  const file = join(dir, SEAT_QUEUE_FILE);
  const queue = () => { const state = f.ctx.load(); return seatQueue(state, state.projects.find(p => p.id === 'p')); };
  const short = list => list.map(q => `${q.key} ${q.waits}${q.full ? ' full' : ''}`);
  const move = (key, to) => edit(sprint, s => { s.features.find(t => t.key === key).variations[0]['harness-status'] = hs(to); });
  return { ...f, dir, file, queue, short, move, record: () => recordSeatQueue(f.ctx, f.ctx.load()), written: () => (existsSync(file) ? short(loadSeatQueue(dir)) : null) };
}

// ASS-528: two seats in one pool (T-1 and T-2, the highest-ranked, hold them): the rest wait, of every kind.
const MIXED = [['T-1', 'review', 1], ['T-2', 'review', 2], ['T-3', 'plan', 3], ['T-4', 'plan', 4], ['T-5', 'planned', 5], ['T-6', 'committed', 6], ['T-7', 'review', 7]];
const SEATS = 2, ONE = 1;

test('AC2, AC3, AC6: waiting, memory, ready and not-yet-started mixed — in motion first in rank order (memory in its rank place), then the ready for build and those at committed (ASS-528: one list, in rank order); each with what it waits for', () => {
  const f = line(MIXED, { seats: SEATS, memory: ['T-7'] });
  const q = f.queue();
  assert.deepEqual(f.short(q), ['T-3 planning', 'T-4 planning', 'T-7 memory', 'T-5 build', 'T-6 planning']);
  assert.deepEqual(q[0], { key: 'T-3', variation: 'A', title: 'Title T-3', waits: 'planning' });
  // Not T-1 or T-2: they hold the seats.
  assert.ok(!q.some(e => e.key === 'T-1' || e.key === 'T-2'));
  // ASS-528: a ready plan and a ticket at committed take the same seats, so they queue by rank, whichever comes first.
  const g = line([['T-1', 'review', 1], ['T-6', 'committed', 2], ['T-5', 'planned', 3]], { seats: ONE });
  assert.deepEqual(g.short(g.queue()), ['T-6 planning', 'T-5 build']);
});

test('AC2: the order is the planner\'s — a manual priority reorders the line, a seat-holder never queues', () => {
  const f = line([['T-1', 'review', 3], ['T-2', 'review', 1], ['T-3', 'review', 2]], { seats: ONE });
  assert.deepEqual(f.short(f.queue()), ['T-3 build', 'T-1 build']);   // T-2, top-ranked, holds the seat
});

test('AC6: more than 5 waiting — every one written, in order (the box shows the first 5)', () => {
  const f = line([...MIXED, ['T-8', 'committed', 8], ['T-9', 'committed', 9]], { seats: SEATS, memory: ['T-7'] });
  f.record();
  assert.deepEqual(f.written(), ['T-3 planning', 'T-4 planning', 'T-7 memory', 'T-5 build', 'T-6 planning', 'T-8 planning', 'T-9 planning']);
});

test('AC3: while max-tickets-ready-for-build is reached, those at committed are marked full', () => {
  const f = line([['T-1', 'review', 1], ['T-5', 'planned', 2], ['T-6', 'committed', 3]], { seats: ONE, own: { 'max-tickets-ready-for-build': 1 } });
  assert.deepEqual(f.short(f.queue()), ['T-5 build', 'T-6 planning full']);
});

test('AC6: none waiting — an empty queue, and no file (removed when the last one is seated)', () => {
  const f = line([['T-1', 'review', 1], ['T-3', 'plan', 2]], { seats: SEATS });
  assert.deepEqual(f.queue(), []);
  writeFileSync(f.file, JSON.stringify({ queue: [{ key: 'OLD', variation: 'A', waits: 'build' }] }));
  f.record();
  assert.equal(existsSync(f.file), false);
  assert.deepEqual(loadSeatQueue(f.dir), []);
});

test('AC4: written only when it changes — a second tick with the same line leaves the file be; a change rewrites it', () => {
  const f = line([['T-1', 'review', 1], ['T-2', 'review', 2], ['T-3', 'review', 3]], { seats: ONE });
  f.record();
  assert.deepEqual(f.written(), ['T-2 build', 'T-3 build']);
  writeFileSync(f.file, JSON.stringify({ queue: [{ key: 'MARK', variation: 'A', waits: 'build' }] }));
  f.record();
  assert.deepEqual(f.written(), ['MARK build'], 'unchanged: not written again');
  f.move('T-1', 'done');
  f.record();
  assert.deepEqual(f.written(), ['T-3 build']);
});

test('AC4: through a whole tick — a ticket that gets a seat leaves the queue and the next moves up within that tick', async () => {
  const f = line([['T-1', 'review', 1], ['T-2', 'review', 2], ['T-3', 'review', 3]], { seats: ONE });
  await tick(f.ctx);
  assert.deepEqual(f.written(), ['T-2 build', 'T-3 build'], f.lines.join('\n'));
  f.move('T-1', 'done');
  await tick(f.ctx);
  assert.deepEqual(f.written(), ['T-3 build'], f.lines.join('\n'));
});

test('planDispatch\'s entering: the variations at the queue (committed), in rank order, not those planning or paused', () => {
  const engine = { steps };
  const at = state => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' } });
  const ranked = [{ key: 'T-1', variations: [at('committed')] }, { key: 'T-2', variations: [at('plan')] }, { key: 'T-3', variations: [{ ...at('committed'), 'is-paused': true }] }, { key: 'T-4', variations: [at('committed')] }];
  assert.deepEqual(planDispatch({ ranked, engine }).entering, [{ key: 'T-1', variation: 'A' }, { key: 'T-4', variation: 'A' }]);
});
