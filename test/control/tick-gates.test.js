// Human gates: a variation that gates leaving a state waits there, its work
// marked done, until a human moves it; a human step moves by what the human
// recorded, or on its own when nothing needs choosing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const sprintFile = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const engineFile = f => join(f.dir, 'engines', 'example-development', 'state-engine.json');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

test('tick: a gated variation stops with its work marked done when its exit holds, is not dispatched again, and goes on — the ticket system following — once a human moves it', async () => {
  const f = controlFixture();
  edit(sprintFile(f), s => { s.features[0].variations[0]['gate-when-leaving-state'] = ['example-development/plan']; });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'plan');
    assert.deepEqual(v['state-changes'].at(-1), { ...v['state-changes'].at(-1), 'to-state': 'plan', 'work-is-done': true, 'pending-move': { from: 'plan', to: 'build', reason: 'exit' } });
    assert.ok(f.lines.some(l => l === 'finish ABC-3 A plan: work done; waiting at the gate for a human (next would be build)'), f.lines.join('\n'));
    assert.deepEqual(f.assignments().assignments, []);
    const before = f.lines.length;
    await tick(f.ctx);
    assert.ok(!f.lines.slice(before).some(l => /^(dispatch|cli agent.sh ticket:mark-work-done) /.test(l)), f.lines.slice(before).join('\n'));
    assert.deepEqual(f.assignments().assignments, []);
    // The human approves on the dashboard: ticket:approve-gate makes the move control held (ASS-132).
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'local-testing');            // build's script ran and moved it on
    assert.equal(f.ticket()['ticket-system-status'], 'In Progress');
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: a human step with nothing to choose (one variation) moves on by itself; one whose choice the human recorded, since the variation arrived, moves by it', async () => {
  const f = controlFixture();
  edit(engineFile(f), e => {
    e.steps = e.steps.map(s => (s.id === 'build' ? { ...s, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'choose' }] } : s));
    e.steps.push({ id: 'choose', sequence: 7, 'paired-ticket-system-status': 'In Progress', action: { type: 'human' },
      'exit-events': [{ condition: { 'variation-selected': true }, 'move-to-state': 'local-testing' }, { condition: { 'has-variations': false }, 'move-to-state': 'local-testing' }] });
    e.steps.push({ id: 'ask', sequence: 8, 'paired-ticket-system-status': 'In Progress', action: { type: 'human' },
      'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'done' }, { condition: { 'human-review': 'Rejected' }, 'move-to-state': 'plan' }] });
  });
  edit(sprintFile(f), s => { s.features[0].variations[0]['harness-status'] = hs('build'); s.features[0]['ticket-system-status'] = 'In Progress'; });   // the status its step pairs: no gap
  try {
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'local-testing');
    assert.ok(f.lines.some(l => /^steps ABC-3 A choose → local-testing$/.test(l)), f.lines.join('\n'));
    // A second variation: the step waits for the human to choose.
    f.ctx.stopAgents();
    edit(sprintFile(f), s => {
      s.features[0].variations[0]['harness-status'] = hs('ask');
      s.features[0].variations[0]['state-changes'] = [{ 'from-state': 'build', 'to-state': 'ask', timestamp: '2026-10-11T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false }];
      s.features[0].variations[0]['human-review'] = { state: 'ask', decision: 'Rejected', timestamp: '2026-10-11T09:00:00Z' };   // an earlier visit's choice
    });
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'ask');
    await f.agent('ticket:human-review', 'p', 'ABC-3', 'A', 'ask', 'Approved', '');          // recorded without a move
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'done');
    assert.equal(f.ticket()['ticket-system-status'], 'Done');
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a gate on a step inside a sub-engine (<engine>/<step>, ASS-67) holds its run there, the work marked done, not dispatched again, until a human approves: the run moves where the exit went with the step\'s output, and the ticket step\'s exit reading that output matches (ASS-132)', async () => {
  const f = controlFixture();
  edit(sprintFile(f), s => {
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('build'), 'gate-when-leaving-state': ['test/test'] });
    s.features[0]['ticket-system-status'] = 'In Progress';
  });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);                                                                       // build → local-testing: the test run, its agent at test
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    const [run] = f.assignments()['transient-state-engines'];
    assert.equal(run.state, 'test');
    const v = f.variation();
    assert.deepEqual(v['harness-status']['sub-status'], { state: 'test', 'state-engine': 'test' });
    assert.equal(v['state-changes'].at(-1)['work-is-done'], true);
    assert.deepEqual(v['state-changes'].at(-1)['pending-move'], { run: run.id, from: 'test', to: 'take-screenshots', reason: 'exit', output: { 'is-approved': true } });
    assert.ok(f.lines.some(l => l === `finish ABC-3 A test/test: work done; waiting at the gate for a human (next would be take-screenshots)`), f.lines.join('\n'));
    const before = f.lines.length;
    await tick(f.ctx);
    assert.ok(!f.lines.slice(before).some(l => /^(dispatch|cli agent.sh ticket:mark-work-done) /.test(l)), f.lines.slice(before).join('\n'));
    assert.deepEqual(f.assignments().assignments, []);
    // The human approves on the dashboard (ticket:approve-gate, ASS-132): the run moved on to the
    // next step, the gated step's output merged into the run as an ungated move merges it.
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    assert.deepEqual(f.assignments()['transient-state-engines'][0]['structured-output'], { 'is-approved': true });
    process.env.FAKE_OUTPUT = '{"screenshots":[]}';
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(a => a.state), ['take-screenshots']);
    // The run ends with both steps' output, and local-testing's exit, reading is-approved, takes the ticket on.
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'done', f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

