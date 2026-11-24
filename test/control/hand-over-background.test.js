// ASS-585: a hand-over (code:hand-over) runs in the background, as a script step's command does (ASS-494). Awaited in
// line it held the whole tick of its project (`slow tick … cli code:hand-over 25472ms`). AC1: one that takes longer
// than a tick leaves the tick free — another ticket's step and dispatch go on in that same tick. AC2: the variation's
// step starts only once its hand-over has finished and succeeded; a failed one holds the step with backoff and is tried
// again. AC3: never two hand-overs of the same variation at once. (AC4: frozen-state, target-moves and hand-over-vm
// tests, unchanged, still pass.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readyTarget, HANDING_OVER } from '../../src/control/run-target-places.js';
import { runTargetOf } from '../../src/control/machine.js';
import { deepFreeze } from '../../src/control/read.js';
import { tick } from '../../src/control/tick.js';
import { timeHere } from '../../src/control/tick-stats.js';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { until } from '../support/until.js';

// A hand-over the test ends when it chooses: `release()` succeeds it, `fail(message)` fails it.
function slowHandOver() {
  let release, fail;
  const done = new Promise((resolve, reject) => { release = resolve; fail = message => reject(new Error(message)); });
  return { done, release: () => release(), fail };
}

// The tick-level fixture: project p on local-worktree alone (no seat, no VM: the steps run on the Mac), its engine
// build (a script) → review (an AI step) → done. ABC-3 A is at build, last run on local-vm: its build needs a hand-over
// onto the worktree. ABC-4 A is at review, already in its worktree: nothing to hand over. code:hand-over is faked:
// each call waits for the test (`pending`), then writes the variation's run-target and worktree as the command does.
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const STEPS = [
  { id: 'build', sequence: 4, 'run-location': 'vm', 'run-targets': ['local-worktree'], action: { type: 'script', command: './agent.sh ticket:set-paused {project} {ticket} {variation} false' }, 'exit-events': [...ok('review'), { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'build' }] },
  { id: 'review', sequence: 6, 'run-location': 'vm', 'run-targets': ['local-worktree'], action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
  { id: 'done', sequence: 7, 'is-done': true, action: { type: 'none' } },
];
function twoTickets() {
  const f = controlFixture();
  const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
  const dir = join(f.dir, 'projects', 'p'), sprintFile = join(dir, 'sprints', 'sprint-10', 'sprint.json');
  const worktree = key => { const folder = join(f.dir, 'worktrees', key); mkdirSync(folder, { recursive: true }); return folder; };
  f.seats(4);
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = [e.steps.find(s => s.id === 'blocked'), ...STEPS]; });
  edit(join(dir, 'project.json'), p => { p['dev-environments'] = { 'run-targets': ['local-worktree'] }; });
  edit(sprintFile, s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0] = { ...s.features[0].variations[0], 'harness-status': hs('build'), 'run-target': { target: 'local-vm', at: '2026-11-24T00:00:00Z' } };
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': hs('review'), 'state-changes': [],
      'run-target': { target: 'local-worktree', at: '2026-11-24T00:00:00Z' }, build: { 'worktree-folder': worktree('ABC-4'), 'worktree-by': 'run-target' } }] });
  });
  const handOvers = [], pending = [];
  const real = f.ctx.cli;
  // Timed as tick.js times ctx.cli (timeHere), so the test sees whether the hand-over lands in the tick's timings.
  f.ctx.cli = (args, env) => timeHere(f.ctx.tickTimes, `cli ${args[0]}`, () => fake(args, env));
  const fake = async (args, env) => {
    if (args[0] !== 'code:hand-over') return real(args, env);
    const [, , key, name, target] = args;
    handOvers.push(`${key} ${name} ${target}`);
    const slow = slowHandOver();
    pending.push(slow);
    await slow.done;
    const folder = worktree(key);
    edit(sprintFile, s => {
      const v = s.features.find(t => t.key === key).variations.find(x => x.name === name);
      v['run-target'] = { target, at: new Date().toISOString() };
      v.build = { ...v.build, 'worktree-folder': folder, 'worktree-by': 'run-target' };
    });
    return `${JSON.stringify({ from: 'local-vm', to: target, branch: `change/${key}.${name}-1`, folder })}\n`;
  };
  f.ctx.handOverWait = 20;   // the short wait in the tick that starts it: these hand-overs outlast it
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  const state = key => f.sprint().features.find(t => t.key === key).variations[0]['harness-status'].state;
  const ended = () => [...(f.ctx.memory.handOvers?.values() ?? [])].every(e => e.ended);
  const next = async (ms = 60_000) => { clock += ms; await tick(f.ctx); };
  return { f, handOvers, pending, state, ended, next, buildRan: () => f.lines.filter(l => /^script .*ticket:set-paused p ABC-3 A false/.test(l)).length };
}

