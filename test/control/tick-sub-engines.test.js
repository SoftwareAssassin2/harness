// Sub-engines (ASS-66): a ticket entered into a sub-engine at the step its
// exit names, a sub-engine run inside a sub-engine run, and completion
// carried back up each level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture, complete } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { visitsInto } from '../../src/control/engine.js';
import { levelChanges } from '../../src/control/moves.js';
import { until } from '../support/until.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const sprintFile = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const engineFile = (f, name) => join(f.dir, 'engines', name, 'state-engine.json');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
// ABC-3 A at build, whose script moves it into local-testing (the test engine) — by `exit` when given.
const atBuild = (f, exit = {}) => {
  edit(engineFile(f, 'example-development'), e => { e.steps.find(s => s.id === 'build')['exit-events'][0] = { condition: { 'exit-code': 0 }, 'move-to-state': 'local-testing', ...exit }; });
  edit(sprintFile(f), s => { s.features[0].variations[0]['harness-status'] = hs('build'); s.features[0]['ticket-system-status'] = 'In Progress'; });
};
const subChanges = v => v['state-changes'].filter(c => c['sub-state-change']).map(c => c['sub-state-change']);

test('tick: an exit naming start-sub-engine-at enters the sub-engine there — the run, the sub-status and its agent at that step — and the run\'s completion moves the ticket on', async () => {
  const f = controlFixture();
  atBuild(f, { 'start-sub-engine-at': 'take-screenshots' });
  // A step inside a sub-engine pairs nothing (ASS-67): its group step's pairing holds, and there is no gap.
  edit(engineFile(f, 'test'), e => { e.steps.find(s => s.id === 'take-screenshots')['paired-ticket-system-status'] = 'In Review'; });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);
    assert.equal(f.ticket()['ticket-system-status'], 'In Progress');
    assert.ok(!f.lines.some(l => /gap/.test(l)), f.lines.join('\n'));
    const v = f.variation();
    assert.deepEqual(v['harness-status'], { ...hs('local-testing'), 'sub-status': { state: 'take-screenshots', 'state-engine': 'test' } });
    assert.deepEqual(subChanges(v), [{ 'state-engine': 'test', 'from-state': null, 'to-state': 'take-screenshots' }]);   // entered once, at the named step
    assert.equal(visitsInto(levelChanges(v), 'local-testing'), 1);                               // one visit to the parent step, as a plain entry
    const [run] = f.assignments()['transient-state-engines'];
    assert.deepEqual([run['state-engine'], run.state], ['test', 'take-screenshots']);
    assert.deepEqual(f.assignments().assignments.map(a => [a.state, a['transient-state-engine']]), [['take-screenshots', run.id]]);

    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.deepEqual(f.variation()['harness-status'], hs('done'));
    assert.deepEqual(f.assignments()['transient-state-engines'], []);
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

// ASS-124: a ticket handed into a sub-engine part way (ticket:repair-environment) brings what its run starts from.
test('tick: a ticket entered into a sub-engine at a step with an output (its sub-status\'s) starts the run there with it, for the step\'s prompt to read', async () => {
  const f = controlFixture();
  edit(sprintFile(f), s => { s.features[0].variations[0]['harness-status'] = { ...hs('local-testing'), 'sub-status': { state: 'take-screenshots', 'state-engine': 'test', output: { summary: 'S' } } }; s.features[0]['ticket-system-status'] = 'In Progress'; });
  try {
    await tick(f.ctx);
    const [run] = f.assignments()['transient-state-engines'];
    assert.deepEqual([run['state-engine'], run.state, run['structured-output']], ['test', 'take-screenshots', { summary: 'S' }]);
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a sub-engine inside a sub-engine — the inner run\'s prompt is the ticket\'s, its variation\'s and its project\'s, and its completion is carried up both levels', async () => {
  const f = controlFixture();
  atBuild(f);
  // local-testing's test engine: check (the inner engine) → done; inner: inspect (a prompt) → done.
  writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
    { id: 'check', sequence: 1, action: { type: 'state-engine', engine: 'inner' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] }));
  mkdirSync(join(f.dir, 'engines', 'inner'));
  writeFileSync(engineFile(f, 'inner'), JSON.stringify({ steps: [
    { id: 'inspect', sequence: 1, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: complete, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] }));
  const runs = () => f.assignments()['transient-state-engines'];
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);                                                                       // into local-testing: the test run, at check
    await tick(f.ctx);                                                                       // check starts the inner run, whose prompt gets its agent
    const [outer, inner] = runs();
    assert.deepEqual([outer['state-engine'], outer.state, inner['state-engine'], inner.state], ['test', 'check', 'inner', 'inspect']);
    assert.deepEqual(inner.parent, { 'transient-state-engine': outer.id, 'state-engine': 'test', state: 'check' });
    const [record] = f.assignments().assignments;
    assert.deepEqual([record.project, record['work-item'], record.variation, record['transient-state-engine'], record.state, record.prompt], ['p', 'ABC-3', 'A', inner.id, 'inspect', 'test']);
    assert.equal(f.variation()['state-changes'].at(-1)['agent-dispatch-log'][0]['dispatched-to'], record['agent-name']);   // logged on the ticket, as one level deep
    // The ticket's status is kept current at both levels (ASS-67): the inner run entered beneath check.
    assert.deepEqual(f.variation()['harness-status'], { ...hs('local-testing'), 'sub-status': { state: 'check', 'state-engine': 'test', 'sub-status': { state: 'inspect', 'state-engine': 'inner' } } });
    assert.deepEqual(f.variation()['state-changes'].at(-1)['sub-state-change'], { 'state-engine': 'test', 'from-state': 'check', 'to-state': 'check', 'sub-state-change': { 'state-engine': 'inner', 'from-state': null, 'to-state': 'inspect' } });

    // The inner run finishes: the outer run reads it, moves to done and ends it…
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.deepEqual(runs().map(r => [r['state-engine'], r.state, r['is-done']]), [['test', 'done', true]]);
    assert.deepEqual(subChanges(f.variation()).map(c => [c['to-state'], c['sub-state-change']?.['from-state'], c['sub-state-change']?.['to-state']]),
      [['check', undefined, undefined], ['check', null, 'inspect'], ['check', 'inspect', 'done'], ['done', undefined, undefined]]);   // the inner run's move reached the ticket, then the outer's
    assert.deepEqual(f.variation()['harness-status']['sub-status'], { state: 'done', 'state-engine': 'test' });
    // …and the ticket reads the outer run, carrying the inner run's output, and moves on.
    await tick(f.ctx);
    assert.deepEqual(f.variation()['harness-status'], hs('done'));
    assert.deepEqual(runs(), []);
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: a sub-engine\'s steps count their visits within their run — capped by their own max-visits, from zero again on each entry — while the parent step counts one visit an entry, capped by its own', async () => {
  const f = controlFixture();
  atBuild(f);
  // local-testing goes back into itself when its run is done (max-visits 3, then blocked); its run loops a ⇄ b, a capped at 2 visits.
  edit(engineFile(f, 'example-development'), e => { e.steps.find(s => s.id === 'local-testing')['exit-events'] = [{ condition: { 'is-done': true }, 'move-to-state': 'local-testing' }]; });
  writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
    { id: 'a', sequence: 1, 'max-visits': 2, 'on-max-visits': 'done', action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'b' }] },
    { id: 'b', sequence: 2, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'a' }] },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] }));
  for (let i = 0; i < 10 && f.variation()['harness-status'].state !== 'blocked'; i++) await tick(f.ctx);
  const v = f.variation();
  assert.equal(v['harness-status'].state, 'blocked', f.lines.join('\n'));
  const run = [[null, 'a'], ['a', 'b'], ['b', 'a'], ['a', 'b'], ['b', 'done']];                 // a's second visit is its last: b goes to done
  assert.deepEqual(subChanges(v).map(c => [c['from-state'], c['to-state']]), [...run, ...run, ...run]);   // three entries, each counted afresh
  assert.deepEqual(v['state-changes'].filter(c => !c['sub-state-change']).map(c => c['to-state']), ['local-testing', 'local-testing', 'local-testing', 'blocked']);
});

