// ASS-420: a seat only when the ticket's VM fits in the Mac's memory
// (src/control/seat-memory.js). Before control gives a variation a planning
// or an in-progress seat whose next steps need a VM that is not running, it
// checks the VM fits — pressure normal, free memory at least the need on top
// of the VMs already starting — and, when it does not, the variation takes no
// seat: it waits as for a slot, no move, no status change, no visit spent, its
// Health "Waiting for memory for its VM (need X GB, Y GB free)". The Mac's
// memory is ctx.hostMemory's, replaced here; the real grouped engines; limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { seatMemory, MEMORY_HEALTH } from '../../src/control/seat-memory.js';
import { planFor } from '../../src/control/plan.js';
import { mayMove } from '../../src/control/moves.js';
import { MEMORY_READ_EVERY } from '../../src/control/host-memory.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const GIB = 2 ** 30;
const ENGINE = 'example-development-grouped';
const at = (state, sub) => ({ state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) });
const BUILDING = at('build', ['grouped-build', 'generate-solution']);
const PLANNED = at('plan', ['grouped-plan', 'done']);   // a finished plan (ASS-362): no seat, ready for Build
// A reading of a 100 GiB Mac, so its free percentage is its free GiB.
const mac = ({ free = 64, pressure = 'normal', vms = {} } = {}) => ({ freePercent: free, pressure, totalBytes: 100 * GIB, vms: new Map(Object.entries(vms)) });

// p on example-development-grouped, its VMs 4 GiB (the need with none
// measured: the 4 GiB floor); ABC-3's variations as `variations` gives them
// ({ name: [harness-status, VM status or null, extra] }), each VM abc-3-<name>;
// one in-progress seat; agent.sh calls recorded; the Mac's memory set(mac's options).
function seats(variations) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  writeFileSync(file('harness.json'), JSON.stringify({ ...JSON.parse(readFileSync(file('harness.json'), 'utf8')), 'max-tickets-in-progress': 1 }));
  for (const name of engineNames()) if (!existsSync(file('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), file('engines', name), { recursive: true });
  const project = JSON.parse(readFileSync(file('projects', 'p', 'project.json'), 'utf8'));
  writeFileSync(file('projects', 'p', 'project.json'), JSON.stringify({ ...project, 'execution-state-engine': ENGINE, 'golden-image': { folder: 'golden-p' } }));
  mkdirSync(file('golden-p'), { recursive: true });
  writeFileSync(file('golden-p', 'template.yaml'), 'vmType: vz\nmemory: 4GiB\n');
  const v = fakeVm(f.env);
  const sprint = file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const write = vs => writeFileSync(sprint, JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', 'ticket-system-status': 'In Progress', variations: Object.entries(vs).map(([name, [status, vm, extra]]) => {
    if (vm) v.instance(`abc-3-${name.toLowerCase()}`, vm);
    return { name, 'harness-status': status, 'state-changes': [], vm: { name: `abc-3-${name.toLowerCase()}`, ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }, ...extra };
  }) }] }));
  write(variations);
  f.ctx.env = { ...v.env, HARNESS_HOME: file('harness-home') };
  let now = Date.parse('2026-11-12T10:00:00Z'), reading = mac();
  f.ctx.now = () => new Date(now);
  f.ctx.hostMemory = async () => reading;
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); return ''; };
  const plan = () => { const state = f.ctx.load(), p = planFor(state, state.projects[0]); return { reserved: p.reserved.map(s => s.variation), waiting: p.waiting.map(s => s.variation), memoryWaiting: p.memoryWaiting.map(s => s.variation) }; };
  return {
    f, calls, write, plan,
    set: options => { reading = mac(options); now += MEMORY_READ_EVERY; },
    pass: async () => { const before = calls.length; await seatMemory(f.ctx, f.ctx.load()); return calls.slice(before); },
    record: () => (existsSync(file('projects', 'p', 'memory-wait.json')) ? JSON.parse(readFileSync(file('projects', 'p', 'memory-wait.json'), 'utf8')) : null),
  };
}