test('AC1, AC3: a hand-over longer than a tick does not block it — another ticket is dispatched in that same tick — and is never started twice while it runs', { timeout: 120_000 /* hang guard: the ticks themselves are awaited */ }, async () => {
  const { f, handOvers, pending, state, next, buildRan } = twoTickets();
  await next();   // returns although ABC-3's hand-over has not ended
  const log = () => f.lines.join('\n');
  assert.deepEqual(handOvers, ['ABC-3 A local-worktree'], log());
  assert.match(log(), /dispatch \S+ \([^)]*\) on ABC-4 A review, pid \d+/, 'the other ticket dispatched in the same tick');
  assert.match(log(), /ABC-3 A: waiting for its hand-over to local-worktree; its step starts once it has succeeded/);
  assert.equal(buildRan(), 0, 'ABC-3\'s build not started while its hand-over runs');
  assert.equal(state('ABC-3'), 'build');
  // The tick's timings do not include it (started untimed).
  // The tick's timings never include it (started untimed): checked on that tick's times once it has ended, below.
  const firstTick = f.ctx.tickTimes;
  assert.ok(Object.keys(firstTick.subs).some(k => /\/cli /.test(k)), `other calls are timed: ${Object.keys(firstTick.subs).join(', ')}`);
  // Later ticks while it runs: no second hand-over of ABC-3 A (AC3), the wait said once, nothing started.
  await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited));
  await next();
  await next();
  assert.deepEqual(handOvers, ['ABC-3 A local-worktree'], 'one at a time');
  assert.equal(f.lines.filter(l => /ABC-3 A: waiting for its hand-over/.test(l)).length, 1, 'said once');
  assert.equal(buildRan(), 0);
  // It ends: its duration logged, and the next tick starts the step (AC2) and moves it on.
  pending[0].release();
  await until(() => f.lines.some(l => /ABC-3 A: handed over from local-vm to local-worktree \(change\/ABC-3\.A-1 in \S+\) in \d+s/.test(l)));
  for (const times of [firstTick, f.ctx.tickTimes]) assert.ok(!Object.keys(times.subs).some(k => /code:hand-over/.test(k)), Object.keys(times.subs).join(', '));
  await next();
  assert.equal(buildRan(), 1, log());
  await until(() => state('ABC-3') !== 'build' || f.lines.some(l => /script still running/.test(l)));
  for (let i = 0; i < 3 && state('ABC-3') === 'build'; i++) await next();
  assert.equal(state('ABC-3'), 'review', log());
  assert.deepEqual(handOvers, ['ABC-3 A local-worktree'], 'not handed over again once there');
});

test('AC2: a failed background hand-over holds the step with backoff — nothing started — and is tried again after it; the step starts only once one succeeds', { timeout: 120_000 /* hang guard */ }, async () => {
  const { f, handOvers, pending, state, ended, next, buildRan } = twoTickets();
  await next();
  assert.deepEqual(handOvers, ['ABC-3 A local-worktree']);
  pending[0].fail('relay: the forge refused the push');
  await until(ended);
  assert.match(f.lines.join('\n'), /ABC-3 A: hand-over to local-worktree failed after \d+s/);
  await next(1_000);   // its failure read: the step held with backoff
  assert.match(f.lines.join('\n'), /ABC-3 A build: could not hand its branch over to its run target: relay: the forge refused the push; tried again in \d+s/);
  assert.ok([...f.ctx.memory.backoff.keys()].some(k => k.includes('ABC-3')), 'backoff recorded');
  assert.equal(buildRan(), 0);
  await next(1_000);   // still within its backoff: not tried again
  assert.equal(handOvers.length, 1);
  await next();        // past it: a new hand-over
  assert.equal(handOvers.length, 2, f.lines.join('\n'));
  assert.equal(buildRan(), 0, 'not started while the retry runs');
  pending[1].release();
  await until(ended);
  await next();
  assert.equal(buildRan(), 1, f.lines.join('\n'));
  for (let i = 0; i < 3 && state('ABC-3') === 'build'; i++) await next();
  assert.equal(state('ABC-3'), 'review');
});

