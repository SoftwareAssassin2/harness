// ASS-528: seats from the Mac's memory and CPU budget, shared between projects by percentage (seat-budget.js):
// shares (AC3), allocation and reallocation (AC4), admission at and over each limit (AC5), the phase's logging (AC6),
// and control giving seats by it (AC1, AC2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveShares, allocate, grantSeats, budgetSeats, budgetOf, DEFAULT_BUDGET, cpuNeed } from '../../src/control/seat-budget.js';
import { smooth, parsePsCpu } from '../../src/control/host-cpu.js';
import { controlFixture, macSeats } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { hs } from '../agent-cli/harness-fixture.js';

const GIB = 2 ** 30;
const near = (a, b) => Math.abs(a - b) < 1e-6;
const shares = list => Object.fromEntries(resolveShares(list).shares);

test('ASS-528 AC3: shares — unset ones split 100 equally; set ones are honoured, the unset splitting what they leave', () => {
  const equal = shares([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  assert.deepEqual(equal, { a: 25, b: 25, c: 25, d: 25 });
  const set = resolveShares([{ id: 'a', share: 50 }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(Object.fromEntries(set.shares), { a: 50, b: 25, c: 25 });
  assert.deepEqual(Object.fromEntries(set.source), { a: 'set', b: 'split', c: 'split' });
  assert.equal(set.scaled, null);
  // all set, adding to under 100: each its own (the rest is spare, allocate hands it out).
  assert.deepEqual(shares([{ id: 'a', share: 30 }, { id: 'b', share: 20 }]), { a: 30, b: 20 });
});

test('ASS-528 AC3: shares adding to more than 100 are scaled down to 100 (said, for the log), leaving nothing for the unset; a share that is no percentage is ignored', () => {
  const over = resolveShares([{ id: 'a', share: 80 }, { id: 'b', share: 60 }, { id: 'c' }]);
  assert.deepEqual(over.scaled, { sum: 140 });
  assert.ok(near(over.shares.get('a'), 80 * 100 / 140) && near(over.shares.get('b'), 60 * 100 / 140));
  assert.equal(over.shares.get('c'), 0);
  const bad = resolveShares([{ id: 'a', share: 'half' }, { id: 'b', share: 150 }, { id: 'c', share: 40 }]);
  assert.deepEqual(bad.invalid, [{ id: 'a', share: 'half' }, { id: 'b', share: 150 }]);
  assert.deepEqual(Object.fromEntries(bad.shares), { a: 30, b: 30, c: 40 });
});

test('ASS-528 AC4: allocate — each its share at most its want; an idle share goes to those who want more, by their shares, and on to the next when they are satisfied', () => {
  // three equal shares of 90; a idle, b and c want plenty: a's 30 split between them.
  const idle = allocate(90, [{ id: 'a', share: 100 / 3, want: 0 }, { id: 'b', share: 100 / 3, want: 1000 }, { id: 'c', share: 100 / 3, want: 1000 }]);
  assert.ok(near(idle.get('a'), 0) && near(idle.get('b'), 45) && near(idle.get('c'), 45));
  // by their shares: b 50, c 25 of the idle a's 25.
  const weighted = allocate(100, [{ id: 'a', share: 25, want: 0 }, { id: 'b', share: 50, want: 1000 }, { id: 'c', share: 25, want: 1000 }]);
  assert.ok(near(weighted.get('b'), 50 + 25 * 2 / 3) && near(weighted.get('c'), 25 + 25 / 3));
  // b satisfied with a little more: the rest goes on to c — none lost while c could use it.
  const onward = allocate(100, [{ id: 'a', share: 25, want: 0 }, { id: 'b', share: 50, want: 55 }, { id: 'c', share: 25, want: 1000 }]);
  assert.ok(near(onward.get('b'), 55) && near(onward.get('c'), 45));
  // a project that cannot use the Mac (want 0) never gets any.
  assert.equal(allocate(100, [{ id: 'remote', share: 50, want: 0 }, { id: 'b', share: 50, want: 1000 }]).get('remote'), 0);
});

// A project for grantSeats: `id`, its share, its want and held, 4 GiB and 100% CPU a ticket.
const project = (id, share, want, held = 0, extra = {}) => ({ id, share, canUse: true, want, held, starting: 0, per: { memory: 4 * GIB, cpu: 100 }, ...extra });
const budget = { memory: 40 * GIB, cpu: null };   // 10 tickets' memory, CPU not read
const idleMac = { memory: 0, cpu: 0, cpuFull: false };
const seatsOf = result => Object.fromEntries([...result].map(([id, r]) => [id, r.seats]));

test('ASS-528 AC4, AC7: equal split — two projects wanting plenty get five seats each; set shares give 7 and 3', () => {
  assert.deepEqual(seatsOf(grantSeats({ budget, mac: idleMac, projects: [project('a', 50, 20), project('b', 50, 20)] })), { a: 5, b: 5 });
  assert.deepEqual(seatsOf(grantSeats({ budget, mac: idleMac, projects: [project('a', 70, 20), project('b', 30, 20)] })), { a: 7, b: 3 });
});

test('ASS-528 AC4, AC7: an idle project\'s share is reallocated to the one that can use it; a project with only remote work gets none and its share goes on', () => {
  const idle = grantSeats({ budget, mac: idleMac, projects: [project('a', 50, 20), project('b', 50, 0)] });
  assert.equal(idle.get('a').seats, 10);
  assert.equal(idle.get('a').allotSeats, 10);
  assert.equal(idle.get('b').seats, 0);   // nothing to start, and the Mac's headroom all taken by a
  const remote = grantSeats({ budget, mac: idleMac, projects: [project('a', 50, 20), project('ws', 50, 6, 0, { canUse: false })] });
  assert.deepEqual([remote.get('a').seats, remote.get('ws').seats, remote.get('ws').allotSeats], [10, 0, 0]);
});

test('ASS-528 AC4, AC7: returning demand reclaims share from the next freed seats; nothing running is cut off', () => {
  // a holds all ten (its VMs running: the Mac's memory measured in use); b's demand returns.
  const full = grantSeats({ budget, mac: { ...idleMac, memory: 40 * GIB }, projects: [project('a', 50, 10, 10), project('b', 50, 5)] });
  assert.deepEqual([full.get('a').seats, full.get('b').seats], [10, 0]);   // a keeps its ten, over its allotment of five
  assert.deepEqual([full.get('a').allotSeats, full.get('b').allotSeats], [5, 5]);
  // two of a's seats free (its tickets at gates, their VMs stopped): both go to b, none back to a.
  const freed = grantSeats({ budget, mac: { ...idleMac, memory: 32 * GIB }, projects: [project('a', 50, 10, 8), project('b', 50, 5)] });
  assert.deepEqual([freed.get('a').seats, freed.get('b').seats], [8, 2]);
  // b back at its share: a gets the next one again only once b wants no more.
  const back = grantSeats({ budget, mac: { ...idleMac, memory: 36 * GIB }, projects: [project('a', 50, 10, 4), project('b', 50, 5, 5)] });
  assert.deepEqual([back.get('a').seats, back.get('b').seats], [5, 5]);
});

test('ASS-528 AC5, AC7: admission at and over the memory limit — measured use plus one more ticket within it admits; over it, nobody', () => {
  const at = grantSeats({ budget, mac: { ...idleMac, memory: 36 * GIB }, projects: [project('a', 100, 5, 0)] });
  assert.deepEqual([at.get('a').seats, at.get('a').over], [1, []]);
  const short = grantSeats({ budget, mac: { ...idleMac, memory: 36 * GIB + 1 }, projects: [project('a', 100, 5, 0)] });
  assert.equal(short.get('a').seats, 0);
  const over = grantSeats({ budget, mac: { ...idleMac, memory: 41 * GIB }, projects: [project('a', 100, 5, 2), project('b', 0, 5)] });
  assert.deepEqual([over.get('a').seats, over.get('b').seats, over.get('a').over], [2, 0, ['memory']]);
  // seats given whose VMs are not running yet count as used: two starting leave room for 7 more, not 9.
  const starting = grantSeats({ budget, mac: { ...idleMac, memory: 4 * GIB }, projects: [project('a', 100, 20, 2, { starting: 2 })] });
  assert.equal(starting.get('a').seats, 2 + 7);
});

test('ASS-528 AC5, AC7: admission at and over the CPU limit, and with CPU full (hysteresis) nobody', () => {
  const cpu = { memory: null, cpu: 900 };
  const at = grantSeats({ budget: cpu, mac: { memory: 0, cpu: 800, cpuFull: false }, projects: [project('a', 100, 5)] });
  assert.equal(at.get('a').seats, 1);
  const short = grantSeats({ budget: cpu, mac: { memory: 0, cpu: 800.5, cpuFull: false }, projects: [project('a', 100, 5)] });
  assert.equal(short.get('a').seats, 0);
  const over = grantSeats({ budget: cpu, mac: { memory: 0, cpu: 950, cpuFull: true }, projects: [project('a', 100, 5, 3)] });
  assert.deepEqual([over.get('a').seats, over.get('a').over], [3, ['cpu']]);
  const held = grantSeats({ budget: cpu, mac: { memory: 0, cpu: 500, cpuFull: true }, projects: [project('a', 100, 5, 3)] });
  assert.deepEqual([held.get('a').seats, held.get('a').over], [3, ['cpu']]);
  // both limits: the fewer of the two.
  const both = grantSeats({ budget: { memory: 40 * GIB, cpu: 250 }, mac: idleMac, projects: [project('a', 100, 9)] });
  assert.equal(both.get('a').seats, 2);
  // no reading of either: not limited.
  assert.equal(grantSeats({ budget: { memory: null, cpu: null }, mac: idleMac, projects: [project('a', 100, 9)] }).get('a').seats, Infinity);
});

test('ASS-528: the default budget is 90% of memory and 90% of CPU; harness.json\'s settings override it', () => {
  assert.deepEqual(DEFAULT_BUDGET, { 'max-memory-percent': 90, 'max-cpu-percent': 90 });
  assert.deepEqual(budgetOf({}), { memory: 90, cpu: 90 });
  assert.deepEqual(budgetOf({ 'max-memory-percent': 70, 'max-cpu-percent': 50 }), { memory: 70, cpu: 50 });
});

test('ASS-528 AC5: CPU is read from ps and averaged over the window; one ticket\'s expected CPU is its project\'s running VMs\' average, the floor at least', () => {
  const ps = parsePsCpu('  1  12.5 /sbin/launchd\n 40 150.0 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine\n 41   3,5 node\n');
  assert.equal(ps.totalPercent, 166);
  assert.deepEqual([...ps.vz], [[40, 150]]);
  const s = smooth([{ ncpu: 10, totalPercent: 100, vms: new Map([['vm-1', 300], ['vm-2', 50]]) }, { ncpu: 10, totalPercent: 300, vms: new Map([['vm-1', 100]]) }]);
  assert.deepEqual([s.capacity, s.percent, [...s.vms]], [1000, 200, [['vm-1', 200]]]);   // vm-2 stopped since
  const ctx = { paths: { projects: '/nowhere' } };
  const p = { id: 'p', tickets: [{ key: 'T-1', variations: [{ name: 'A', vm: { name: 'vm-1' } }] }] };
  assert.equal(cpuNeed(ctx, { harness: {} }, p, s), 200);
  assert.equal(cpuNeed(ctx, { harness: { 'cpu-need-floor-percent': 250 } }, p, s), 250);
  assert.equal(cpuNeed(ctx, { harness: {} }, { id: 'q', tickets: [] }, s), 100);
});

// The control fixture with tickets at `states` (ABC-1…), and a project q beside p when `q` is given (its share, its tickets).
function sprintOf(f, states, dir = join(f.dir, 'projects', 'p')) {
  writeFileSync(join(dir, 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10, bugs: [], spikes: [],
    features: states.map((state, i) => ({ key: `ABC-${i + 1}`, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': [] }] })),
  }, null, 4));
}
const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };

test('ASS-528 AC1, AC2: control gives seats by the budget — two seats on this Mac: the two highest-ranked in planning or at work take them, the third waits; max-tickets-in-progress is not read', async () => {
  const f = controlFixture();
  macSeats(f.ctx, 2);
  edit(join(f.dir, 'harness.json'), h => { h['max-tickets-in-progress'] = 9; h['max-tickets-in-planning'] = 9; });
  sprintOf(f, ['plan', 'plan', 'plan']);
  await tick(f.ctx);
  const budget = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'seat-budget.json'), 'utf8'));
  assert.equal(budget.seats, 2, f.lines.join('\n'));
  assert.equal(budget.share, 100);
  assert.equal(f.assignments().assignments.length, 2, f.lines.join('\n'));
  const seats = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'seats.json'), 'utf8'));
  assert.equal(seats.planning.length, 2);   // the planning holders recorded: one pool
});