test('tick: an agent finishing a step inside a run counts the run\'s own visits — an inner generate-solution ⇄ automated-testing loop trips its max-visits within the run, and a re-entry of the parent starts the count at zero', async () => {
  const f = controlFixture();
  atBuild(f);
  // local-testing goes back into itself when its run is done (max-visits 2, then blocked); its run loops two prompts, generate-solution capped at 2 visits.
  edit(engineFile(f, 'example-development'), e => { Object.assign(e.steps.find(s => s.id === 'local-testing'), { 'max-visits': 2, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'local-testing' }] }); });
  writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
    { id: 'generate-solution', sequence: 1, 'max-visits': 2, 'on-max-visits': 'done', action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: complete, 'move-to-state': 'automated-testing' }] },
    { id: 'automated-testing', sequence: 2, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: complete, 'move-to-state': 'generate-solution' }] },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] }));
  try {
    for (let i = 0; i < 30 && f.variation()['harness-status'].state !== 'blocked'; i++) { await tick(f.ctx); assert.ok(await turnsEnd(f.ctx)); }
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'blocked', f.lines.join('\n'));
    // generate-solution's second visit is its last: automated-testing's agent goes to done instead.
    const run = [[null, 'generate-solution'], ['generate-solution', 'automated-testing'], ['automated-testing', 'generate-solution'], ['generate-solution', 'automated-testing'], ['automated-testing', 'done']];
    assert.deepEqual(subChanges(v).map(c => [c['from-state'], c['to-state']]), [...run, ...run]);   // two entries, each counted afresh
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a run that re-enters a script step runs its script again — automated-testing → code-review → generate-solution → automated-testing runs automated-testing\'s script twice (ASS-212)', async () => {
  const f = controlFixture();
  atBuild(f);
  mkdirSync(join(f.dir, 'ran'));
  writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
    { id: 'automated-testing', sequence: 1, action: { type: 'script', command: `mktemp ${join(f.dir, 'ran')}/x.XXXXXX` }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'code-review' }] },
    { id: 'code-review', sequence: 2, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'generate-solution' }] },
    { id: 'generate-solution', sequence: 3, 'max-visits': 1, 'on-max-visits': 'done', action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'automated-testing' }] },
    { id: 'done', sequence: 4, 'is-done': true, action: { type: 'none' } },
  ] }));
  for (let i = 0; i < 15 && subChanges(f.variation()).at(-1)?.['to-state'] !== 'done'; i++) await tick(f.ctx);
  assert.deepEqual(subChanges(f.variation()).map(c => [c['from-state'], c['to-state']]), [[null, 'automated-testing'], ['automated-testing', 'code-review'], ['code-review', 'generate-solution'], ['generate-solution', 'automated-testing'], ['automated-testing', 'code-review'], ['code-review', 'done']], f.lines.join('\n'));
  assert.equal(readdirSync(join(f.dir, 'ran')).length, 2);
});

