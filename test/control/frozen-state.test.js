// ASS-565: control's loaded state is deep-frozen (read.js deepFreeze, ASS-548's read cache), so nothing in control may
// write onto it. run-target-places.js readyTarget did (`variation['run-target'] = …` after code:hand-over), and every
// step moving onto or off a Mac worktree or a Substrate sandbox was held with "Cannot add property run-target, object is
// not extensible". AC1: readyTarget hands a frozen variation over and returns its target. AC2: for the rest of the tick
// the new target is seen by everything that reads it (machine.js runTargetOf: machineOf, sandboxes.js's stop,
// vm-lifecycle.js's idle VM), and a fresh load reads the disk's record alone. AC3: whole ticks over a fixture project
// on local-worktree and local-substrate — the state as loadState really loads it, frozen — take a ticket from a Mac
// worktree to a sandbox and back to done, with no "not extensible" anywhere — and each step where its own targets say
// (run-target-places.js heldElsewhere: a step moved on after the tick's seats were placed waits one tick for its own). AC4: the audit's other paths over frozen
// state — the planner and seat placement with frozen seat records, superviseSandboxes, the VM lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deepFreeze } from '../../src/control/read.js';
import { readyTarget, heldElsewhere } from '../../src/control/run-target-places.js';
import { machineOf, runTargetOf } from '../../src/control/machine.js';
import { superviseSandboxes } from '../../src/control/sandboxes.js';
import { placeSeats } from '../../src/control/seat-kinds.js';
import { planDispatch } from '../../src/control/plan.js';
import { projectRunTargets } from '../../src/control/run-targets.js';
import { tick } from '../../src/control/tick.js';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { until } from '../support/until.js';

const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const sandbox = { name: 'abc-3-a', project: 'p', machine: 'mac', state: 'running' };

// A bare control context: ctx.cli answers code:hand-over as the command does (its JSON), recording each call.
function bareCtx() {
  const calls = [], lines = [];
  const ctx = {
    memory: { warned: new Set(), backoff: new Map() }, calls, lines,
    attempt: async (phase, what, fn) => { try { await fn(); } catch (error) { lines.push(`error ${phase} ${what}: ${error.message}`); } },
    now: () => new Date('2026-11-23T12:00:00Z'),
    log: (phase, text) => lines.push(`${phase} ${text}`),
    cli: async args => { calls.push(args.join(' ')); return args[0] === 'code:hand-over' ? `${JSON.stringify({ branch: 'change/ABC-3.A-1', folder: null })}\n` : '{}\n'; },
  };
  return ctx;
}
// frozenProject(variation, seats) — a project over one ticket, the ticket and its seat records frozen as loadState
// leaves them (the project object itself is built afresh each load, so not frozen).
const frozenProject = (variation, { seats = [], localSeats = [] } = {}) => {
  const t = deepFreeze({ key: 'ABC-3', variations: [variation] });
  return { project: { id: 'p', tickets: [t], seats: deepFreeze(seats), localSeats: deepFreeze(localSeats) }, t, v: t.variations[0] };
};

test('AC1: readyTarget hands a deep-frozen variation over — onto a Mac worktree, onto a sandbox, back off it — and returns the target, never throwing', async () => {
  for (const [from, target, seats] of [
    [null, 'local-worktree', { localSeats: [{ key: 'ABC-3', variation: 'A', target: 'local-worktree' }] }],
    ['local-worktree', 'local-substrate', { seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] }],
    ['local-substrate', 'local-worktree', { localSeats: [{ key: 'ABC-3', variation: 'A', target: 'local-worktree' }] }],
    ['local-substrate', 'local-vm', { seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-vm' }] }],
    ['local-vm', 'local-workspace', { localSeats: [{ key: 'ABC-3', variation: 'A', target: 'local-workspace' }] }],
  ]) {
    const ctx = bareCtx();
    const { project, t, v } = frozenProject(at('build', { sandbox, ...(from ? { 'run-target': { target: from, at: 'x' } } : {}) }), seats);
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.sandbox), 'the variation is frozen as loadState leaves it');
    assert.equal(await readyTarget(ctx, project, t, v), target, `${from} → ${target}`);
    assert.deepEqual(ctx.calls, [`code:hand-over p ABC-3 A ${target}`]);
    assert.equal(v['run-target']?.target ?? null, from, 'the loaded variation is left as it was loaded');
    assert.doesNotMatch(ctx.lines.join('\n'), /not extensible|read only|read-only/);
  }
});

