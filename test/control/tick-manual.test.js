// A ticket worked by hand (ASS-166, ticket:set-manual: worked-manually on the
// ticket) is control's to leave alone: no move, no dispatch, no slot, no run
// about it, no gap resolution — until the mark is cleared, when control takes
// it on from where it stands. The mark is no pause: each is held apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { isPaused } from '../../src/control/moves.js';
import { isManual } from '../../src/control/engine.js';
import { planDispatch } from '../../src/control/plan.js';
import { preemptions } from '../../src/control/fast-track.js';

const MARK = { by: 'alice', since: '2026-10-27T10:00:00Z', note: null };
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

test('ASS-166 AC2, AC5: isPaused holds a ticket worked by hand — each variation and each run working for it — and isManual tells the mark from a pause', () => {
  const state = { pauses: {}, transient: [{ id: 'r', project: 'p', parent: { 'work-item': 'T-1', variation: 'A', state: 'build' } }],
    projects: [{ id: 'p', tickets: [{ key: 'T-1', 'worked-manually': MARK, variations: [{ name: 'A' }, { name: 'B' }] }, { key: 'T-2', variations: [{ name: 'A', 'is-paused': true }] }] }] };
  assert.deepEqual(['A', 'B'].map(v => isPaused(state, 'p', 'T-1', v)), [true, true]);
  assert.equal(isPaused(state, 'p', 'T-1', undefined, 'r'), true);   // as runSteps asks for a run: its context's work-item
  assert.deepEqual(state.projects[0].tickets.map(isManual), [true, false]);
});

test('ASS-166 AC2: a ticket worked by hand neither dispatches nor holds a slot', () => {
  const engine = { steps: [{ id: 'build', sequence: 1, action: { type: 'prompt', prompt: 'build' } }] };
  const at = { name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } };
  const result = planDispatch({ ranked: [{ key: 'T-1', 'worked-manually': MARK, variations: [at] }, { key: 'T-2', variations: [at] }], engine, harness: { 'max-tickets-in-progress': 1 } });
  assert.deepEqual(result.reserved, [{ key: 'T-2', variation: 'A' }]);
  assert.deepEqual(result.dispatch.map(d => d.key), ['T-2']);
});

test('ASS-166 AC5: pre-emption never pauses a ticket worked by hand, nor resumes one it paused before the mark', () => {
  const engine = { steps: [{ id: 'plan', sequence: 1, 'is-planning-stage': true, action: { type: 'prompt', prompt: 'plan' } }] };
  const at = extra => ({ name: 'A', 'harness-status': { state: 'plan', 'state-engine': 'e' }, ...extra });
  const tickets = [{ key: 'T-1', 'worked-manually': MARK, variations: [at()] }, { key: 'T-2', 'worked-manually': MARK, variations: [at({ 'is-paused': true, 'paused-for-fast-track': 'F-1', 'preempted-seat': 'planning' })] }];
  const { pause, resume } = preemptions({ tickets, engine, engines: {}, holders: { planning: [{ key: 'T-1', variation: 'A' }] }, waiting: [{ key: 'F-9', variation: 'A', kind: 'planning' }] });
  assert.deepEqual([pause, resume], [[], []]);
});

// The control fixture with ABC-3 (at backlog) worked by hand and ABC-4 beside it, at backlog too; `status` ABC-3's ticket-system-status.
function manualFixture(status = 'Backlog') {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0], { 'worked-manually': MARK, 'ticket-system-status': status });
    s.features[0].variations.push({ name: 'B', 'harness-status': hs('plan'), 'state-changes': [] });
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': hs('backlog'), 'state-changes': [] }] });
  });
  const at = (key, name = 'A') => f.sprint().features.find(t => t.key === key).variations.find(v => v.name === name)['harness-status'].state;
  return { ...f, at };
}

test('ASS-166 AC2, AC4: control moves and dispatches nothing for a ticket worked by hand while others go on; cleared, it takes the ticket on from where it stands', async () => {
  const f = manualFixture();
  try {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual([f.at('ABC-3'), f.at('ABC-3', 'B')], ['backlog', 'plan']);
    assert.notEqual(f.at('ABC-4'), 'backlog');
    assert.ok(!f.assignments().assignments.some(a => a['work-item'] === 'ABC-3'), JSON.stringify(f.assignments().assignments));
    assert.ok(!f.lines.some(l => /ABC-3/.test(l)), f.lines.join('\n'));
    await f.agent('ticket:set-manual', 'p', 'ABC-3', 'off');
    await tick(f.ctx);
    assert.notEqual(f.at('ABC-3'), 'backlog', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-166 AC2: no gap resolution or variation-appeal run starts about a ticket worked by hand', async () => {
  const f = manualFixture('In Progress');
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-variation-appeal-interval-seconds'] = 1;
    e['check-variation-appeal-steps'] = [{ id: 'check-variation-appeal', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
  });
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  try {
    for (let i = 0; i < 3; i++) { clock += 2000; await tick(f.ctx); }
    const runs = f.assignments()['transient-state-engines'];
    assert.ok(!runs.some(r => r.parent['work-item'] === 'ABC-3'), JSON.stringify(runs));
    assert.ok(!f.lines.some(l => /gap-resolution for ABC-3|check-variation-appeal/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-166 AC2: a step that failed its last time before the mark sends a ticket worked by hand to no Blocked run', async () => {
  const f = manualFixture();
  f.ctx.memory.toBlock = new Set(['p/ABC-3/B/plan']);
  try {
    await tick(f.ctx);
    assert.equal(f.at('ABC-3', 'B'), 'plan', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});