// A variation at `state`, its one change into it, gating leaving it.
const gatedAt = (f, state, changes = []) => edit(sprintFile(f), s => {
  Object.assign(s.features[0].variations[0], { 'harness-status': hs(state), 'gate-when-leaving-state': [`example-development/${state}`],
    'state-changes': [...changes, { 'from-state': 'committed', 'to-state': state, timestamp: '2026-10-11T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false }] });
  s.features[0]['ticket-system-status'] = 'In Progress';
});

test('tick: approving a gate whose exit was a retry (plan rejected → plan) moves the variation back into its own step, which runs again (ASS-132)', async () => {
  const f = controlFixture();
  gatedAt(f, 'plan');
  process.env.FAKE_OUTPUT = '{"is-approved":false}';
  try {
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.deepEqual(f.variation()['state-changes'].at(-1)['pending-move'], { from: 'plan', to: 'plan', reason: 'exit' });
    await assert.rejects(f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A', 'build'), e => /not at build/.test(e.stderr));   // the gate the screen showed has gone
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A', 'plan');                         // as the ticket screen runs it
    const v = f.variation();
    assert.deepEqual([v['harness-status'].state, v['state-changes'].at(-1)['from-state'], v['state-changes'].at(-1)['to-state'], v['state-changes'].length], ['plan', 'plan', 'plan', 2]);
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(a => a.state), ['plan']);                // dispatched again
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: approving a gate whose exit went on to a block (max-visits → blocked) moves the variation to Blocked, not the next step by sequence (ASS-132)', async () => {
  const f = controlFixture();
  const visit = { 'from-state': 'plan', 'to-state': 'plan', timestamp: '2026-10-11T09:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true };
  gatedAt(f, 'plan', [visit, visit]);                                                         // a third visit: the retry is redirected to blocked
  process.env.FAKE_OUTPUT = '{"is-approved":false}';
  try {
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.deepEqual(f.variation()['state-changes'].at(-1)['pending-move'], { from: 'plan', to: 'blocked', reason: 'max-visits' });
    assert.ok(f.lines.includes('finish ABC-3 A plan: work done; waiting at the gate for a human (next would be blocked)'), f.lines.join('\n'));
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    assert.equal(f.variation()['harness-status'].state, 'blocked');
    assert.equal(f.ticket()['ticket-system-status'], 'Blocked');
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: approving a gate whose exit went to a rejection target (local-testing\'s run not approved → plan) moves the variation there (ASS-132)', async () => {
  const f = controlFixture();
  gatedAt(f, 'local-testing');
  edit(join(f.dir, 'assignments.json'), a => {
    a['transient-state-engines'] = [{ id: 'run-1', project: 'p', 'state-engine': 'test', state: 'done', 'is-done': true, 'structured-output': { 'is-approved': false }, parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'local-testing' } }];
  });
  try {
    await tick(f.ctx);
    assert.deepEqual(f.variation()['state-changes'].at(-1)['pending-move'], { from: 'local-testing', to: 'plan', reason: 'exit' });
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    assert.equal(f.variation()['harness-status'].state, 'plan');
  } finally {
    f.ctx.stopAgents();
  }
});

test('ticket:approve-gate fails, moving nothing, when no move waits at a gate', async () => {
  const f = controlFixture();
  await assert.rejects(f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A'), e => /no move waiting at a gate/.test(e.stderr));
  await assert.rejects(f.agent('ticket:approve-gate', 'p', 'ABC-3'), e => /usage/.test(e.stderr));
  assert.equal(f.variation()['harness-status'].state, 'backlog');
});

test('tick: gates inside a run inside a run — a record-script-output script step and a prompt step — each approved, keep what the step produced, so the outer run\'s exit and the ticket step\'s, reading it, match (ASS-132)', async () => {
  const f = controlFixture();
  edit(engineFile(f), e => { e.steps.find(s => s.id === 'local-testing').action.engine = 'outer'; });
  edit(join(f.dir, 'engines', 'test', 'state-engine.json'), e => {
    e.steps.unshift({ id: 'create-vm', sequence: 0, 'record-script-output': true, action: { type: 'script', command: 'echo {"vm-name":"lima-x"}' }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'test' }] });
  });
  mkdirSync(join(f.dir, 'engines', 'outer'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'outer', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'inner', sequence: 1, action: { type: 'state-engine', engine: 'test' },
      'exit-events': [{ condition: { all: [{ 'is-done': true }, { 'structured-output': { 'is-approved': true } }, { 'structured-output': { 'vm-name': 'lima-x' } }] }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] }));
  edit(sprintFile(f), s => {
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('build'), 'gate-when-leaving-state': ['test/create-vm', 'test/test'] });
    s.features[0]['ticket-system-status'] = 'In Progress';
  });
  const inner = () => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'test');
  const pending = () => f.variation()['state-changes'].at(-1)?.['pending-move'];
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    for (let i = 0; i < 3 && !pending(); i++) await tick(f.ctx);                            // build → local-testing → outer → inner, its script run
    assert.deepEqual(pending(), { run: inner().id, from: 'create-vm', to: 'test', reason: 'exit', output: { 'vm-name': 'lima-x' } }, f.lines.join('\n'));
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    assert.deepEqual([inner().state, inner()['structured-output']], ['test', { 'vm-name': 'lima-x' }]);
    await tick(f.ctx);                                                                       // test's agent
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.deepEqual(pending(), { run: inner().id, from: 'test', to: 'take-screenshots', reason: 'exit', output: { 'is-approved': true } });   // the step's own (ASS-236 AC4)
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    assert.deepEqual(inner()['structured-output'], { 'vm-name': 'lima-x', 'is-approved': true });                                       // merged over the run's on approval
    process.env.FAKE_OUTPUT = '{"screenshots":[]}';
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    for (let i = 0; i < 3 && f.variation()['harness-status'].state !== 'done'; i++) await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'done', f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

// ASS-117: Release's Request a Restart is a script whose work is the restart
// itself. Held at a gate on leaving it, the control it restarted comes back
// with no memory of having run it; were it run again it would name the new
// control and restart it too, over and over. A script step held at its gate,
// its work done, is not run again — at the top level or inside a run — until
// the human approves the move.
test('tick: a script step held at a gate, its work done, is not run again by a restarted control (no memory of running it) — at the top level and inside a run (ASS-117: Request a Restart)', async () => {
  const ran = f => readdirSync(join(f.dir, 'ran')).length;
  const restart = f => { for (const v of Object.values(f.ctx.memory)) v?.clear?.(); };   // a new control: what it remembers, gone
  const top = controlFixture();
  mkdirSync(join(top.dir, 'ran'));
  edit(engineFile(top), e => { e.steps.find(s => s.id === 'build').action = { type: 'script', command: `mktemp ${join(top.dir, 'ran')}/x.XXXXXX` }; });
  gatedAt(top, 'build');
  await tick(top.ctx);
  assert.deepEqual(top.variation()['state-changes'].at(-1)?.['pending-move'], { from: 'build', to: 'local-testing', reason: 'exit' }, top.lines.join('\n'));
  restart(top);
  for (let i = 0; i < 2; i++) await tick(top.ctx);
  assert.equal(ran(top), 1, top.lines.join('\n'));
  await top.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
  assert.equal(top.variation()['harness-status'].state, 'local-testing');

  const inner = controlFixture();
  mkdirSync(join(inner.dir, 'ran'));
  edit(join(inner.dir, 'engines', 'test', 'state-engine.json'), e => {
    e.steps.unshift({ id: 'request-restart', sequence: 0, action: { type: 'script', command: `mktemp ${join(inner.dir, 'ran')}/x.XXXXXX` }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'test' }] });
  });
  edit(sprintFile(inner), s => { Object.assign(s.features[0].variations[0], { 'harness-status': hs('build'), 'gate-when-leaving-state': ['test/request-restart'] }); s.features[0]['ticket-system-status'] = 'In Progress'; });
  const run = () => inner.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'test');
  const pending = () => inner.variation()['state-changes'].at(-1)?.['pending-move'];
  for (let i = 0; i < 3 && !pending(); i++) await tick(inner.ctx);
  assert.deepEqual(pending(), { run: run().id, from: 'request-restart', to: 'test', reason: 'exit' }, inner.lines.join('\n'));
  restart(inner);
  for (let i = 0; i < 2; i++) await tick(inner.ctx);
  assert.equal(ran(inner), 1, inner.lines.join('\n'));
  await inner.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
  assert.equal(run().state, 'test');
  inner.ctx.stopAgents();
});

// ASS-220 AC4: a gated human step that passes by itself — no choice to offer (has-variations false, one variation).
const choosing = (f, hold) => {
  edit(engineFile(f), e => {
    e.steps = e.steps.map(s => (s.id === 'build' ? { ...s, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'choose' }] } : s));
    e.steps.push({ id: 'choose', sequence: 7, 'paired-ticket-system-status': 'In Progress', action: { type: 'human' },
      'exit-events': [{ condition: { 'variation-selected': true }, 'move-to-state': 'local-testing' }, { condition: { 'has-variations': false }, 'move-to-state': 'local-testing' }] });
  });
  edit(sprintFile(f), s => {
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('build'), 'gate-when-leaving-state': ['example-development/choose'] });
    s.features[0]['ticket-system-status'] = 'In Progress';
  });
  if (hold != null) edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['hold-gates-with-no-human-choice'] = hold; });
  return f;
};

