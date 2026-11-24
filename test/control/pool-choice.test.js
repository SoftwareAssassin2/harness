// ASS-553: worktrees on remote machines (run targets workstation-worktree, cloud-vm-worktree) and the pool choice
// (most-room: a step goes to the eligible target with the most headroom now). AC1: the two targets are validated like
// the others (a project must have such a machine), take their machine's seat, keep Docker and machine-only steps, and a
// step on one claims the machine in its own worktree (workstation:claim --worktree). AC2: a worktree counts against
// its machine's measured limits beside its Substrate sandboxes. AC3: most-room picks the target with the most room,
// ties in list order; the default (first) is unchanged; each placement it decides is logged once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDispatch } from '../../src/control/plan.js';
import { placeSeats } from '../../src/control/seat-kinds.js';
import { RUN_TARGETS, projectRunTargets, candidates, projectTargetErrors, stepRunTargetErrors, seatKindOf, modeOf, poolChoiceOf, isWorktreeTarget } from '../../src/control/run-targets.js';
import { devEnvironmentsErrors } from '../../src/control/dev-environments.js';
import { headroomOf, macRoom, machineRoom, mostRoom } from '../../src/control/pool-choice.js';
import { budgetRemote, remoteSandboxes } from '../../src/control/remote-seats.js';
import { stepWaits, tendSteps } from '../../src/control/workstation-steps.js';
import { assignSeats } from '../../src/control/seats.js';
import { controlFixture } from './control-fixture.js';

const GIB = 1024 ** 3;
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const cvm = { id: 'vm-1', 'gcp-project': 'g', zone: 'z' };
const json = d => ({ name: 'p', 'dev-environments': d });
const prompt = (id, extra = {}) => ({ id, sequence: 2, name: id, action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }], ...extra });
const script = (id, command) => ({ id, sequence: 2, name: id, action: { type: 'script', command }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }] });
const engineWith = step => ({ steps: [{ id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } }, step, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] });
const at = state => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' } });
const ticket = (key, ...variations) => ({ key, variations });