test('tick: a human step inside a run waits for the human, and the choice recorded at it (ticket:human-review at the detailed step) moves the run — an exit following the return-to-state resolved within the run\'s own history', async () => {
  const f = controlFixture();
  atBuild(f);
  // The run: prepare (its return-to-state rework) → review, a human's: Approved → done, Rejected → back by the return-to-state.
  writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
    { id: 'prepare', sequence: 1, 'return-to-state': 'rework', action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'review' }] },
    { id: 'review', sequence: 2, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'done' }, { condition: { 'human-review': 'Rejected' }, 'follow-return-to-state': true }] },
    { id: 'rework', sequence: 3, action: { type: 'none' } },
    { id: 'done', sequence: 4, 'is-done': true, action: { type: 'none' } },
  ] }));
  const run = () => f.assignments()['transient-state-engines'][0];
  for (let i = 0; i < 3; i++) await tick(f.ctx);
  assert.equal(run().state, 'review', f.lines.join('\n'));                                     // waits there: nothing the human has not chosen
  assert.equal(f.variation()['harness-status']['sub-status'].state, 'review');
  await f.agent('ticket:human-review', 'p', 'ABC-3', 'A', 'review', 'Rejected', '');
  await tick(f.ctx);
  assert.equal(run().state, 'rework', f.lines.join('\n'));                                     // prepare's return-to-state, not the ticket's (build's)
  assert.equal(f.variation()['harness-status'].state, 'local-testing');
});