test('ASS-528 AC5: a tick with the Mac over its memory limit admits nobody, and says so once; nothing running is cut off', async () => {
  const f = controlFixture();
  const total = 40 * GIB;
  f.ctx.hostMemory = async () => ({ freePercent: 5, pressure: 'normal', totalBytes: total, freeBytes: total * 0.05, reclaimableBytes: total, swapouts: 0, swapUsedBytes: 0, vms: new Map(), measure: 'footprint' });
  delete f.ctx.memory.hostMemory;
  sprintOf(f, ['plan']);
  await tick(f.ctx);
  await tick(f.ctx);
  assert.equal(f.assignments().assignments.length, 0, f.lines.join('\n'));
  assert.equal(f.lines.filter(l => /^budget the Mac is over its memory limit/.test(l)).length, 1, f.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'seat-budget.json'), 'utf8')).seats, 0);
});

test('ASS-528 AC6: each project\'s share, allotment and use is logged once when it changes; shares over 100 logged scaled down', async () => {
  const f = controlFixture();
  macSeats(f.ctx, 4);
  // a second project q, sharing the Mac: p 80%, q 60% — over 100.
  const qDir = join(f.dir, 'projects', 'q');
  const { cpSync } = await import('node:fs');
  cpSync(join(f.dir, 'projects', 'p'), qDir, { recursive: true });
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p.share = 80; });
  edit(join(qDir, 'project.json'), p => { p.share = 60; p.name = 'Q'; });
  sprintOf(f, ['committed']);
  sprintOf(f, [], qDir);
  const state = () => f.ctx.load();
  await budgetSeats(f.ctx, state());
  await budgetSeats(f.ctx, state());
  const budgetLines = f.lines.filter(l => l.startsWith('budget '));
  assert.equal(budgetLines.filter(l => /shares add to 140%, over 100: scaled down to 100 \(p 57\.1%, q 42\.9%\)/.test(l)).length, 1, budgetLines.join('\n'));
  assert.equal(budgetLines.filter(l => l.startsWith('budget p: share 57.1%')).length, 1, budgetLines.join('\n'));
  assert.equal(budgetLines.filter(l => l.startsWith('budget q: share 42.9%')).length, 1, budgetLines.join('\n'));
  assert.match(budgetLines.find(l => l.startsWith('budget p:')), /allotment 2 seats \(10\.3 GiB\), uses 0, wants 1; may hold 2 now/);
  // a change (q's tickets want seats now): logged again, once.
  sprintOf(f, ['plan', 'plan'], qDir);
  await budgetSeats(f.ctx, state());
  await budgetSeats(f.ctx, state());
  assert.equal(f.lines.filter(l => l.startsWith('budget q:')).length, 2, f.lines.join('\n'));
  assert.ok(existsSync(join(qDir, 'seat-budget.json')));
});