test('tick: a gate on a human step that passes by itself with no human choice (one variation) is approved automatically — unless the project holds such gates (hold-gates-with-no-human-choice), when the move waits at the gate (ASS-220 AC4)', async () => {
  for (const hold of [undefined, false]) {
    const f = choosing(controlFixture(), hold);
    try {
      await tick(f.ctx);
      assert.equal(f.variation()['harness-status'].state, 'local-testing', f.lines.join('\n'));
      assert.ok(f.lines.some(l => /^steps ABC-3 A choose → local-testing$/.test(l)), f.lines.join('\n'));
    } finally {
      f.ctx.stopAgents();
    }
  }
  const f = choosing(controlFixture(), true);
  try {
    await tick(f.ctx);
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'choose');
    assert.deepEqual(v['state-changes'].at(-1)['pending-move'], { from: 'choose', to: 'local-testing', reason: 'exit' });
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    assert.equal(f.variation()['harness-status'].state, 'local-testing');
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a gate on a human step whose choice the human made still holds the move for the gate\'s Approve (ASS-220 AC1)', async () => {
  const f = choosing(controlFixture());
  edit(sprintFile(f), s => { s.features[0].variations.push({ ...s.features[0].variations[0], name: 'B', 'harness-status': hs('backlog'), 'state-changes': [] }); });
  try {
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'choose');
    await f.agent('ticket:select-variation', 'p', 'ABC-3', 'A', 'choose', 'A', '');
    await tick(f.ctx);
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'choose');
    assert.deepEqual(v['state-changes'].at(-1)['pending-move'], { from: 'choose', to: 'local-testing', reason: 'exit' });
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-236 AC1: a timer script step polls (a merge, an auto-merge) — a gate on it would hold a stale
// decision for hours and replay it on approval, so no gate holds one: it moves by each fresh result.
test('tick: a gate never holds a timer script step — at the top level or inside a run — and one held before (its work done, a pending move) runs again and moves by the fresh result (ASS-236 AC1)', async () => {
  const top = controlFixture();
  edit(engineFile(top), e => { Object.assign(e.steps.find(s => s.id === 'build').action, { mode: 'timer', 'timer-minutes': 1 }); });
  gatedAt(top, 'build');
  edit(sprintFile(top), s => { Object.assign(s.features[0].variations[0]['state-changes'].at(-1), { 'work-is-done': true, 'pending-move': { from: 'build', to: 'build', reason: 'exit' } }); });
  try {
    await tick(top.ctx);
    assert.equal(top.variation()['harness-status'].state, 'local-testing', top.lines.join('\n'));
    assert.ok(!top.lines.some(l => /mark-work-done|waiting at the gate/.test(l)), top.lines.join('\n'));
  } finally {
    top.ctx.stopAgents();
  }

  const inner = controlFixture();
  edit(join(inner.dir, 'engines', 'test', 'state-engine.json'), e => {
    e.steps.unshift({ id: 'poll', sequence: 0, action: { type: 'script', mode: 'timer', 'timer-minutes': 1, command: 'echo polled' }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'test' }] });
  });
  edit(sprintFile(inner), s => { Object.assign(s.features[0].variations[0], { 'harness-status': hs('build'), 'gate-when-leaving-state': ['test/poll'] }); s.features[0]['ticket-system-status'] = 'In Progress'; });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    for (let i = 0; i < 2; i++) await tick(inner.ctx);                                     // build → local-testing, the run at poll; then poll → test
    assert.equal(inner.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'test')?.state, 'test', inner.lines.join('\n'));
    assert.ok(!inner.lines.some(l => /mark-work-done|waiting at the gate/.test(l)), inner.lines.join('\n'));
  } finally {
    delete process.env.FAKE_OUTPUT;
    inner.ctx.stopAgents();
  }
});

