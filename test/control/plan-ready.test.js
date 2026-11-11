// ASS-362: a ticket that has finished planning — its top-level planning step's
// sub-engine at an is-done step (grouped Plan at done) — holds no planning seat
// and no in-progress one while it waits to move on to Build: it is ready for
// build, the next ticket may start planning, and the optional
// max-tickets-ready-for-build caps the queue. Anything else in planning keeps
// its seat as before (AC4). On the real engines: the example project's grouped
// one, grouped-plan and grouped-setup beneath it, and the flat ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatch, slotKind } from '../../src/control/plan.js';
import { statusIn, statusOf } from '../../src/control/engine.js';
import { loadEngines } from '../support/engine-walk.js';

const engines = loadEngines();
const ENGINE = 'example-development-grouped', engine = engines[ENGINE];
const at = (state, sub, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) }, 'state-changes': [], ...extra });
const kindOf = v => { const status = statusIn(engine, v, engines); return slotKind(status.step, status); };
const ticket = (key, ...variations) => ({ key, variations });
const plan = (ranked, harness = {}, extra = {}) => planDispatch({ ranked, engine, engines, harness, ...extra });
const seat = key => ({ key, variation: 'A' });
const PLANNED = ['grouped-plan', 'done'];

test('ASS-362 AC1: a variation at grouped-plan\'s done step takes no seat (slotKind null), and its status says it is planned', () => {
  const v = at('plan', PLANNED);
  assert.equal(kindOf(v), null);
  assert.equal(statusIn(engine, v, engines).planned, true);
  // It holds neither a planning seat nor an in-progress one: it is ready for build.
  const result = plan([ticket('T-1', v)], { 'max-tickets-in-planning': 1, 'max-tickets-in-progress': 1 });
  assert.deepEqual([result.inPlanning, result.reserved, result.waiting, result.ready], [[], [], [], [seat('T-1')]]);
  assert.deepEqual(result.free, { planning: true, progress: true });
});

test('ASS-362 AC1: the rule is generic — any planning step\'s sub-engine at an is-done step, with an exit out of planning', () => {
  const own = {
    top: { steps: [
      { id: 'think', sequence: 1, 'is-planning-stage': true, action: { type: 'state-engine', engine: 'sketch' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'make' }] },
      { id: 'make', sequence: 2, action: { type: 'prompt', prompt: 'make' } },
    ] },
    sketch: { steps: [
      { id: 'draw', sequence: 1, 'is-planning-stage': true, action: { type: 'prompt', prompt: 'draw' } },
      { id: 'finished', sequence: 2, 'is-done': true, action: { type: 'none' } },
    ] },
  };
  const status = sub => statusOf(own, 'top', { 'harness-status': { state: 'think', 'state-engine': 'top', 'sub-status': { state: sub, 'state-engine': 'sketch' } } });
  assert.equal(slotKind(status('finished').step, status('finished')), null);
  assert.equal(slotKind(status('draw').step, status('draw')), 'planning');
});

test('ASS-362 AC4: a done planning sub-step that goes on to more planning (grouped Setup\'s done, on to Plan) keeps its planning seat', () => {
  assert.equal(kindOf(at('setup', ['grouped-setup', 'done'])), 'planning');
});

test('ASS-362 AC4: planning not finished keeps its seat as today — any other Plan step, a plan sent back for revision, a gate on leaving Plan; Requirements Changed keeps its own', () => {
  for (const step of engines['grouped-plan'].steps.filter(s => s['is-done'] !== true)) assert.equal(kindOf(at('plan', ['grouped-plan', step.id])), 'planning', step.id);
  // Review Plan rejected it: back at Write Execution Plan, revising.
  const revising = at('plan', ['grouped-plan', 'write-execution-plan'], { 'state-changes': [{ 'from-state': 'plan', 'to-state': 'plan', 'sub-state-change': { 'state-engine': 'grouped-plan', 'from-state': 'review-plan', 'to-state': 'write-execution-plan' } }] });
  assert.equal(kindOf(revising), 'planning');
  // Gated on leaving Plan, its work there done: it waits on a person, and keeps the seat.
  const gated = at('plan', PLANNED, {
    'gate-when-leaving-state': [`${ENGINE}/plan`],
    'state-changes': [{ 'from-state': 'plan', 'to-state': 'plan', 'work-is-done': true, 'sub-state-change': { 'state-engine': 'grouped-plan', 'from-state': 'review-plan', 'to-state': 'done' } }],
  });
  assert.equal(kindOf(gated), 'planning');
  // Requirements Changed (a detour it returns from, follow-return-to-state) is no planning step: its own done is no finished plan, and takes what it took before (none).
  for (const sub of ['done', 'judge']) {
    const v = at('requirements-changed', ['grouped-requirements-changed', sub]);
    assert.deepEqual([statusIn(engine, v, engines).planned, kindOf(v)], [false, null], sub);
  }
});