test('ASS-528 AC5: CPU is smoothed with hysteresis — reaching the limit stops new seats until use is back under it by the band', async () => {
  const f = controlFixture();
  f.ctx.hostMemory = null;
  let pct = 950, now = Date.parse('2026-11-22T00:00:00Z');
  f.ctx.now = () => new Date(now);
  f.ctx.hostCpu = async () => ({ ncpu: 10, totalPercent: pct, vms: new Map() });
  sprintOf(f, ['committed']);
  const seats = async () => { await budgetSeats(f.ctx, f.ctx.load()); return JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'seat-budget.json'), 'utf8')); };
  assert.deepEqual((await seats()).mac.over, ['cpu']);   // 950% of 1000%, over 900%
  // a 5-minute window: one low reading does not lift it (averaged), nor does an average just under the limit (band 5% = 50).
  for (const p of [860, 880]) { pct = p; now += 16e3; assert.deepEqual((await seats()).mac.over, ['cpu']); }   // averages 905, then 897: under 900 but not by the band
  pct = 880; now += 6 * 60e3;   // the window now holds only 880s: under 900, but not by the band
  assert.deepEqual((await seats()).mac.over, ['cpu']);
  pct = 840; now += 6 * 60e3;
  const back = await seats();
  assert.deepEqual(back.mac.over, []);
  assert.equal(back.seats, 0 + Math.floor((900 - 840) / 100));   // room for no whole ticket of 100%
  pct = 700; now += 6 * 60e3;
  assert.equal((await seats()).seats, 2);
});