// ASS-116: v2-review's Variation Selection, a human step inside the Review run.
test('tick: a human step inside a run with a has-variations: false exit moves on by itself for a ticket with one variation — no human asked; with two it waits until a variation is chosen at it (ticket:select-variation at the detailed step)', async () => {
  const pick = { id: 'variation-selection', sequence: 1, action: { type: 'human' }, 'exit-events': [{ condition: { 'variation-selected': true }, 'move-to-state': 'done' }, { condition: { 'has-variations': false }, 'move-to-state': 'done' }] };
  const engine = JSON.stringify({ steps: [pick, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }] });
  const one = controlFixture();
  atBuild(one);
  writeFileSync(engineFile(one, 'test'), engine);
  for (let i = 0; i < 3; i++) await tick(one.ctx);
  assert.equal(one.assignments()['transient-state-engines'][0].state, 'done', one.lines.join('\n'));   // moved on by itself
  const two = controlFixture();
  atBuild(two);
  edit(sprintFile(two), s => { s.features[0].variations.push({ ...s.features[0].variations[0], name: 'B', 'harness-status': hs('backlog'), 'state-changes': [] }); });
  writeFileSync(engineFile(two, 'test'), engine);
  const run = () => two.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'test');
  for (let i = 0; i < 3; i++) await tick(two.ctx);
  assert.equal(run()?.state, 'variation-selection', two.lines.join('\n'));                     // waits for the human
  await two.agent('ticket:select-variation', 'p', 'ABC-3', 'A', 'variation-selection', 'A', '');
  for (let i = 0; i < 2; i++) await tick(two.ctx);
  assert.equal(run().state, 'done', two.lines.join('\n'));
});

test('tick: a gate on a human step inside a run that passes by itself with no human choice (one variation) is approved automatically — unless the project holds such gates (hold-gates-with-no-human-choice) (ASS-220 AC4)', async () => {
  const pick = { id: 'variation-selection', sequence: 1, action: { type: 'human' }, 'exit-events': [{ condition: { 'variation-selected': true }, 'move-to-state': 'done' }, { condition: { 'has-variations': false }, 'move-to-state': 'done' }] };
  const engine = JSON.stringify({ steps: [pick, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }] });
  const at = hold => {
    const f = controlFixture();
    atBuild(f);
    edit(sprintFile(f), s => { s.features[0].variations[0]['gate-when-leaving-state'] = ['test/variation-selection']; });
    if (hold) edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['hold-gates-with-no-human-choice'] = true; });
    writeFileSync(engineFile(f, 'test'), engine);
    return f;
  };
  const auto = at(false);
  for (let i = 0; i < 3; i++) await tick(auto.ctx);
  assert.equal(auto.assignments()['transient-state-engines'][0].state, 'done', auto.lines.join('\n'));
  const held = at(true);
  for (let i = 0; i < 3; i++) await tick(held.ctx);
  const [run] = held.assignments()['transient-state-engines'];
  assert.equal(run.state, 'variation-selection', held.lines.join('\n'));
  assert.deepEqual(held.variation()['state-changes'].at(-1)['pending-move'], { run: run.id, from: 'variation-selection', to: 'done', reason: 'exit' });
});

