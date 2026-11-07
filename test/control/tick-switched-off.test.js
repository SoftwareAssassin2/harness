// ASS-192: a step switched off ("is-active": false) is passed at once by the
// move-to-state of its first exit — a prompt step dispatches no agent, a
// human step waits for no human, a gate on it holds nothing — at the top level
// and inside a sub-engine's run; each pass logged and recorded in the
// ticket's history with cause "skipped", reason "switched off".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { runSteps } from '../../src/control/steps.js';
import { planFor } from '../../src/control/plan.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const to = (target, condition = { 'turn-complete': true }) => ({ condition, 'move-to-state': target });

// start → write (a prompt, off) → ask (a human step, off) → check (the gate
// engine) → done; gate's run: begin → think (a prompt, off) → sign (a human
// step, off) → end. One ticket, T-1 A, at write, gated on leaving ask and the
// run's sign.
function switchedOff(off = { 'is-active': false }) {
  const f = controlFixture();
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, { 'max-tickets-in-progress': null, 'max-tickets-in-planning': null }));
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = [
    { id: 'start', sequence: 1, action: { type: 'none' }, 'exit-events': [to('write', { always: true })] },
    { id: 'write', sequence: 2, ...off, action: { type: 'prompt', prompt: 'test' }, 'exit-events': [to('ask')] },
    { id: 'ask', sequence: 3, ...off, action: { type: 'human' }, 'exit-events': [to('check', { 'human-review': 'Approved' }), to('write', { 'human-review': 'Rejected' })] },
    { id: 'check', sequence: 4, action: { type: 'state-engine', engine: 'gate' }, 'exit-events': [to('done', { 'is-done': true })] },
    { id: 'done', sequence: 5, 'is-done': true, action: { type: 'none' } },
  ]; });
  mkdirSync(join(f.dir, 'engines', 'gate'));
  writeFileSync(join(f.dir, 'engines', 'gate', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'begin', sequence: 1, action: { type: 'none' }, 'exit-events': [to('think', { always: true })] },
    { id: 'think', sequence: 2, ...off, action: { type: 'prompt', prompt: 'test' }, 'exit-events': [to('sign')] },
    { id: 'sign', sequence: 3, ...off, action: { type: 'human' }, 'exit-events': [to('end', { 'human-review': 'Approved' })] },
    { id: 'end', sequence: 4, 'is-done': true, action: { type: 'none' } },
  ] }));
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features = [{ key: 'T-1', variations: [{ name: 'A', 'harness-status': hs('write'), 'state-changes': [], 'gate-when-leaving-state': ['example-development/ask', 'gate/sign'] }] }];
  });
  return { ...f, v: () => f.sprint().features[0].variations[0] };
}

test('ASS-192 AC1: a ticket at a switched-off prompt step is dispatched no agent', () => {
  const f = switchedOff();
  const state = f.ctx.load();
  assert.deepEqual(planFor(state, state.projects[0]).dispatch, []);
});