test('ASS-528: neither memory nor CPU read (readings failing) — conservative: no new seat, those held keep theirs; with no reader at all (HOST_MEMORY_DISABLED) not limited', () => {
  const none = { memory: null, cpu: null };
  const blind = grantSeats({ budget: none, mac: idleMac, projects: [project('a', 50, 9, 3), project('b', 50, 4, 0)], unread: true });
  assert.deepEqual([blind.get('a').seats, blind.get('b').seats, blind.get('a').over], [3, 0, ['unread']]);
  assert.equal(grantSeats({ budget: none, mac: idleMac, projects: [project('a', 100, 9, 3)] }).get('a').seats, Infinity);
});

// failing(f, { memory, cpu }) — the fixture's Mac with each reading working (true) or failing (false); a working one
// sized for two 4 GiB tickets, or 200% of CPU free a 100% ticket at a time.
function failing(f, { memory, cpu }) {
  const total = Math.round((2.5 * 4 * GIB) / 0.9);
  f.ctx.hostMemory = memory ? async () => ({ freePercent: 100, pressure: 'normal', totalBytes: total, freeBytes: total, reclaimableBytes: total, swapouts: 0, swapUsedBytes: 0, vms: new Map(), measure: 'footprint' }) : async () => { throw new Error('sysctl: gone'); };
  f.ctx.hostCpu = cpu ? async () => ({ ncpu: 1, totalPercent: 0, vms: new Map() }) : async () => { throw new Error('ps: gone'); };
  delete f.ctx.memory.hostMemory;
  delete f.ctx.memory.hostCpu;
}
const budgetFile = f => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'seat-budget.json'), 'utf8'));