// Unit level, on a frozen variation as loadState leaves it.
function bareCtx() {
  const calls = [], lines = [], pending = [];
  const ctx = {
    memory: { warned: new Set(), backoff: new Map() }, calls, lines, pending, handOverWait: 10,
    now: () => new Date('2026-11-24T12:00:00Z'),
    log: (phase, text) => lines.push(`${phase} ${text}`),
    cli: async args => { calls.push(args.join(' ')); const slow = slowHandOver(); pending.push(slow); await slow.done; return `${JSON.stringify({ branch: 'change/ABC-3.A-1', folder: null })}\n`; },
  };
  return ctx;
}
const onTarget = (target, from = 'local-worktree') => {
  const t = deepFreeze({ key: 'ABC-3', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' }, 'run-target': { target: from, at: 'x' } }] });
  return { project: { id: 'p', tickets: [t], seats: deepFreeze([{ key: 'ABC-3', variation: 'A', kind: 'vm', target }]), localSeats: [] }, t, v: t.variations[0] };
};

test('AC3: concurrent asks for the same variation start one hand-over; a target changed meanwhile waits for it to end before its own starts', async () => {
  const ctx = bareCtx();
  const a = onTarget('local-substrate');
  const asks = await Promise.all([readyTarget(ctx, a.project, a.t, a.v), readyTarget(ctx, a.project, a.t, a.v), readyTarget(ctx, a.project, a.t, a.v)]);
  assert.deepEqual(asks, [HANDING_OVER, HANDING_OVER, HANDING_OVER]);
  assert.deepEqual(ctx.calls, ['code:hand-over p ABC-3 A local-substrate']);
  // The planner moves it elsewhere meanwhile (a new load, a new seat): still one at a time.
  const b = onTarget('local-vm');
  assert.equal(await readyTarget(ctx, b.project, b.t, b.v), HANDING_OVER);
  assert.equal(ctx.calls.length, 1, 'no second hand-over while the first runs');
  assert.match(ctx.lines.join('\n'), /waiting for its hand-over to local-substrate to end before handing over to local-vm/);
  ctx.pending[0].release();
  await until(() => ctx.memory.handOvers.get('p/ABC-3/A').ended);
  // Its result was for a target the variation has left: forgotten, and the one it needs now started.
  assert.equal(await readyTarget(ctx, b.project, b.t, b.v), HANDING_OVER);
  assert.deepEqual(ctx.calls, ['code:hand-over p ABC-3 A local-substrate', 'code:hand-over p ABC-3 A local-vm']);
});

test('AC2: readyTarget answers HANDING_OVER while it runs, the target (noted on the variation) once it succeeded, and throws once, then starts afresh, when it failed', async () => {
  const ctx = bareCtx();
  const { project, t, v } = onTarget('local-substrate');
  assert.equal(await readyTarget(ctx, project, t, v), HANDING_OVER);
  assert.equal(await readyTarget(ctx, project, t, v), HANDING_OVER);
  ctx.pending[0].release();
  await until(() => ctx.memory.handOvers.get('p/ABC-3/A').ended);
  assert.equal(await readyTarget(ctx, project, t, v), 'local-substrate');
  assert.equal(runTargetOf(v).target, 'local-substrate', 'noted for the rest of the tick (ASS-565)');
  assert.equal(await readyTarget(ctx, project, t, v), 'local-substrate', 'there now: nothing more to do');
  assert.equal(ctx.calls.length, 1);

  const failing = bareCtx(), f = onTarget('local-substrate');
  assert.equal(await readyTarget(failing, f.project, f.t, f.v), HANDING_OVER);
  failing.pending[0].fail('no route to the forge');
  await until(() => failing.memory.handOvers.get('p/ABC-3/A').ended);
  await assert.rejects(readyTarget(failing, f.project, f.t, f.v), /no route to the forge/);
  assert.equal(runTargetOf(f.v).target, 'local-worktree', 'a failed one notes nothing');
  assert.equal(await readyTarget(failing, f.project, f.t, f.v), HANDING_OVER, 'asked again (after its backoff): tried again');
  assert.equal(failing.calls.length, 2);
});

test('a quick hand-over is read in the tick that started it: the step goes on at once, as when it was awaited', async () => {
  const ctx = { ...bareCtx(), handOverWait: 5_000 };
  ctx.cli = async args => { ctx.calls.push(args.join(' ')); return `${JSON.stringify({ branch: 'change/ABC-3.A-1', folder: null })}\n`; };
  const { project, t, v } = onTarget('local-substrate');
  const started = Date.now();
  assert.equal(await readyTarget(ctx, project, t, v), 'local-substrate');
  assert.ok(Date.now() - started < 4_000, 'not held for the whole wait');
  assert.match(ctx.lines.join('\n'), /ABC-3 A: handed over from local-worktree to local-substrate \(change\/ABC-3\.A-1\) in \d+s/);
});