test('tick: sub-engine-ended-at reads which done step a run ended at, at both levels — an inner run ending at rework ends its parent run at rework, and the ticket\'s exit for it re-enters the group at a named step (ASS-68)', async () => {
  const f = controlFixture();
  atBuild(f);
  edit(engineFile(f, 'example-development'), e => { e.steps.find(s => s.id === 'local-testing')['exit-events'] = [
    { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'rework' }] }, 'move-to-state': 'local-testing', 'start-sub-engine-at': 'second' },
    { condition: { 'is-done': true }, 'move-to-state': 'done' },
  ]; });
  writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
    { id: 'check', sequence: 1, action: { type: 'state-engine', engine: 'inner' }, 'exit-events': [
      { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'rework' }] }, 'move-to-state': 'rework' },
      { condition: { 'is-done': true }, 'move-to-state': 'done' }] },
    { id: 'second', sequence: 2, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'done' }] },
    { id: 'rework', sequence: 3, 'is-done': true, action: { type: 'none' } },
    { id: 'done', sequence: 4, 'is-done': true, action: { type: 'none' } },
  ] }));
  mkdirSync(join(f.dir, 'engines', 'inner'));
  writeFileSync(engineFile(f, 'inner'), JSON.stringify({ steps: [
    { id: 'go', sequence: 1, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'rework' }] },
    { id: 'rework', sequence: 2, 'is-done': true, action: { type: 'none' } },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] }));
  for (let i = 0; i < 10 && f.variation()['harness-status'].state !== 'done'; i++) await tick(f.ctx);
  const v = f.variation();
  assert.deepEqual(v['harness-status'], hs('done'), f.lines.join('\n'));
  assert.deepEqual(subChanges(v).map(c => [c['state-engine'], c['from-state'], c['to-state'], c['sub-state-change']?.['to-state']]), [
    ['test', null, 'check', undefined], ['test', 'check', 'check', 'go'], ['test', 'check', 'check', 'rework'], ['test', 'check', 'rework', undefined],   // the inner run ended at rework, so did the outer
    ['test', null, 'second', undefined], ['test', 'second', 'done', undefined],                                                                       // re-entered at second
  ]);
  assert.deepEqual(f.assignments()['transient-state-engines'], []);
});