test('ASS-528: the Mac\'s memory and CPU both unreadable — no new seats (seats held keep running), logged once per outage; back once either reads; the queue still written', async () => {
  const f = controlFixture();
  failing(f, { memory: false, cpu: false });
  sprintOf(f, ['plan', 'plan', 'committed']);
  // ABC-1 already holds a seat (seats.json, as last tick left it).
  writeFileSync(join(f.dir, 'projects', 'p', 'seats.json'), JSON.stringify({ seats: [], planning: [{ key: 'ABC-1', variation: 'A', since: '2026-11-22T00:00:00Z' }] }));
  await tick(f.ctx);
  await tick(f.ctx);
  assert.equal(budgetFile(f).seats, 1, f.lines.join('\n'));
  assert.deepEqual(budgetFile(f).mac.over, ['unread']);
  assert.deepEqual(f.assignments().assignments.filter(a => a.state === 'plan').map(a => a['work-item']), ['ABC-1'], f.lines.join('\n'));   // (ABC-3's gap run aside: no seat)
  assert.equal(f.lines.filter(l => l === "budget can't read the Mac's memory or CPU — no new seats until it can; seats held keep running").length, 1, f.lines.join('\n'));
  const queue = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'seat-queue.json'), 'utf8')).queue.map(q => q.key);
  assert.deepEqual(queue, ['ABC-2', 'ABC-3'], 'the queue still written');
  // The memory reads again: seats by the budget again, said once.
  failing(f, { memory: true, cpu: false });
  await tick(f.ctx);
  assert.equal(f.lines.filter(l => /^budget the Mac's memory or CPU reads again/.test(l)).length, 1, f.lines.join('\n'));
  assert.equal(budgetFile(f).seats, 2, f.lines.join('\n'));
});