test('AC2: within the tick the handed-over target is seen — machineOf names the sandbox, readyTarget does not hand over again, superviseSandboxes stops a sandbox its branch has left — and a fresh load reads the disk alone', async () => {
  const ctx = bareCtx();
  // Onto the sandbox: machineOf (no target given, as finish.js and supervise.js call it) names the sandbox at once.
  const on = frozenProject(at('build', { sandbox, vm: { name: 'abc-3-a' }, 'run-target': { target: 'local-vm', at: 'x' } }), { seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] });
  assert.equal(machineOf(on.v), 'abc-3-a', 'before: its VM, as its loaded run-target says');
  await readyTarget(ctx, on.project, on.t, on.v);
  assert.equal(runTargetOf(on.v).target, 'local-substrate');
  assert.equal(machineOf(on.v), 'substrate:p:mac:abc-3-a');
  assert.equal(await readyTarget(ctx, on.project, on.t, on.v), 'local-substrate');
  assert.equal(ctx.calls.length, 1, 'handed over once this tick, not again by the next step that asks');
  // Onto a Mac worktree: the worktree folder is in the file code:hand-over wrote, not this load — still not handed over twice.
  const wt = frozenProject(at('plan'), { localSeats: [{ key: 'ABC-3', variation: 'A', target: 'local-worktree' }] });
  await readyTarget(ctx, wt.project, wt.t, wt.v);
  await readyTarget(ctx, wt.project, wt.t, wt.v);
  assert.deepEqual(ctx.calls.slice(1), ['code:hand-over p ABC-3 A local-worktree']);
  // Off the sandbox onto a worktree: superviseSandboxes (its own reader of the run-target) hibernates it in the same tick.
  const off = frozenProject(at('review', { sandbox, 'run-target': { target: 'local-substrate', at: 'x' } }), { localSeats: [{ key: 'ABC-3', variation: 'A', target: 'local-worktree' }] });
  off.project.engine = deepFreeze({ steps: [{ id: 'review', 'run-location': 'vm', action: { type: 'script', command: 'x' } }, { id: 'done', 'is-done': true, action: { type: 'none' } }] });
  const state = { projects: [off.project], assignments: deepFreeze([]) };
  ctx.calls.length = 0;
  superviseSandboxes(ctx, state);
  for (const j of ctx.memory.sandboxJobs?.values() ?? []) await j;
  assert.deepEqual(ctx.calls, [], 'its branch still on the sandbox: kept running');
  await readyTarget(ctx, off.project, off.t, off.v);
  ctx.memory.sandboxes?.clear();
  superviseSandboxes(ctx, state);
  for (const j of ctx.memory.sandboxJobs?.values() ?? []) await j;
  assert.deepEqual(ctx.calls, ['code:hand-over p ABC-3 A local-worktree', 'substrate:sandbox-stop p ABC-3 A']);
  assert.doesNotMatch(ctx.lines.join('\n'), /not extensible/);
  // A new parse (the sprint file rewritten by code:hand-over) is a new object: what it records, nothing noted.
  const fresh = deepFreeze(at('build', { sandbox, 'run-target': { target: 'local-vm', at: 'y' } }));
  assert.equal(runTargetOf(fresh).target, 'local-vm');
  assert.equal(runTargetOf(null), null);
});