test('ASS-420 AC1/AC5: a seat that comes round to a variation whose VM is not running and does not fit is refused — no seat, its VM not started, no move or status change, its Health saying why — and given once memory frees up', async () => {
  const h = seats({ A: [BUILDING, 'Running'], B: [BUILDING, 'Stopped'] });
  h.f.ctx.memory.vmsUp = new Set(['abc-3-a']);
  await h.pass();
  assert.deepEqual(h.plan(), { reserved: ['A'], waiting: ['B'], memoryWaiting: [] });
  // A paused: its seat comes round to B, whose VM does not fit in 2 GiB.
  h.write({ A: [BUILDING, 'Running', { 'is-paused': true }], B: [BUILDING, 'Stopped'] });
  h.set({ free: 2 });
  assert.deepEqual(await h.pass(), ['ticket:set-ai-feedback p ABC-3 B Waiting for memory for its VM (need 4.0 GB, 2.0 GB free) ' + `${MEMORY_HEALTH} its next steps need a VM that is not running, and it does not fit in the Mac's memory: a VM needs 4.0 GB (none of its VMs running to measure: the 4.0 GiB floor), and 2.0 GB is free once the VMs already starting are counted. It holds no seat meanwhile and takes one once there is room. Nothing for you to do.`]);
  assert.deepEqual(h.plan(), { reserved: [], waiting: [], memoryWaiting: ['B'] });
  assert.deepEqual(h.record().waiting.map(w => [w.key, w.variation, w['need-bytes'], w['free-bytes']]), [['ABC-3', 'B', 4 * GIB, 2 * GIB]]);
  assert.ok(h.f.lines.includes('seats ABC-3 B: waits for memory for its VM, holding no seat (need 4.0 GB, 2.0 GB free)'), h.f.lines.join('\n'));
  // Still short: refused again, its Health (as ticket:set-ai-feedback wrote it) not written again.
  h.write({ A: [BUILDING, 'Running', { 'is-paused': true }], B: [BUILDING, 'Stopped', { 'ai-feedback-long': `${MEMORY_HEALTH} …` }] });
  h.set({ free: 2.2 });
  assert.deepEqual(await h.pass(), []);
  assert.deepEqual(h.plan().memoryWaiting, ['B']);
  // Warn pressure with room: refused too.
  h.set({ free: 40, pressure: 'warn' });
  await h.pass();
  assert.deepEqual(h.plan().memoryWaiting, ['B']);
  // Room: B takes the seat; the Health control wrote is cleared.
  h.set({ free: 16 });
  assert.deepEqual(await h.pass(), [`ticket:clear-ai-feedback p ABC-3 B ${MEMORY_HEALTH} …`]);
  assert.deepEqual(h.plan(), { reserved: ['B'], waiting: [], memoryWaiting: [] });
  assert.equal(h.record(), null);
  assert.ok(h.f.ctx.memory.seatMemory.starting.has('p ABC-3 B'), 'its VM starting: held back from the next check');
  assert.ok(!h.calls.some(c => /^ticket:(change-state|move|change-sub-state)/.test(c)), h.calls.join('\n'));
  assert.deepEqual(h.f.ctx.load().projects[0].tickets[0].variations.map(v => [v['harness-status'].state, v['state-changes'].length]), [['build', 0], ['build', 0]], 'no move, no visit spent');
});

test('ASS-420 AC2/AC3: seats in rank order — a ticket that does not fit does not block a lower-ranked one whose VM is up, or whose next steps need none; a VM already starting is counted', async () => {
  const h = seats({ A: [BUILDING, 'Running'], B: [BUILDING, 'Stopped'], C: [BUILDING, 'Running'] });
  h.f.ctx.memory.vmsUp = new Set(['abc-3-a', 'abc-3-c']);
  await h.pass();
  h.write({ A: [BUILDING, 'Running', { 'is-paused': true }], B: [BUILDING, 'Stopped'], C: [BUILDING, 'Running'] });
  h.set({ free: 3 });
  await h.pass();
  assert.deepEqual(h.plan(), { reserved: ['C'], waiting: [], memoryWaiting: ['B'] }, 'B refused, C — its VM up — takes the seat');
  // Room for one VM, but another's start holds it back: B waits on.
  h.set({ free: 6 });
  h.f.ctx.memory.seatMemory.starting.set('q XYZ-1 A', { project: 'q', key: 'XYZ-1', variation: 'A', bytes: 4 * GIB, since: Date.now() });
  const state = h.f.ctx.load();
  state.projects.push({ id: 'q', tickets: [{ key: 'XYZ-1', variations: [{ name: 'A' }] }] });   // the other project's, for the pruning
  await seatMemory(h.f.ctx, state);
  assert.deepEqual(h.plan().memoryWaiting, ['B'], '6 GiB free less 4 starting is short of 4');
});

test('ASS-420 AC1/AC2/AC4: a move into a seat whose VM does not fit waits, said once — no move — while one whose VM is up moves; it moves once there is room', async () => {
  const h = seats({ D: [PLANNED, 'Stopped'], C: [PLANNED, 'Running'] });
  h.f.ctx.memory.vmsUp = new Set(['abc-3-c']);
  h.set({ free: 1 });
  await h.pass();
  let state = h.f.ctx.load(), project = state.projects[0], [d, c] = project.tickets[0].variations;
  assert.equal(mayMove(h.f.ctx, 'steps', state, project, d, 'ABC-3 D plan', 'build'), false);
  assert.equal(mayMove(h.f.ctx, 'steps', state, project, d, 'ABC-3 D plan', 'build'), false);
  assert.deepEqual(h.f.lines.filter(l => /waits for memory/.test(l)), ['steps ABC-3 D plan: waits for memory for its VM to move to build (need 4.0 GB, 1.0 GB free)'], 'said once per visit');
  assert.equal(mayMove(h.f.ctx, 'steps', state, project, c, 'ABC-3 C plan', 'build'), true, 'C\'s VM is up: it takes the seat');
  // The next pass gives D its Health.
  assert.match((await h.pass())[0], /^ticket:set-ai-feedback p ABC-3 D Waiting for memory for its VM \(need 4\.0 GB, 1\.0 GB free\) /);
  h.set({ free: 16 });
  await h.pass();
  state = h.f.ctx.load(); project = state.projects[0]; [d] = project.tickets[0].variations;
  assert.equal(mayMove(h.f.ctx, 'steps', state, project, d, 'ABC-3 D plan', 'build'), true);
  assert.ok(h.f.ctx.memory.seatMemory.starting.has('p ABC-3 D'), 'its VM held back as starting');
  // A move needing no VM (Release) or with the memory unread asks nothing.
  assert.equal(mayMove({ ...h.f.ctx, memory: { ...h.f.ctx.memory, seatMemory: undefined } }, 'steps', state, project, d, 'ABC-3 D plan', 'build'), true);
});