test('tick: an agent finishing a prompt step inside a run is judged against its ticket\'s facts too — the variation, its files, its scripts — as at the top level (ASS-68)', async () => {
  const f = controlFixture();
  atBuild(f);
  edit(sprintFile(f), s => { s.features[0].variations[0]['acceptance-criteria'] = [{ 'criteria-number': 1, description: 'x' }]; });
  writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
    { id: 'extract', sequence: 1, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [
      { condition: { all: [complete, { 'structured-ticket-variation-array-check': { 'member-name': 'acceptance-criteria', 'min-length': 1 } }] }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] }));
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.deepEqual(f.variation()['harness-status'], hs('done'), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

// ASS-161: a ticket moved by hand within its group step (ticket:change-sub-state) moves its run too, so control dispatches the step it was moved to.
test('tick: after ticket:change-sub-state moves a ticket within its group step, its run is there too and control dispatches that step', async () => {
  const f = controlFixture();
  edit(sprintFile(f), s => { s.features[0].variations[0]['harness-status'] = hs('local-testing'); s.features[0]['ticket-system-status'] = 'In Progress'; });
  // The ticket's test run at test, entered as control enters it, no agent at it yet.
  const parent = { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'local-testing' };
  await f.agent('transient-state-engine:create', 'p', 'test', 'test', JSON.stringify(parent));
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'A', 'test', '-', 'test');
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'A', 'test', 'test', 'take-screenshots');
  try {
    const [run] = f.assignments()['transient-state-engines'];
    assert.equal(run.state, 'take-screenshots');
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(a => [a.state, a['transient-state-engine']]), [['take-screenshots', run.id]]);
    assert.deepEqual(f.variation()['harness-status'], { ...hs('local-testing'), 'sub-status': { state: 'take-screenshots', 'state-engine': 'test' } });
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-228: a Human Review rejection inside a run goes to the done step named
// by the operator's return step (move-to-state-from-human-review), else the
// exit's fallback; the move is recorded on the ticket with cause
// operator-reject and the reason, and logged.
test('tick: a human step\'s Rejected exit with move-to-state-from-human-review moves the run to the return step the operator named, else its fallback — recorded with cause operator-reject and the reason, and logged (ASS-228 AC1)', async () => {
  const at = async (returnTo) => {
    const f = controlFixture();
    atBuild(f);
    mkdirSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3'), { recursive: true });
    writeFileSync(engineFile(f, 'test'), JSON.stringify({ steps: [
      { id: 'human-review', sequence: 1, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'done' },
        { condition: { 'human-review': 'Rejected' }, 'move-to-state-from-human-review': 'return-to', 'move-to-state': 'replan' }] },
      { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
      { id: 'replan', sequence: 3, 'is-done': true, action: { type: 'none' } },
      { id: 'write-test-plan', sequence: 4, 'is-done': true, action: { type: 'none' } },
    ] }));
    for (let i = 0; i < 3; i++) await tick(f.ctx);
    const run = () => f.assignments()['transient-state-engines'][0];
    assert.equal(run().state, 'human-review', f.lines.join('\n'));
    await f.agent('ticket:human-review', 'p', 'ABC-3', 'A', 'human-review', 'Rejected', '', 'Plan the empty case', returnTo);
    const before = f.lines.length;
    await tick(f.ctx);
    const moved = f.variation()['state-changes'].find(c => c['sub-state-change']?.['from-state'] === 'human-review');
    return { f, moved, logged: f.lines.slice(before) };
  };
  const tests = await at('write-test-plan');
  assert.deepEqual([tests.moved?.['sub-state-change']['to-state'], tests.moved?.cause, tests.moved?.reason], ['write-test-plan', 'operator-reject', 'Plan the empty case'], tests.f.lines.join('\n'));
  assert.ok(tests.logged.some(l => l === 'steps ABC-3 A test/human-review: rejected by the operator (→ write-test-plan): Plan the empty case'), tests.logged.join('\n'));
  const plan = await at('write-execution-plan');   // no done step of that name: the fallback, today's route
  assert.deepEqual([plan.moved?.['sub-state-change']['to-state'], plan.moved?.cause], ['replan', 'operator-reject']);
});

test('tick: a run whose step no longer exists — its step gone, or its steps list — is ended once, logged, not warned about on every start (ASS-236 AC3)', async () => {
  const f = controlFixture();
  const runs = [
    { id: 'b65bb2c0-gone-list', project: 'p', 'state-engine': 'example-development/check-health-old-steps', state: 'check-health', parent: { trigger: 'check-health' }, 'is-done': false },
    { id: '400ca560-gone-step', project: 'p', 'state-engine': 'test', state: 'await-approval', parent: { 'transient-state-engine': 'gone-parent', 'state-engine': 'x', state: 'y' }, 'is-done': false },
  ];
  const file = join(f.dir, 'assignments.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'transient-state-engines': runs }));
  await tick(f.ctx);
  assert.deepEqual(f.assignments()['transient-state-engines'].filter(r => runs.some(o => o.id === r.id)), [], f.lines.join('\n'));
  assert.ok(f.lines.includes('steps run example-development/check-health-old-steps b65bb2c0 ended (its step check-health no longer exists)'), f.lines.join('\n'));
  assert.ok(f.lines.includes('steps run test 400ca560 ended (its step await-approval no longer exists)'), f.lines.join('\n'));
  assert.ok(!f.lines.some(l => /no such step/.test(l)), f.lines.join('\n'));
});