test('ASS-528: only one of memory and CPU readable — that one alone is applied', async () => {
  // Memory only: two tickets' memory.
  const m = controlFixture();
  failing(m, { memory: true, cpu: false });
  sprintOf(m, ['plan', 'plan', 'plan']);
  await budgetSeats(m.ctx, m.ctx.load());
  assert.deepEqual([budgetFile(m).seats, budgetFile(m)['per-ticket']['cpu-percent'], budgetFile(m).mac.over], [2, null, []]);
  // CPU only: a one-core Mac, 90% budget, no load — no 100% ticket fits; at 1000% on ten cores, 9 of them, 3 wanted.
  const c = controlFixture();
  failing(c, { memory: false, cpu: true });
  c.ctx.hostCpu = async () => ({ ncpu: 10, totalPercent: 0, vms: new Map() });
  sprintOf(c, ['plan', 'plan', 'plan']);
  await budgetSeats(c.ctx, c.ctx.load());
  assert.deepEqual([budgetFile(c).seats, budgetFile(c)['per-ticket']['memory-bytes'], budgetFile(c).mac.over], [9, null, []]);
});

// ASS-530: what the dashboard's footer shows — what each project lends and borrows, and its VMs' measured use.
test('ASS-530 AC1, AC5: grantSeats says what an idle project lends and the busy one borrows; nothing when every share is used', () => {
  // a wants 8 tickets (32 GiB) of a 50% share (20 GiB): it borrows 12 GiB of b's, which wants 1 (4 GiB) — b lends 12.
  const lent = grantSeats({ budget, mac: idleMac, projects: [project('a', 50, 8), project('b', 50, 1)] });
  assert.ok(near(lent.get('a').borrows.memory, 12 * GIB) && near(lent.get('a').lends.memory, 0), JSON.stringify(lent.get('a')));
  assert.ok(near(lent.get('b').lends.memory, 12 * GIB) && near(lent.get('b').borrows.memory, 0), JSON.stringify(lent.get('b')));
  assert.equal(lent.get('a').lends.cpu, undefined);   // CPU not read: not applied
  // Both want more than their share: nobody lends or borrows.
  const even = grantSeats({ budget, mac: idleMac, projects: [project('a', 50, 20), project('b', 50, 20)] });
  for (const id of ['a', 'b']) assert.ok(near(even.get(id).lends.memory, 0) && near(even.get(id).borrows.memory, 0), id);
  // b idle but nobody borrowing (a wants no more than its share): b's spare is not lent.
  const idleBoth = grantSeats({ budget, mac: idleMac, projects: [project('a', 50, 2), project('b', 50, 0)] });
  assert.ok(near(idleBoth.get('b').lends.memory, 0), JSON.stringify(idleBoth.get('b')));
  // A project with only remote work lends all of its share it can't use; the part lent is the borrowers' total.
  const remote = grantSeats({ budget, mac: idleMac, projects: [project('a', 50, 6), project('ws', 50, 3, 0, { canUse: false })] });
  assert.ok(near(remote.get('ws').lends.memory, 4 * GIB) && near(remote.get('a').borrows.memory, 4 * GIB), JSON.stringify([...remote]));
});

test('ASS-530 AC1: seat-budget.json records the project\'s VMs\' measured memory and CPU, and what it lends and borrows', async () => {
  const f = controlFixture();
  macSeats(f.ctx, 4);
  const reading = await f.ctx.hostMemory();
  f.ctx.hostMemory = async () => ({ ...reading, vms: new Map([['p-vm-1', 3 * GIB], ['another-projects-vm', 5 * GIB]]) });
  writeFileSync(join(f.dir, 'projects', 'p', 'vms.json'), JSON.stringify({ 'p-vm-1': { ticket: 'ABC-1', variation: 'A', state: 'Running' } }));
  sprintOf(f, ['plan']);
  await budgetSeats(f.ctx, f.ctx.load());
  const file = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'seat-budget.json'), 'utf8'));
  assert.equal(file.used['memory-bytes'], 3 * GIB, JSON.stringify(file));   // its own VM only
  assert.equal(file.used['cpu-percent'], null);                             // CPU not read here
  assert.deepEqual(Object.keys(file.lends), ['memory-bytes', 'cpu-percent']);
  assert.deepEqual(Object.keys(file.borrows), ['memory-bytes', 'cpu-percent']);
  assert.equal(file.lends['cpu-percent'], null);
});