test('ASS-362: no step of a flat engine is ever planned — their seats are as before', () => {
  for (const name of ['harness-development', 'blocked']) {
    for (const step of engines[name].steps) {
      const v = { 'harness-status': { state: step.id, 'state-engine': name } };
      assert.equal(statusOf(engines, name, v).planned, false, `${name}/${step.id}`);
    }
  }
});

test('ASS-362 AC2: with one planning seat and a finished plan waiting, the in-progress seats full, the next ticket in planning takes the seat and is dispatched', () => {
  const harness = { 'max-tickets-in-planning': 1, 'max-tickets-in-progress': 1 };
  const ranked = [ticket('T-1', at('build', ['grouped-build', 'generate-solution'])), ticket('T-2', at('plan', PLANNED)), ticket('T-3', at('plan', ['grouped-plan', 'enrich-ac']))];
  const result = plan(ranked, harness);
  assert.deepEqual([result.reserved, result.inPlanning, result.ready, result.waiting, result.held], [[seat('T-1')], [seat('T-3')], [seat('T-2')], [], []]);
});

test('ASS-362 AC3: the ready are listed in rank order, the queue for Build', () => {
  const ranked = [ticket('T-1', at('plan', PLANNED)), ticket('T-2', at('plan', ['grouped-plan', 'review-plan'])), ticket('T-3', at('plan', PLANNED))];
  assert.deepEqual(plan(ranked).ready, [seat('T-1'), seat('T-3')]);
});

test('ASS-362 AC5: max-tickets-ready-for-build, unset by default, caps the ready and those still planning: reached, no ticket may enter planning', () => {
  const ranked = [ticket('T-1', at('plan', PLANNED)), ticket('T-2', at('plan', ['grouped-plan', 'enrich-ac'])), ticket('T-3', at('committed'))];
  assert.deepEqual([plan(ranked).readyFull, plan(ranked).free.planning], [false, true]);   // no limit
  assert.deepEqual([plan(ranked, {}, { project: { 'max-tickets-ready-for-build': 3 } }).readyFull, plan(ranked, {}, { project: { 'max-tickets-ready-for-build': 3 } }).free.planning], [false, true]);
  for (const limits of [{ project: { 'max-tickets-ready-for-build': 2 } }, { harness: { 'max-tickets-ready-for-build': 2 } }]) {
    const result = plan(ranked, limits.harness ?? {}, { project: limits.project ?? {} });
    assert.deepEqual([result.readyFull, result.free.planning, result.free.progress], [true, false, true], JSON.stringify(limits));
  }
  // harness.json's counts every project's: others' ready and planning too.
  const alone = [ticket('T-1', at('plan', PLANNED)), ticket('T-3', at('committed'))];
  assert.equal(plan(alone, { 'max-tickets-ready-for-build': 3 }).free.planning, true);
  assert.equal(plan(alone, { 'max-tickets-ready-for-build': 3 }, { readyElsewhere: 1, planningElsewhere: 1 }).free.planning, false);
  // The cap keeps no one already in planning from its seat, nor from its agent.
  const capped = plan([ticket('T-2', at('plan', ['grouped-plan', 'enrich-ac']))], {}, { project: { 'max-tickets-ready-for-build': 0 } });
  assert.deepEqual([capped.inPlanning, capped.held], [[seat('T-2')], []]);
});