test('ASS-192 AC1, AC5: switched-off prompt, human and gated steps pass at once by their first exit, at the top level and inside a sub-engine; each pass logged and recorded as skipped (switched off)', async () => {
  const f = switchedOff();
  await runSteps(f.ctx, f.ctx.load());                                  // write → ask → check, its gate run started
  assert.equal(f.v()['harness-status'].state, 'check');
  await runSteps(f.ctx, f.ctx.load());                                  // the run: begin → think → sign → end
  await runSteps(f.ctx, f.ctx.load());                                  // its run done: check → done
  assert.equal(f.v()['harness-status'].state, 'done');
  const changes = f.v()['state-changes'];
  const top = changes.filter(c => !c['sub-state-change']).map(c => [c['from-state'], c['to-state'], c.cause ?? null, c.reason ?? null]);
  assert.deepEqual(top, [['write', 'ask', 'skipped', 'switched off'], ['ask', 'check', 'skipped', 'switched off'], ['check', 'done', null, null]]);
  const sub = changes.filter(c => c['sub-state-change']).map(c => [c['sub-state-change']['from-state'], c['sub-state-change']['to-state'], c.cause ?? null, c.reason ?? null]);
  assert.deepEqual(sub.filter(([from]) => from != null), [['begin', 'think', null, null], ['think', 'sign', 'skipped', 'switched off'], ['sign', 'end', 'skipped', 'switched off']]);
  assert.ok(!changes.some(c => c['pending-move']) && !f.lines.some(l => /waiting at the gate/.test(l)), 'no gate held it');
  assert.deepEqual(f.lines.filter(l => /switched off/.test(l)), [
    'steps T-1 A write: switched off, skipped (→ ask)',
    'steps T-1 A ask: switched off, skipped (→ check)',
    'steps T-1 A gate/think: switched off, skipped (→ sign)',
    'steps T-1 A gate/sign: switched off, skipped (→ end)',
  ]);
  assert.deepEqual(f.assignments().assignments, []);
});

// ASS-209: the same engines with no step switched off in them; project p's
// project.json switches off write, ask, gate/think and gate/sign for p alone;
// project r runs the same engine, its T-1 A at write too, and lists none.
function perProject(entries = ['example-development/write', 'example-development/ask', 'gate/think', 'gate/sign']) {
  const f = switchedOff({});
  edit(join(f.dir, 'projects', 'p', 'project.json'), j => { j['switched-off-steps'] = entries; });
  for (const file of ['project.json', 'sprints.json', join('sprints', 'sprint-10', 'sprint.json')]) {
    mkdirSync(join(f.dir, 'projects', 'r', file, '..'), { recursive: true });
    writeFileSync(join(f.dir, 'projects', 'r', file), readFileSync(join(f.dir, 'projects', 'p', file)));
  }
  edit(join(f.dir, 'projects', 'r', 'project.json'), j => { delete j['switched-off-steps']; });
  const v = id => f.ctx.load().projects.find(p => p.id === id).tickets[0].variations[0];
  return { ...f, v };
}

test('ASS-209 AC1: a step in project.json\'s switched-off-steps is dispatched no agent for that project; the same step is for another project on the engine', () => {
  const f = perProject();
  const state = f.ctx.load();
  assert.deepEqual(planFor(state, state.projects.find(p => p.id === 'p')).dispatch, []);
  assert.deepEqual(planFor(state, state.projects.find(p => p.id === 'r')).dispatch.map(d => [d.key, d.state]), [['T-1', 'write']]);
});

test('ASS-209 AC1: a project\'s switched-off steps pass at once for it, at the top level and inside a sub-engine, recorded as skipped; another project\'s ticket at the same step stays', async () => {
  const f = perProject();
  for (let i = 0; i < 3; i++) await runSteps(f.ctx, f.ctx.load());
  assert.equal(f.v('p')['harness-status'].state, 'done');
  assert.deepEqual(f.v('p')['state-changes'].filter(c => c.cause === 'skipped').length, 4);
  assert.equal(f.v('r')['harness-status'].state, 'write');
  assert.deepEqual(f.v('r')['state-changes'], []);
});

test('ASS-209 AC2: control logs an error for a bad switched-off-steps entry, once, and leaves that step on', async () => {
  const f = perProject(['example-development/start', 'nope/write', 'example-development/write']);
  await runSteps(f.ctx, f.ctx.load());
  await runSteps(f.ctx, f.ctx.load());
  assert.deepEqual(f.lines.filter(l => /switched-off step/.test(l)), [
    'error project p: switched-off step "example-development/start": step "start" is switched off but is the first step',
    'error project p: switched-off step "nope/write" names no engine "nope"',
  ]);
  assert.equal(f.v('p')['harness-status'].state, 'ask');   // write passed; start stays on (there's nothing at it)
});