// ASS-236 AC4: the run's structured-output carries every step's output, an earlier step's verdict among
// it; the gate's pending move holds only the gated step's own, merged over the run's on approval.
test('tick: a gate inside a run holds only the gated step\'s own output, not an earlier step\'s verdict; approving merges it over the run\'s output (ASS-236 AC4)', async () => {
  const f = controlFixture();
  edit(sprintFile(f), s => {
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('build'), 'gate-when-leaving-state': ['test/take-screenshots'] });
    s.features[0]['ticket-system-status'] = 'In Progress';
  });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);                                                                       // build → local-testing: the test run, its agent at test
    assert.ok(await turnsEnd(f.ctx));
    process.env.FAKE_OUTPUT = '{"screenshots":[]}';
    await tick(f.ctx);                                                                       // test → take-screenshots, its agent dispatched
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    const [run] = f.assignments()['transient-state-engines'];
    assert.equal(run.state, 'take-screenshots', f.lines.join('\n'));
    assert.deepEqual(f.variation()['state-changes'].at(-1)['pending-move'], { run: run.id, from: 'take-screenshots', to: 'done', reason: 'exit', output: { screenshots: [] } });
    await f.agent('ticket:approve-gate', 'p', 'ABC-3', 'A');
    assert.deepEqual(f.assignments()['transient-state-engines'][0]['structured-output'], { 'is-approved': true, screenshots: [] });
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});