test('ASS-553 AC1: workstation-worktree and cloud-vm-worktree are run targets, validated like the others — a project lists one only with such a machine; they take that machine\'s seat and run its Docker and machine-only steps', () => {
  assert.ok(RUN_TARGETS.includes('workstation-worktree') && RUN_TARGETS.includes('cloud-vm-worktree'));
  assert.deepEqual(['local-worktree', 'workstation-worktree', 'cloud-vm-worktree', 'workstation'].map(isWorktreeTarget), [true, true, true, false]);
  assert.deepEqual(projectTargetErrors(json({ 'run-targets': ['workstation-worktree'] })), ['dev-environments.run-targets lists workstation-worktree, but dev-environments.workstations lists no workstation']);
  assert.deepEqual(projectTargetErrors(json({ 'run-targets': ['cloud-vm-worktree'], workstations: [ws] })), ['dev-environments.run-targets lists cloud-vm-worktree, but dev-environments.cloud-vms lists no cloud VM']);
  assert.deepEqual(devEnvironmentsErrors(json({ 'run-targets': ['workstation-worktree', 'cloud-vm-worktree', 'local-vm'], workstations: [ws], 'cloud-vms': [cvm] })), []);
  assert.deepEqual(stepRunTargetErrors(prompt('build', { 'run-targets': ['cloud-vm-worktree', 'workstation-worktree'] })), []);
  assert.match(stepRunTargetErrors(prompt('build', { 'run-targets': ['workstation-worktree', 'nope'] }))[0], /unknown run target "nope"/);
  // Their machine's seat, and the mode they amount to.
  assert.deepEqual([seatKindOf('workstation-worktree'), seatKindOf('cloud-vm-worktree'), seatKindOf('local-worktree')], ['workstation', 'cloud-vm', null]);
  assert.equal(modeOf(['workstation-worktree', 'local-vm']), 'vm+workstation');
  // A full machine: a machine-only or Docker command keeps them (never the Mac's local-worktree, nor a sandbox).
  const rt = projectRunTargets(json({ 'run-targets': ['local-worktree', 'workstation-worktree', 'local-substrate', 'local-vm'], workstations: [ws], substrate: { clusters: [{ machine: 'mac' }] } }));
  // (ASS-554: named in the step's own run-targets, as the shipped engines' machine-only and Docker steps do; with no
  // list of its own an unflagged step leaves a project's worktrees to its worktree steps while a plain machine is left.)
  const own = (step, list) => ({ ...step, 'run-targets': list });
  assert.deepEqual(candidates(own(script('repos', './agent.sh vm:refresh-repositories {project} {ticket} {variation}'), ['workstation-worktree', 'local-substrate', 'local-vm']), rt), ['workstation-worktree', 'local-substrate', 'local-vm']);
  assert.deepEqual(candidates(own(script('test-repos', './agent.sh vm:test-repos {project} {ticket} {variation}'), ['workstation-worktree', 'local-vm']), rt), ['workstation-worktree', 'local-vm'], 'a Docker, machine-only command: no sandbox, not the Mac');
  assert.deepEqual(candidates(script('repos', './agent.sh vm:refresh-repositories {project} {ticket} {variation}'), rt), ['local-substrate', 'local-vm']);
  assert.deepEqual(stepRunTargetErrors(script('repos', './agent.sh vm:refresh-repositories {project} {ticket} {variation}')), []);
  // Placed in a seat of their machine's kind, the target recorded.
  const capacity = { mode: 'vm+workstation', vm: 1, workstations: [{ id: 'ws-1', seats: 2, lost: null }, { id: 'vm-1', seats: 1, lost: null, kind: 'cloud-vm' }], remote: 3 };
  const plans = { 'T-1 A': { target: 'workstation-worktree', candidates: ['workstation-worktree'] }, 'T-2 A': { target: 'cloud-vm-worktree', candidates: ['cloud-vm-worktree'] } };
  const placed = placeSeats({ records: [], reserved: [{ key: 'T-1', variation: 'A' }, { key: 'T-2', variation: 'A' }], capacity, targetFor: (k, v) => plans[`${k} ${v}`], now: 'n' });
  assert.deepEqual(placed.records, [
    { key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-worktree', since: 'n' },
    { key: 'T-2', variation: 'A', kind: 'cloud-vm', workstation: 'vm-1', target: 'cloud-vm-worktree', since: 'n' },
  ]);
});

test('ASS-553 AC1: a step on workstation-worktree claims its seat\'s machine in the variation\'s own worktree (workstation:claim --worktree); one on workstation claims a slot as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-claim-'));
  const when = '2026-11-23T09:00:00Z';
  writeFileSync(join(dir, 'workstations.json'), JSON.stringify({ 'ws-1': { connected: true, 'connected-at': when, setup: { ok: true, 'checked-at': when, home: '/home/u' } } }));
  const step = prompt('build', { 'run-location': 'vm' });
  const engine = engineWith(step);
  const calls = [], logs = [];
  const run = async target => {
    writeFileSync(join(dir, 'seats.json'), JSON.stringify({ seats: [{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target, since: when }] }));
    const v = { ...at('build'), 'state-changes': [] }, t = ticket('T-1', v);
    const project = { id: 'p', engine, engines: { e: engine }, devEnvironments: { mode: 'workstation', workstations: [ws] }, tickets: [t], workstations: JSON.parse(readFileSync(join(dir, 'workstations.json'), 'utf8')) };
    const state = { projects: [project], assignments: [], engines: { e: engine } };
    const ctx = { memory: {}, now: () => new Date('2026-11-23T10:00:00Z'), log: (phase, line) => logs.push(`${phase} ${line}`), load: () => state, agents: new Map(),
      attempt: async (_p, _w, f) => f(), cli: async args => { calls.push(args); return JSON.stringify({ name: 'ws-1', slot: 1, folder: target === 'workstation-worktree' ? '/home/u/harness/worktrees/T-1' : '/home/u/harness', ...(target === 'workstation-worktree' ? { worktree: true } : {}) }); } };
    assert.equal(stepWaits(ctx, state, project, t, v, step, 'T-1 A'), true);
    await tendSteps(ctx, project, project.devEnvironments, dir, async () => {});
  };
  await run('workstation-worktree');
  assert.deepEqual(calls.find(c => c[0] === 'workstation:claim'), ['workstation:claim', 'p', 'T-1', 'A', '--workstation', 'ws-1', '--worktree']);
  assert.ok(logs.some(l => /claimed for T-1 A \(its worktree \/home\/u\/harness\/worktrees\/T-1, its own between its steps\)/.test(l)), logs.join('\n'));
  calls.length = 0;
  await run('workstation');
  assert.deepEqual(calls.find(c => c[0] === 'workstation:claim'), ['workstation:claim', 'p', 'T-1', 'A', '--workstation', 'ws-1']);
});

