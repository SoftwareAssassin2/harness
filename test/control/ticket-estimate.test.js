// ASS-570: a Mac project on Substrate sandboxes sizes its allotment by one working ticket's expected use — only working
// sandboxes sampled (AC1), floored, kept across restarts and moved gradually (AC2), and where it came from said (AC3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { budgetSeats, grantSeats } from '../../src/control/seat-budget.js';
import { sandboxNeed, DEFAULTS } from '../../src/control/substrate-config.js';
import { estimateFor, target, step, percentile, floorOf, ESTIMATE_FILE, STEP, SAMPLES_KEPT } from '../../src/control/ticket-estimate.js';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';

const GIB = 2 ** 30;
const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };

// The live case of 2026-11-23 22:52–22:57, made exact: a 48 GiB, 14-core Mac, 90/90 budget, the project's 25% share
// (10.8 GiB, 315% CPU), its Mac cluster's fixed part 0.5 GiB and 0% CPU, no warm worker's request.
const ENTRY = { machine: 'mac', 'memory-gib': 0.5, 'cpu-percent': 0 };
function macFixture() {
  const f = controlFixture();
  const dir = join(f.dir, 'projects', 'p');
  edit(join(dir, 'project.json'), p => {
    p.share = 25;
    p['dev-environments'] = { ...(p['dev-environments'] ?? {}), 'run-targets': ['local-substrate', 'local-worktree'], substrate: { clusters: [ENTRY] } };
    delete p['dev-environments'].mode;
  });
  const total = 48 * GIB;
  f.ctx.hostMemory = async () => ({ freePercent: 100, pressure: 'normal', totalBytes: total, freeBytes: total, reclaimableBytes: total, swapouts: 0, swapUsedBytes: 0, vms: new Map(), measure: 'footprint' });
  f.ctx.hostCpu = async () => ({ ncpu: 14, totalPercent: 0, vms: new Map() });
  delete f.ctx.memory.hostMemory;
  delete f.ctx.memory.hostCpu;
  let now = Date.parse('2026-11-23T22:52:00Z');
  f.ctx.now = () => new Date(now);
  f.later = ms => { now += ms; };
  f.at = () => now;
  writeFileSync(join(dir, 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [],
    features: [{ key: 'ASS-562', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': hs('plan'), 'state-changes': [] }] }] }, null, 4));
  f.dir_p = dir;
  return f;
}
// sandbox(f, use, at) — the Mac cluster's last check (substrate.json), its one sandbox ass-562-a as `use` says.
function sandbox(f, use, at = new Date(f.at()).toISOString()) {
  writeFileSync(join(f.dir_p, 'substrate.json'), JSON.stringify({ mac: { 'checked-at': at, node: { running: true },
    usage: { workers: { replicas: 1, 'memory-request-bytes': 0 }, 'sandbox-use': { 'ass-562-a': use } } } }));
}
const IDLE = { state: 'running', 'memory-bytes': Math.round(0.34 * GIB), 'cpu-percent': 3 };   // the idle sandbox seen live
const HIBERNATED = { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0, 'snapshot-bytes': 4255744 };
const budgetFile = f => JSON.parse(readFileSync(join(f.dir_p, 'seat-budget.json'), 'utf8'));
// tick(f, busy) — the budget phase, the variation working (an agent of it running) or not.
async function tick(f, busy = false) {
  const s = f.ctx.load();
  await budgetSeats(f.ctx, busy ? { ...s, assignments: [...(s.assignments ?? []), { project: 'p', 'work-item': 'ASS-562', variation: 'A', state: 'plan' }] } : s);
  return budgetFile(f);
}

test('ASS-570 AC2: on main the idle sandbox\'s reading swung the allotment 30 ↔ 3 seats (reproduced); now it stays put with no change in load', async () => {
  // main's estimate (substrate-config.js sandboxNeed: the average of the `running` sandboxes, idle or not), on the two readings.
  const entry = { ...DEFAULTS, ...ENTRY, kind: 'kind' };
  const live = use => ({ usage: { 'sandbox-use': { 'ass-562-a': use } } });
  const allot = per => grantSeats({ budget: { memory: 0.9 * 48 * GIB, cpu: 0.9 * 1400 }, mac: { memory: 0, cpu: 0 },
    projects: [{ id: 'p', share: 25, canUse: true, want: 0, held: 0, starting: 0, per, reserve: { memory: 0.5 * GIB, cpu: 0 } }] }).get('p').allotSeats;
  assert.deepEqual([allot(sandboxNeed(entry, live(IDLE))), allot(sandboxNeed(entry, live(HIBERNATED)))], [30, 3], 'the swing, as on main');
  // Now: the same two readings, tick after tick — the defaults both times, the same allotment.
  const f = macFixture();
  const seats = [];
  for (const use of [IDLE, IDLE, HIBERNATED, IDLE, HIBERNATED]) { sandbox(f, use); f.later(60e3); seats.push((await tick(f)).allotment.seats); }
  assert.deepEqual(seats, [3, 3, 3, 3, 3], f.lines.join('\n'));
  assert.equal(f.lines.filter(l => l.startsWith('budget p:')).length, 1, 'logged once: nothing changed');
});

test('ASS-570 AC1: idle, starting (resuming), hibernated and hibernating sandboxes never lower the estimate; a working one is a sample', async () => {
  const f = macFixture();
  const small = { 'memory-bytes': Math.round(0.3 * GIB), 'cpu-percent': 2 };
  // Not working (no agent, no script): a running reading is not a sample.
  sandbox(f, { state: 'running', ...small }); f.later(60e3);
  let b = await tick(f);
  assert.deepEqual([b['per-ticket'].source, b['per-ticket'].samples, b['per-ticket']['memory-bytes']], ['defaults', 0, 1.5 * GIB]);
  // Working, but the sandbox resuming, hibernating or hibernated: never a sample.
  for (const state of ['resuming', 'suspending', 'suspended']) {
    await tick(f, true); f.later(200e3);
    sandbox(f, { state, ...small }); f.later(5e3);
    b = await tick(f, true);
    assert.equal(b['per-ticket'].samples, 0, state);
  }
  // Working through a whole check interval and running: a sample — but under the floor, so still the defaults.
  await tick(f, true); f.later(200e3);
  sandbox(f, { state: 'running', ...small }); f.later(5e3);
  b = await tick(f, true);
  assert.deepEqual([b['per-ticket'].samples, b['per-ticket'].source, b['per-ticket']['memory-bytes'], b['per-ticket']['cpu-percent']], [1, 'defaults', 1.5 * GIB, 100]);
  // The same reading seen again on later ticks is not taken twice.
  f.later(5e3); b = await tick(f, true);
  assert.equal(b['per-ticket'].samples, 1);
  // A turn that started after the check interval began: its reading is not a sample (its CPU average is part idle).
  await tick(f, false); f.later(10e3);
  await tick(f, true); f.later(30e3);
  sandbox(f, { state: 'running', 'memory-bytes': 3 * GIB, 'cpu-percent': 300 }); f.later(5e3);
  assert.equal((await tick(f, true))['per-ticket'].samples, 1);
});

test('ASS-570 AC1: a reading taken during a stretch of work still counts when control sees it after the turn ended', async () => {
  const f = macFixture();
  await tick(f, true); f.later(200e3);
  await tick(f, true);
  const at = new Date(f.at()).toISOString();
  f.later(5e3); await tick(f, false);   // the turn ended
  sandbox(f, { state: 'running', 'memory-bytes': 4 * GIB, 'cpu-percent': 250 }, at); f.later(5e3);
  const b = await tick(f, false);
  assert.deepEqual([b['per-ticket'].samples, b['per-ticket'].source], [1, 'working-samples']);
});

test('ASS-570 AC2, AC3: working samples above the floor raise the estimate gradually (at most ×1.1 a tick) to their 80th percentile; kept across a restart; the log and seat-budget.json say where it came from', async () => {
  const f = macFixture();
  let b = await tick(f);
  assert.match(f.lines.findLast(l => l.startsWith('budget p:')), /per ticket 1\.5 GiB, 100% CPU \(defaults\)$/);
  assert.deepEqual(b['per-ticket'].floor, { 'memory-bytes': 1.5 * GIB, 'cpu-percent': 100 });
  // Five working samples of 3 GiB / 200%.
  for (let i = 0; i < 5; i++) {
    await tick(f, true); f.later(200e3); await tick(f, true);
    sandbox(f, { state: 'running', 'memory-bytes': 3 * GIB, 'cpu-percent': 200 }); f.later(5e3);
  }
  const before = (await tick(f, true))['per-ticket'];
  assert.equal(before.source, 'working-samples');
  assert.deepEqual(before.target, { 'memory-bytes': 3 * GIB, 'cpu-percent': 200 });
  // It has been moving all along, never more than STEP a tick: let it settle and check each step.
  let last = before['memory-bytes'];
  for (let i = 0; i < 20; i++) {
    f.later(5e3);
    const p = (await tick(f, true))['per-ticket'];
    assert.ok(p['memory-bytes'] <= last * STEP + 1 && p['memory-bytes'] >= last / STEP - 1, `${last} → ${p['memory-bytes']}`);
    last = p['memory-bytes'];
  }
  b = budgetFile(f);
  assert.deepEqual([b['per-ticket']['memory-bytes'], b['per-ticket']['cpu-percent']], [3 * GIB, 200]);
  assert.equal(b.allotment.seats, Math.floor(315 / 200));
  assert.match(f.lines.findLast(l => l.startsWith('budget p:')), /per ticket 3\.0 GiB, 200% CPU \(from 5 working samples\)$/);
  // Kept in the project's data, and read back by a new control (a restart: fresh memory).
  const kept = JSON.parse(readFileSync(join(f.dir_p, ESTIMATE_FILE), 'utf8'));
  assert.equal(kept.samples.length, 5);
  assert.deepEqual(kept.estimate, { 'memory-bytes': 3 * GIB, 'cpu-percent': 200 });
  delete f.ctx.memory.ticketEstimate;   // a new control: nothing of the estimate in memory
  delete f.ctx.memory.seatBudget;
  b = await tick(f);
  assert.deepEqual([b['per-ticket']['memory-bytes'], b['per-ticket'].source, b['per-ticket'].samples], [3 * GIB, 'working-samples', 5]);
});

test('ASS-570 AC2: the pure parts — percentile, target never below the floor, a step at most STEP, the floor applied at once, samples capped', () => {
  assert.equal(percentile([]), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 8);
  const floor = floorOf({ 'sandbox-memory-gib': 1.5, 'sandbox-cpu-percent': 100 });
  assert.deepEqual(target([], floor), { memory: 1.5 * GIB, cpu: 100, source: 'defaults', samples: 0 });
  assert.equal(target([{ 'memory-bytes': 0.3 * GIB, 'cpu-percent': 3 }], floor).source, 'defaults');
  assert.deepEqual(target([{ 'memory-bytes': 9 * GIB, 'cpu-percent': 50 }], floor), { memory: 9 * GIB, cpu: 100, source: 'working-samples', samples: 1 });
  assert.deepEqual(step(null, { memory: 9 * GIB, cpu: 100 }, floor), { memory: 9 * GIB, cpu: 100 });
  const up = step({ memory: 1.5 * GIB, cpu: 100 }, { memory: 9 * GIB, cpu: 100 }, floor);
  assert.ok(Math.abs(up.memory - 1.5 * GIB * STEP) < 1);
  const down = step({ memory: 9 * GIB, cpu: 300 }, { memory: 1.5 * GIB, cpu: 100 }, floor);
  assert.ok(Math.abs(down.memory - 9 * GIB / STEP) < 1 && Math.abs(down.cpu - 300 / STEP) < 1e-9);
  // A floor raised by hand (sandbox-memory-gib 9) applies at once, not gradually.
  assert.equal(step({ memory: 1.5 * GIB, cpu: 100 }, { memory: 9 * GIB, cpu: 100 }, { memory: 9 * GIB, cpu: 100 }).memory, 9 * GIB);
  // At most SAMPLES_KEPT kept.
  const f = macFixture();
  writeFileSync(join(f.dir_p, ESTIMATE_FILE), JSON.stringify({ samples: Array.from({ length: SAMPLES_KEPT + 10 }, (_, i) => ({ at: 'x', actor: 'a', 'memory-bytes': GIB + i, 'cpu-percent': 1 })), 'checked-at': null, estimate: null }));
  const project = f.ctx.load().projects.find(p => p.id === 'p');
  const e = estimateFor(f.ctx, f.ctx.load(), project, { ...DEFAULTS, ...ENTRY }, { own: true });
  assert.equal(e.samples, SAMPLES_KEPT);
  assert.ok(existsSync(join(f.dir_p, ESTIMATE_FILE)));
});

test('ASS-570: another control\'s project is read from what that control kept, never sampled or written here', async () => {
  const f = macFixture();
  writeFileSync(join(f.dir_p, ESTIMATE_FILE), JSON.stringify({ samples: [{ at: 'x', actor: 'a', 'memory-bytes': 4 * GIB, 'cpu-percent': 150 }], 'checked-at': null, estimate: { 'memory-bytes': 4 * GIB, 'cpu-percent': 150 } }));
  const project = f.ctx.load().projects.find(p => p.id === 'p');
  const before = readFileSync(join(f.dir_p, ESTIMATE_FILE), 'utf8');
  const e = estimateFor(f.ctx, f.ctx.load(), project, { ...DEFAULTS, ...ENTRY }, { own: false });
  assert.deepEqual([e.memory, e.cpu, e.source, e.samples], [4 * GIB, 150, 'working-samples', 1]);
  assert.equal(readFileSync(join(f.dir_p, ESTIMATE_FILE), 'utf8'), before);
});
