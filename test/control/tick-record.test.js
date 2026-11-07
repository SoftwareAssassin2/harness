// A step with record-output-as keeps its sub-engine run's output on the
// variation (ticket:record-output) before moving on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { hs, STAMP } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

test('tick: the local-testing step records its test run\'s verdict on the variation, with a timestamp, then moves it on', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'local-testing' ? { ...s, 'record-output-as': 'local-testing' } : s)); });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0]['harness-status'] = hs('local-testing'); s.features[0]['ticket-system-status'] = 'In Progress'; s.features[0].variations[0]['local-testing'] = { 'number-of-relevant-automated-tests': 2 }; });
  process.env.FAKE_OUTPUT = '{"is-approved":true,"summary":"every criterion passed"}';
  try {
    for (let i = 0; i < 4 && f.variation()['harness-status'].state !== 'done'; i++) {   // test → take-screenshots → done, a turn each
      await tick(f.ctx);
      assert.ok(await turnsEnd(f.ctx));
    }
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'done', f.lines.join('\n'));
    const recorded = f.variation()['local-testing'];
    assert.match(recorded.timestamp, STAMP);
    assert.deepEqual(recorded, { 'number-of-relevant-automated-tests': 2, 'is-approved': true, summary: 'every criterion passed', run: recorded.run, timestamp: recorded.timestamp });
    assert.ok(recorded.run);
    assert.equal(f.lines.filter(l => /run's output recorded as local-testing$/.test(l)).length, 1);
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

// ASS-107: Blocked keeps every run of its sub-engine — what it found, what it tried, where it ended, where the ticket came from — for the next stay to learn from.
test('tick: a step with append-output-to adds its run\'s output, where the run ended and where the ticket came from, to the variation\'s list, then moves it on', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'local-testing' ? { ...s, 'append-output-to': 'blocks' } : s)); });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    const v = s.features[0].variations[0];
    v['harness-status'] = hs('local-testing'); s.features[0]['ticket-system-status'] = 'In Progress';
    v['state-changes'] = [{ 'state-engine': 'example-development', 'from-state': 'generate-solution', 'to-state': 'local-testing', timestamp: '2026-10-20T00:00:00Z' }];
    v.blocks = [{ summary: 'an earlier stay' }];
  });
  process.env.FAKE_OUTPUT = '{"is-approved":true,"summary":"every criterion passed"}';
  try {
    for (let i = 0; i < 4 && f.variation()['harness-status'].state !== 'done'; i++) {
      await tick(f.ctx);
      assert.ok(await turnsEnd(f.ctx));
    }
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'done', f.lines.join('\n'));
    const [earlier, kept] = f.variation().blocks;
    assert.equal(earlier.summary, 'an earlier stay');
    assert.match(kept.timestamp, STAMP);
    assert.ok(kept.run);
    assert.deepEqual({ ...kept, timestamp: 'T' }, { 'is-approved': true, summary: 'every criterion passed', 'ended-at': 'done', 'came-from': 'generate-solution', run: kept.run, timestamp: 'T' });
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

// ASS-107: what a Blocked run's prompts are given — the ticket's earlier blocks, in their {problem}, for each attempt to learn from.
test('tick: a run working for a ticket whose earlier Blocked runs were kept is dispatched with that block history in its problem', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    const v = s.features[0].variations[0];
    v['harness-status'] = hs('local-testing'); s.features[0]['ticket-system-status'] = 'In Progress';
    v['state-changes'] = [{ 'state-engine': 'example-development', 'from-state': 'build', 'to-state': 'blocked' }, { 'state-engine': 'example-development', 'from-state': 'blocked', 'to-state': 'local-testing' }];
    v.blocks = [{ timestamp: '2026-10-20T01:00:00Z', 'came-from': 'build', summary: 'nx will not run', issue: 'harness', reasoning: 'setup', key: 'ASS-9', 'ended-at': 'done' }];
  });
  try {
    for (let i = 0; i < 3 && !JSON.parse(readFileSync(join(f.dir, 'assignments.json'), 'utf8')).assignments.length; i++) await tick(f.ctx);
    const [record] = JSON.parse(readFileSync(join(f.dir, 'assignments.json'), 'utf8')).assignments;
    assert.ok(record?.['transient-state-engine'], f.lines.join('\n'));
    assert.match(record.problem, /^Earlier blocks of this ticket/);
    assert.match(record.problem, /from build: nx will not run\. Issue: harness — setup\. Ended: fix ticket ASS-9 landed, resumed — blocked again/);
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-235: whether a run's output was kept lives on the ticket (the entry carries the run's id), not in control's memory — a restarted control, its memory fresh, keeps it no second time; a new run keeps its own.
test('tick: a run whose output was recorded and appended is not kept again after a restart (fresh memory); a new run of the step keeps its own', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'local-testing' ? { ...s, 'record-output-as': 'local-testing', 'append-output-to': 'blocks' } : s)); });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('local-testing'), 'gate-when-leaving-state': ['example-development/local-testing'],
      'state-changes': [{ 'from-state': 'committed', 'to-state': 'local-testing', timestamp: '2026-10-11T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false }] });
    s.features[0]['ticket-system-status'] = 'In Progress';
  });
  const doneRun = (id, summary) => edit(join(f.dir, 'assignments.json'), a => {   // held at the gate, the run stays (as one waiting for a planning slot does)
    a['transient-state-engines'] = [{ id, project: 'p', 'state-engine': 'test', state: 'done', 'is-done': true, 'structured-output': { 'is-approved': true, summary }, parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'local-testing' } }];
  });
  try {
    doneRun('run-1', 'first');
    await tick(f.ctx);
    f.ctx.memory.ran.clear();                                   // control restarted
    await tick(f.ctx);
    assert.deepEqual(f.variation().blocks.map(b => [b.run, b.summary]), [['run-1', 'first']], f.lines.join('\n'));
    assert.deepEqual([f.variation()['local-testing'].run, f.variation()['local-testing'].summary], ['run-1', 'first']);
    assert.equal(f.lines.filter(l => /run's output recorded as local-testing$/.test(l)).length, 1);
    doneRun('run-2', 'second');
    await tick(f.ctx);
    assert.deepEqual(f.variation().blocks.map(b => [b.run, b.summary]), [['run-1', 'first'], ['run-2', 'second']]);
    assert.deepEqual([f.variation()['local-testing'].run, f.variation()['local-testing'].summary], ['run-2', 'second']);
  } finally {
    f.ctx.stopAgents();
  }
});