test('ASS-553 AC2: a worktree on a remote machine counts against its measured limits beside its Substrate sandboxes — a workstation running two sandboxed stacks still takes worktree tickets while memory and CPU allow, and none once they do not', async () => {
  const rtJson = { name: 'p', 'dev-environments': { 'run-targets': ['workstation-substrate', 'workstation-worktree'], workstations: [ws], substrate: { clusters: [{ machine: 'ws-1' }] } } };
  const now = Date.parse('2026-11-23T10:00:00Z');
  const usage = (availableGib, cpu) => ({ at: new Date(now - 10e3).toISOString(), memory: { 'total-bytes': 64 * GIB, 'available-bytes': availableGib * GIB }, cpu: { cores: 16, samples: [{ at: new Date(now - 10e3).toISOString(), percent: cpu }] } });
  const live = { node: { running: true }, usage: { 'sandbox-use': { 't-1-a': { state: 'running', 'memory-bytes': 6 * GIB, 'cpu-percent': 150 }, 't-2-a': { state: 'running', 'memory-bytes': 6 * GIB, 'cpu-percent': 150 } } } };
  const make = (availableGib, cpu) => ({
    id: 'p', engine: {}, json: rtJson, runTargets: projectRunTargets(rtJson), devEnvironments: { mode: 'workstation', workstations: [{ ...ws }] },
    workstations: { 'ws-1': { connected: true, usage: usage(availableGib, cpu), holders: { 1: { ticket: 'T-3', variation: 'A', folder: '/home/u/harness/worktrees/T-3', slot: 1, worktree: true } } } },
    substrate: { 'ws-1': live },
    seats: [
      { key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-substrate' },
      { key: 'T-2', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-substrate' },
      { key: 'T-3', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-worktree' },
    ],
  });
  const ctx = { memory: {}, now: () => new Date(now), log: () => {}, paths: { projects: '/nonexistent' } };
  // Its tickets run in sandboxes first (substrate before the worktree), so the cluster's fixed part is apart.
  const roomy = make(40, 600);
  assert.equal(remoteSandboxes(roomy, roomy.devEnvironments.workstations[0]), true);
  await budgetRemote(ctx, { projects: [roomy], harness: {} });
  const b = roomy.remoteBudget['ws-1'];
  assert.deepEqual([b.held, b.pending, b.state], [3, 0, 'measured'], 'the worktree holder and the two running sandboxes are all in the reading');
  assert.equal(b.admit, true, b.why);
  assert.equal(b.seats, 4, 'one more ticket (a worktree, say) fits');
  // Nearly full (memory): no new ticket; the three it holds keep running.
  const full = make(10, 600);
  await budgetRemote({ ...ctx, memory: {} }, { projects: [full], harness: {} });
  assert.deepEqual([full.remoteBudget['ws-1'].seats, full.remoteBudget['ws-1'].admit], [3, false]);
  assert.match(full.remoteBudget['ws-1'].why, /memory limit/);
});

test('ASS-553 AC3: the headroom of the Mac and of each remote machine, in tickets — measured use against the limits, the project\'s allotment on the Mac; unknown with no reading', () => {
  const budget = { mac: { 'memory-used-bytes': 30 * GIB, 'memory-budget-bytes': 36 * GIB, 'cpu-percent': 300, 'cpu-budget-percent': 1260 }, allotment: { 'memory-bytes': 20 * GIB, 'cpu-percent': 600 }, used: { 'memory-bytes': 12 * GIB, 'cpu-percent': 200 }, 'per-ticket': { 'memory-bytes': 4 * GIB, 'cpu-percent': 100 } };
  assert.equal(macRoom(budget), 1.5, 'the Mac\'s 6 GiB free under its budget, less than the project\'s 8 under its allotment, over 4 GiB a ticket');
  assert.equal(macRoom(null), null);
  assert.equal(macRoom({ seats: 2 }), null);
  const remote = { state: 'measured', seats: 3, held: 1, pending: 1, 'memory-used-bytes': 8 * GIB, 'memory-budget-bytes': 28 * GIB, 'cpu-percent': 100, 'cpu-budget-percent': 720, 'per-ticket': { 'memory-bytes': 4 * GIB, 'cpu-percent': 100 } };
  assert.equal(machineRoom(remote), 4, '5 tickets of memory, less the one seated but not running yet');
  assert.deepEqual([machineRoom({ state: 'unmeasured', seats: 1, held: 0 }), machineRoom({ state: 'unread', seats: 1, held: 1 }), machineRoom(null)], [1, 0, null]);
  // Of a kind, the machine with a free seat and the most room; one placed this pass takes a ticket's room off it.
  const project = {
    seatBudget: budget, seats: [{ key: 'X', variation: 'A', kind: 'workstation', workstation: 'ws-a' }],
    devEnvironments: { mode: 'vm+workstation', workstations: [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'vm-1', kind: 'cloud-vm' }] },
    remoteBudget: { 'ws-a': { ...remote, seats: 1 }, 'ws-b': { ...remote, pending: 0, 'memory-used-bytes': 20 * GIB }, 'vm-1': { state: 'unmeasured', seats: 1, held: 0 } },
  };
  const rate = headroomOf(project);
  assert.deepEqual(rate('workstation-worktree'), { room: 2, machine: 'ws-b' }, 'ws-a is full (its one seat held)');
  assert.deepEqual(rate('cloud-vm'), { room: 1, machine: 'vm-1' });
  assert.deepEqual(rate('local-worktree'), { room: 1.5 });
  assert.deepEqual(rate('local-vm', new Map([['mac', 1]])), { room: 0.5 });
  assert.deepEqual(mostRoom([{ target: 'a', room: null }, { target: 'b', room: 1 }, { target: 'c', room: 1 }]).target, 'b', 'ties keep the list order; unknown ranks last');
});

test('ASS-553 AC3: pool choice most-room sends a step to the target with the most headroom now (a loaded Mac sends work to a remote machine); ties keep list order; first, the default, is unchanged', () => {
  const engine = engineWith(prompt('build'));
  const rtOf = choice => projectRunTargets(json({ 'run-targets': ['local-vm', 'workstation', 'local-substrate'], workstations: [ws], substrate: { clusters: [{ machine: 'mac' }] }, ...(choice ? { 'pool-choice': choice } : {}) }));
  const seats = { mac: 4, remote: 2, byKind: { workstation: 2, 'cloud-vm': 0 } };
  const rooms = { 'local-vm': 0.3, workstation: 2.4, 'local-substrate': 0.3 };
  const headroom = (t, placed) => ({ room: rooms[t] - (placed.get(t === 'workstation' ? 'ws-1' : 'mac') ?? 0), ...(t === 'workstation' ? { machine: 'ws-1' } : {}) });
  const ranked = [ticket('T-1', at('build')), ticket('T-2', at('build')), ticket('T-3', at('build'))];
  const plan = (rt, extra = {}) => planDispatch({ ranked, engine, harness: {}, seats, runTargets: rt, headroom, ...extra });
  // Default (no worktree target among them): the first with a free seat, whatever the headroom.
  assert.equal(poolChoiceOf(engine.steps[1], rtOf(), ['local-vm', 'workstation']), 'first');
  assert.deepEqual(plan(rtOf()).targets.map(t => t.target), ['local-vm', 'local-vm', 'local-vm']);
  assert.ok(plan(rtOf()).targets.every(t => t.choice === undefined));
  // most-room: T-1 and T-2 to the workstation (2.4, then 1.4 left); its two seats full, T-3 on the Mac.
  const p = plan(rtOf('most-room'));
  assert.deepEqual(p.targets.map(t => [t.key, t.target, t.machine ?? null]), [['T-1', 'workstation', 'ws-1'], ['T-2', 'workstation', 'ws-1'], ['T-3', 'local-vm', null]]);
  assert.deepEqual(p.targets[0].rooms.map(r => [r.target, r.room]), [['local-vm', 0.3], ['workstation', 2.4], ['local-substrate', 0.3]]);
  assert.equal(p.targets[0].choice, 'most-room');
  // Ties keep the list order (all three 0.3: local-vm, listed first); the next then sees the Mac's room taken.
  rooms.workstation = 0.3;
  assert.deepEqual(plan(rtOf('most-room')).targets.map(t => t.target), ['local-vm', 'workstation', 'local-vm']);
  rooms.workstation = 2.4;
  // Per step: the step's pool-choice wins over the project's.
  const stepFirst = engineWith(prompt('build', { 'pool-choice': 'first' }));
  assert.deepEqual(planDispatch({ ranked, engine: stepFirst, harness: {}, seats, runTargets: rtOf('most-room'), headroom }).targets.map(t => t.target), ['local-vm', 'local-vm', 'local-vm']);
  const stepMost = engineWith(prompt('build', { 'pool-choice': 'most-room' }));
  assert.equal(planDispatch({ ranked, engine: stepMost, harness: {}, seats, runTargets: rtOf(), headroom }).targets[0].target, 'workstation');
  // A seat held is kept, whatever has more room now.
  const kept = plan(rtOf('most-room'), { seated: (t, v) => (t.key === 'T-1' ? { key: 'T-1', variation: v.name, kind: 'vm', target: 'local-vm' } : false) });
  assert.equal(kept.targets.find(t => t.key === 'T-1').target, 'local-vm');
  // Validation: a bad pool-choice, on a step or a project, named; none on a step that uses no machine.
  assert.match(stepRunTargetErrors(prompt('build', { 'pool-choice': 'random' }))[0], /pool-choice "random" is not one of first, most-room, remote-first/);
  assert.match(stepRunTargetErrors({ id: 'gate', action: { type: 'human' }, 'pool-choice': 'most-room' })[0], /pool-choice is set on a step that uses no machine/);
  assert.deepEqual(projectTargetErrors(json({ 'pool-choice': 'nope' })), ['dev-environments.pool-choice "nope" is not one of first, most-room, remote-first']);
});

test('ASS-553 AC7: worktree targets fill the remote machines first — the one with the most headroom — and use the Mac only when every eligible remote machine is full, however much room the Mac has', () => {
  const engine = engineWith(prompt('build'));
  const rt = projectRunTargets(json({ 'run-targets': ['local-worktree', 'workstation-worktree', 'cloud-vm-worktree'], workstations: [ws], 'cloud-vms': [cvm] }));
  assert.equal(poolChoiceOf(engine.steps[1], rt, candidates(engine.steps[1], rt)), 'remote-first', 'the default for worktree targets');
  const rooms = { 'local-worktree': 9, 'workstation-worktree': 0.5, 'cloud-vm-worktree': 1.5 };
  const machine = { 'workstation-worktree': 'ws-1', 'cloud-vm-worktree': 'vm-1' };
  const headroom = (t, placed) => ({ room: rooms[t] - (placed.get(machine[t] ?? 'mac') ?? 0), ...(machine[t] ? { machine: machine[t] } : {}) });
  const ranked = ['T-1', 'T-2', 'T-3', 'T-4'].map(k => ticket(k, at('build')));
  const p = planDispatch({ ranked, engine, harness: {}, seats: { mac: Infinity, remote: 3, byKind: { workstation: 1, 'cloud-vm': 2 } }, runTargets: rt, headroom });
  // The cloud VM (1.5) before the workstation (0.5); the cloud VM again (0.5, tied with the workstation: list order
  // puts the workstation first); the workstation's one seat taken, the cloud VM's second; then, every remote seat
  // full, the Mac — though it had the most room all along.
  assert.deepEqual(p.targets.map(t => [t.key, t.target, t.machine ?? null]), [['T-1', 'cloud-vm-worktree', 'vm-1'], ['T-2', 'workstation-worktree', 'ws-1'], ['T-3', 'cloud-vm-worktree', 'vm-1'], ['T-4', 'local-worktree', null]]);
  assert.ok(p.targets.every(t => t.choice === 'remote-first'));
  // Selectable for other targets: a project of VMs and workstations choosing remote-first.
  const other = projectRunTargets(json({ 'run-targets': ['local-vm', 'workstation'], workstations: [ws], 'pool-choice': 'remote-first' }));
  const q = planDispatch({ ranked: ranked.slice(0, 2), engine, harness: {}, seats: { mac: 4, remote: 1, byKind: { workstation: 1, 'cloud-vm': 0 } }, runTargets: other, headroom: t => ({ room: t === 'local-vm' ? 5 : 0.1, ...(t === 'workstation' ? { machine: 'ws-1' } : {}) }) });
  assert.deepEqual(q.targets.map(t => t.target), ['workstation', 'local-vm']);
});

test('ASS-553 AC3: control places by most-room — a loaded Mac sends the ticket to the workstation with room — and logs each placement decision once', async () => {
  const c = controlFixture();
  const at2 = (...rest) => join(c.dir, ...rest);
  const edit = (file, change) => { const j = JSON.parse(readFileSync(file, 'utf8')); change(j); writeFileSync(file, JSON.stringify(j)); };
  // (ASS-554: the step names both in its own run-targets; with none, an unflagged step would leave the worktree to the
  // project's worktree steps.)
  edit(at2('engines', 'example-development', 'workflow.yaml'), e => { Object.assign(e.steps.find(s => s.id === 'build'), { 'run-location': 'vm', 'run-targets': ['local-vm', 'workstation-worktree'] }); });
  edit(at2('projects', 'p', 'project.json'), p => { p['dev-environments'] = { 'run-targets': ['local-vm', 'workstation-worktree'], 'pool-choice': 'most-room', workstations: [{ id: 'ada-dev', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' }] }; });
  edit(at2('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
    sp.features = ['ABC-3', 'ABC-4'].map((key, i) => ({ key, 'manual-priority': i + 1, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'example-development' }, 'state-changes': [] }] }));
  });
  // The Mac nearly at its budget (half a ticket of room); the workstation measured with room for five.
  writeFileSync(at2('projects', 'p', 'seat-budget.json'), JSON.stringify({ seats: 3, mac: { 'memory-used-bytes': 34 * GIB, 'memory-budget-bytes': 36 * GIB }, allotment: {}, used: {}, 'per-ticket': { 'memory-bytes': 4 * GIB, 'cpu-percent': 100 } }));
  writeFileSync(at2('projects', 'p', 'remote-seats.json'), JSON.stringify({ 'ada-dev': { seats: 1, held: 0, pending: 0, state: 'measured', 'memory-used-bytes': 8 * GIB, 'memory-budget-bytes': 28 * GIB, 'cpu-percent': 100, 'cpu-budget-percent': 720, 'per-ticket': { 'memory-bytes': 4 * GIB, 'cpu-percent': 100 } } }));
  const seats = () => (existsSync(at2('projects', 'p', 'seats.json')) ? JSON.parse(readFileSync(at2('projects', 'p', 'seats.json'), 'utf8')).seats.map(s => [s.key, s.kind, s.workstation ?? null, s.target]) : []);
  await assignSeats(c.ctx, c.ctx.load());
  assert.deepEqual(seats(), [['ABC-3', 'workstation', 'ada-dev', 'workstation-worktree'], ['ABC-4', 'vm', null, 'local-vm']], c.lines.join('\n'));
  const placed = c.lines.filter(l => /placed on .* by pool choice most-room/.test(l));
  assert.ok(placed.some(l => /^seats ABC-3 A: placed on workstation-worktree \(ada-dev\) by pool choice most-room — headroom now, in tickets: local-vm 0\.5, workstation-worktree on ada-dev 5$/.test(l)), c.lines.join('\n'));
  assert.ok(!placed.some(l => /ABC-4/.test(l)), 'ABC-4 had one place left (the workstation full): no choice, nothing logged');
  await assignSeats(c.ctx, c.ctx.load());
  await assignSeats(c.ctx, c.ctx.load());
  assert.equal(c.lines.filter(l => /placed on .* by pool choice most-room/.test(l)).length, placed.length, 'once per placement decision, not every tick');
  assert.deepEqual(seats(), [['ABC-3', 'workstation', 'ada-dev', 'workstation-worktree'], ['ABC-4', 'vm', null, 'local-vm']]);
});

// bootWorld(live) — the control fixture's p on worktree targets [workstation-worktree, local-worktree] with one
// workstation, ada-dev (its live entry `live`), ABC-3 A at build (a machine step), the clock at T0 and movable.
const T0 = Date.parse('2026-11-23T10:00:00Z');
function bootWorld(live, harness = {}) {
  const c = controlFixture();
  const at2 = (...rest) => join(c.dir, ...rest);
  const edit = (file, change) => { const j = JSON.parse(readFileSync(file, 'utf8')); change(j); writeFileSync(file, JSON.stringify(j)); };
  edit(at2('engines', 'example-development', 'workflow.yaml'), e => { e.steps.find(s => s.id === 'build')['run-location'] = 'vm'; });
  edit(at2('projects', 'p', 'project.json'), p => { p['dev-environments'] = { 'run-targets': ['workstation-worktree', 'local-worktree'], workstations: [{ id: 'ada-dev', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' }] }; });
  edit(at2('harness.json'), h => Object.assign(h, harness));
  edit(at2('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
    sp.features = [{ key: 'ABC-3', 'manual-priority': 1, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'example-development' }, 'state-changes': [] }] }];
  });
  writeFileSync(at2('projects', 'p', 'seat-budget.json'), JSON.stringify({ seats: 3 }));
  const setLive = entry => writeFileSync(at2('projects', 'p', 'workstations.json'), JSON.stringify({ 'ada-dev': entry }));
  setLive(live);
  let now = T0;
  c.ctx.now = () => new Date(now);
  const where = () => {
    const f = existsSync(at2('projects', 'p', 'seats.json')) ? JSON.parse(readFileSync(at2('projects', 'p', 'seats.json'), 'utf8')) : {};
    return [...(f.seats ?? []).map(s => `${s.key} ${s.workstation} ${s.target}`), ...(f.local ?? []).map(s => `${s.key} mac ${s.target}`)];
  };
  return { c, setLive, where, phase: async seconds => { now = T0 + seconds * 1000; await assignSeats(c.ctx, c.ctx.load()); }, log: () => c.lines.join('\n') };
}
const STOPPED = { state: 'stopped', connected: false };
const UP = { state: 'running', connected: true, 'connected-at': '2026-11-23T10:05:00Z', setup: { ok: true, 'checked-at': '2026-11-23T10:09:00Z', home: '/home/u' } };

test('ASS-553 AC7: a stopped remote machine counts as available — the step is placed on it and waits; one that comes up within remote-boot-wait-seconds keeps it', async () => {
  const w = bootWorld(STOPPED);
  await w.phase(0);
  assert.deepEqual(w.where(), ['ABC-3 ada-dev workstation-worktree'], w.log());
  await w.phase(600);
  assert.deepEqual(w.where(), ['ABC-3 ada-dev workstation-worktree'], 'still waiting for it, within the 900 s default');
  w.setLive(UP);
  await w.phase(1200);
  assert.deepEqual(w.where(), ['ABC-3 ada-dev workstation-worktree'], w.log());
  assert.ok(!/did not come up/.test(w.log()), w.log());
});

test('ASS-553 AC7: a stopped remote machine that does not come up within remote-boot-wait-seconds — the step falls back to the Mac (logged), and the machine\'s seats come back once it is up', async () => {
  const w = bootWorld(STOPPED, { 'remote-boot-wait-seconds': 300 });
  await w.phase(0);
  assert.deepEqual(w.where(), ['ABC-3 ada-dev workstation-worktree']);
  await w.phase(299);
  assert.deepEqual(w.where(), ['ABC-3 ada-dev workstation-worktree']);
  await w.phase(301);
  assert.deepEqual(w.where(), ['ABC-3 mac local-worktree'], w.log());
  assert.ok(w.c.lines.includes('seats ada-dev did not come up within 300 s (remote-boot-wait-seconds) of a step being placed on it: its steps go to the next remote machine with room, else the Mac, until it is up; control goes on starting it'), w.log());
  assert.ok(w.c.lines.some(l => /^seats ABC-3 A: taken out of its workstation seat on ada-dev: ada-dev can't be used \(it did not come up within 300 s/.test(l)), w.log());
  await w.phase(400);
  assert.deepEqual(w.where(), ['ABC-3 mac local-worktree'], 'it stays on the Mac meanwhile');
  assert.equal(w.c.lines.filter(l => /did not come up within/.test(l) && /^seats ada-dev/.test(l)).length, 1, 'logged once');
  w.setLive(UP);
  await w.phase(500);
  assert.ok(w.c.lines.includes('seats ada-dev is up: its seats are back'), w.log());
});

test('ASS-553 AC7: an unusable remote machine (its setup failed, or its login expired) is skipped at once — the step goes to the Mac with no wait', async () => {
  for (const live of [{ state: 'running', connected: true, setup: { ok: false, error: 'no docker' } }, { connected: false, 'last-error': { at: '2026-11-23T09:00:00Z', kind: 'expired', message: 'login expired' } }]) {
    const w = bootWorld(live);
    await w.phase(0);
    assert.deepEqual(w.where(), ['ABC-3 mac local-worktree'], w.log());
    assert.ok(!/did not come up/.test(w.log()));
  }
});