test('AC4: the planner and seat placement over frozen seat records and tickets move a seat between kinds without writing onto them', () => {
  const rt = projectRunTargets({ name: 'p', 'dev-environments': { 'run-targets': ['local-substrate', 'local-worktree'], substrate: { clusters: [{ machine: 'mac' }] } } });
  const engine = deepFreeze({ steps: [{ id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
    { id: 'plan', sequence: 2, 'run-location': 'vm', 'is-planning-stage': true, worktree: true, action: { type: 'prompt', prompt: 'p' } },
    { id: 'build', sequence: 3, 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' } },
    { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] });
  const ranked = deepFreeze([{ key: 'T-1', variations: [at('build')] }, { key: 'T-2', variations: [at('plan')] }]);
  const p = planDispatch({ ranked, engine, harness: deepFreeze({ 'max-agents': null }), seats: { mac: 2, remote: 0, byKind: {} }, runTargets: rt });
  assert.deepEqual(p.targets.map(t => [t.key, t.target]), [['T-1', 'local-substrate'], ['T-2', 'local-worktree']]);
  const records = deepFreeze([{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation', since: 'a' }]);
  const capacity = { mode: 'vm+workstation', vm: 1, workstations: [{ id: 'ws-1', seats: 1, lost: null }], remote: 1 };
  const placed = placeSeats({ records, reserved: [{ key: 'T-1', variation: 'A' }], capacity, targetFor: () => ({ target: 'local-substrate', candidates: ['local-substrate'] }), now: 'b' });
  assert.deepEqual(placed.records.map(r => [r.kind, r.target, r.workstation ?? null]), [['vm', 'local-substrate', null]]);
  assert.equal(records[0].kind, 'workstation', 'the loaded record untouched');
});

test('AC3: a step moved on later in the tick its seats were placed waits one tick when its seat still names a target it cannot run on, or none unless it is planned onto a plain machine after one (ASS-567)', () => {
  const planned = target => ({ targets: [{ key: 'ABC-3', variation: 'A', target, candidates: [target] }] });
  const onSandbox = { seats: deepFreeze([{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }]) };
  const onWorktree = { localSeats: deepFreeze([{ key: 'ABC-3', variation: 'A', target: 'local-worktree' }]) };
  assert.equal(heldElsewhere(onSandbox, 'ABC-3', 'A', planned('local-worktree')), true, 'review still on build\'s sandbox seat');
  assert.equal(heldElsewhere(onWorktree, 'ABC-3', 'A', planned('local-substrate')), true, 'build still on plan\'s worktree');
  assert.equal(heldElsewhere(onSandbox, 'ABC-3', 'A', planned('local-substrate')), false);
  const last = target => ({ tickets: deepFreeze([{ key: 'ABC-3', variations: [at('review', target ? { 'run-target': { target } } : {})] }]) });
  assert.equal(heldElsewhere(last('local-substrate'), 'ABC-3', 'A', planned('local-worktree')), true, 'no record yet, planned onto the Mac, last on the sandbox');
  assert.equal(heldElsewhere(last('local-worktree'), 'ABC-3', 'A', planned('local-substrate')), true, 'no record yet, planned onto a sandbox, last on the worktree');
  // ASS-567: with no record, everything that starts the step reads its place from what it last ran on (a sandbox's
  // run-target, else its VM): only a plain machine target planned after a plain machine (or nothing) goes on.
  assert.equal(heldElsewhere(last('local-worktree'), 'ABC-3', 'A', planned('local-worktree')), true, 'no record yet: dispatch would read its VM, not the worktree');
  assert.equal(heldElsewhere(last(null), 'ABC-3', 'A', planned('local-worktree')), true, 'never handed over, no record: placed next tick');
  assert.equal(heldElsewhere(last('local-substrate'), 'ABC-3', 'A', planned('local-vm')), true, 'no record yet, a VM after the sandbox: its machine would be read as the sandbox');
  assert.equal(heldElsewhere(last(null), 'ABC-3', 'A', planned('local-vm')), false, 'no record yet, a VM, never elsewhere: as before');
  assert.equal(heldElsewhere(last('local-vm'), 'ABC-3', 'A', planned('local-vm')), false, 'no record yet, back on the VM it was handed over to: as before');
  assert.equal(heldElsewhere(last('workstation'), 'ABC-3', 'A', planned('local-vm')), true, 'no record yet, last handed over to a workstation: placed first');
  assert.equal(heldElsewhere(onSandbox, 'ABC-3', 'A', { targets: [] }), false, 'not planned: as before');
});

// The tick-level test (AC3). The fixture's project p on local-worktree and local-substrate (a Mac cluster declared), its
// engine committed → plan (worktree) → build (sandbox) → review (worktree) → done, each a script that works in the
// ticket's machine (`true`). The Substrate and git commands are faked as the commands behave — code:hand-over writes
// the variation's run-target (and, onto local-worktree, its worktree folder) into the sprint file, substrate:sandbox-up
// its `sandbox` — and a script run in a sandbox exits 0; everything else is the real agent.sh, and the state each phase
// works on is loadState's, deep-frozen.
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const script = (id, sequence, targets, to, extra = {}) => ({ id, sequence, 'run-location': 'vm', 'run-targets': targets, action: { type: 'script', command: 'true' }, 'exit-events': [...ok(to), { condition: { not: { 'exit-code': 0 } }, 'move-to-state': id }], ...extra });
// An AI step (the fixture's fake agent), dispatched with this tick's seats: on a Mac worktree it runs on the host.
const prompt = (id, sequence, targets, to, extra = {}) => ({ id, sequence, 'run-location': 'vm', 'run-targets': targets, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': to }], ...extra });
const STEPS = [
  { id: 'committed', sequence: 2, 'is-planning-stage': true, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'plan' }] },
  prompt('plan', 3, ['local-worktree'], 'build', { 'is-planning-stage': true }),
  script('build', 4, ['local-substrate'], 'built'),
  // A host check between (no seat): the move on to review is read in a later tick, whose seats are placed for review —
  // a move made by runSteps is dispatched in the same tick on the seats placed before it (see the change notes).
  { id: 'built', sequence: 5, action: { type: 'none' }, 'exit-events': [{ condition: { 'script-succeeds': 'true' }, 'move-to-state': 'review' }] },
  prompt('review', 6, ['local-worktree'], 'done'),
  { id: 'done', sequence: 7, 'is-done': true, action: { type: 'none' } },
];

test('AC3: whole ticks with frozen loaded state move a ticket from a Mac worktree to a Substrate sandbox and back, handing its branch over each time, with no "not extensible" error', { timeout: 120_000 /* hang guard: the ticks themselves are awaited */ }, async () => {
  const f = controlFixture();
  const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
  const dir = join(f.dir, 'projects', 'p'), sprintFile = join(dir, 'sprints', 'sprint-10', 'sprint.json');
  f.seats(4);
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = [e.steps.find(s => s.id === 'blocked'), ...STEPS]; });
  edit(join(dir, 'project.json'), p => { p['dev-environments'] = { 'run-targets': ['local-worktree', 'local-substrate'], substrate: { clusters: [{ machine: 'mac' }] } }; });
  edit(sprintFile, s => { s.features[0].variations[0]['harness-status'] = hs('committed'); });
  const variationOnDisk = change => edit(sprintFile, s => change(s.features[0].variations[0]));
  const real = f.ctx.cli, realScript = f.ctx.script, handOvers = [], sandboxCalls = [];
  f.ctx.cli = async (args, env) => {
    const [command, , , , target] = args;
    if (command === 'code:hand-over') {
      handOvers.push(target);
      const folder = join(f.dir, 'worktrees', 'ABC-3');
      variationOnDisk(v => {
        v['run-target'] = { target, at: new Date().toISOString() };
        if (target === 'local-worktree') { mkdirSync(folder, { recursive: true }); v.build = { ...v.build, 'worktree-folder': folder, 'worktree-by': 'run-target' }; }
      });
      return `${JSON.stringify({ branch: 'change/ABC-3.A-1', folder: target === 'local-worktree' ? folder : null })}\n`;
    }
    if (command === 'substrate:sandbox-up') {
      sandboxCalls.push(args.join(' '));
      variationOnDisk(v => { v.sandbox = { name: 'abc-3-a', project: 'p', machine: 'mac', template: 't', image: 'sha256:d', state: 'running' }; });
      return `${JSON.stringify({ name: 'abc-3-a', machine: 'substrate:p:mac:abc-3-a', host: 'mac', created: true, branches: [] })}\n`;
    }
    if (command === 'substrate:sandbox-stop') { sandboxCalls.push(args.join(' ')); variationOnDisk(v => { v.sandbox = { ...v.sandbox, state: 'stopped' }; }); return '{"stopped":true}\n'; }
    if (command === 'substrate:sandbox-delete') { sandboxCalls.push(args.join(' ')); variationOnDisk(v => { delete v.sandbox; }); return '{"deleted":true,"branches":[]}\n'; }
    if (command === 'substrate:stack-up') return '{"stack":false}\n';
    if (command.startsWith('substrate:') || command === 'code:remove-worktree') return '{}\n';
    return real(args, env);
  };
  f.ctx.succeeds = () => Promise.resolve(true);   // built's host check: its answer read by the next tick
  f.ctx.script = (argv, vm, env) => (String(vm ?? '').startsWith('substrate:') ? Promise.resolve({ exitCode: 0, stdout: '' }) : realScript(argv, vm, env));
  // A clock a minute on per tick, past any step's backoff (a step tried before its seat placed it is held 30 s).
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  const states = [];
  for (let i = 0; i < 40; i++) {
    clock += 60_000;
    await tick(f.ctx);
    await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited));   // its fake agent's turn over before the next tick
    const state = f.variation()['harness-status'].state;
    if (states.at(-1) !== state) states.push(state);
    if (state === 'done') break;
  }
  const log = f.lines.join('\n');
  assert.doesNotMatch(log, /not extensible|Cannot add property|Cannot assign to read only/, log);
  assert.deepEqual(states.filter(s => ['plan', 'build', 'review', 'done'].includes(s)), ['plan', 'build', 'review', 'done'], `${states.join(' → ')}\n${log}`);
  assert.deepEqual(handOvers, ['local-worktree', 'local-substrate', 'local-worktree'], log);
  assert.ok(sandboxCalls.includes('substrate:sandbox-up p ABC-3 A mac'), sandboxCalls.join('; '));
  assert.match(log, /handed over from local-worktree to local-substrate/);
  assert.match(log, /handed over from local-substrate to local-worktree/);
  // Each step ran where its own targets say, never on the seat the step before it held that tick (heldElsewhere).
  assert.match(log, /dispatch \S+ \([^)]*\) on ABC-3 A review, pid \d+, in \S+\/worktrees\/ABC-3, in Claude Code's sandbox/);
  assert.doesNotMatch(log, /on ABC-3 A review, pid \d+, in \/repos\//, 'review never dispatched into the sandbox');
});
