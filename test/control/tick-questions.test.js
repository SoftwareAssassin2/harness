// Questions that block (ASS-248): control starts no agent for a ticket with
// an open blocking question — at a sprint step, in a run under it, in the
// backlog — the way it holds a paused one: one check in dispatch, no seat
// taken, logged once; the next tick after the answer dispatches it. A
// non-blocking question never holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

const sprintFile = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const ask = (f, list, key = 'ABC-3') => {
  mkdirSync(join(f.dir, 'projects', 'p', 'work', key), { recursive: true });
  writeFileSync(join(f.dir, 'projects', 'p', 'work', key, 'questions-and-answers.json'), JSON.stringify({ list: list.map(q => ({ 'asked-on-ticket': key, 'recomended-answer': 'Yes.', ...q })) }));
};
// ABC-3 A at `state` (plan: a prompt step), In Progress.
const at = (f, status) => edit(sprintFile(f), s => { s.features[0].variations[0]['harness-status'] = status; s.features[0]['ticket-system-status'] = 'In Progress'; });
const agentsOn = (f, key = 'ABC-3') => f.assignments().assignments.filter(a => a['work-item'] === key);
const held = (f, key = 'ABC-3') => f.lines.filter(l => l.startsWith(`dispatch ${key} `) && /blocking question/.test(l));

test('AC2: a sprint ticket with an open blocking question gets no agent, logged once however many ticks; the tick after it is answered dispatches it', async () => {
  for (const question of [{ question: 'Which cards?', status: 'Asked', blocking: true }, { question: 'Which cards?', status: 'Asked' }, { question: 'Which cards?', status: 'Answer Rejected', blocking: true }]) {
    const f = controlFixture();
    at(f, hs('plan'));
    ask(f, [question]);
    try {
      await tick(f.ctx);
      await tick(f.ctx);
      await tick(f.ctx);
      assert.deepEqual(agentsOn(f), [], JSON.stringify(question));
      assert.equal(held(f).length, 1, f.lines.join('\n'));
      assert.match(held(f)[0], /ABC-3 waits on the operator: 1 open blocking question \(Which cards\?\)/);
      await f.agent('question:answer', 'p', 'ABC-3', '0', 'Visa only.');
      await tick(f.ctx);
      assert.deepEqual(agentsOn(f).map(a => a.state), ['plan']);
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('AC3: a non-blocking open question never holds the ticket', async () => {
  const f = controlFixture();
  at(f, hs('plan'));
  ask(f, [{ question: 'Which cards?', status: 'Asked', blocking: false }]);
  try {
    await tick(f.ctx);
    assert.deepEqual(agentsOn(f).map(a => a.state), ['plan']);
    assert.deepEqual(held(f), []);
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC2: a ticket held by a blocking question takes no seat — the next ticket gets the in-progress slot', async () => {
  const f = controlFixture();
  // ABC-3 and ABC-4 both at review-plan's step past planning, one in-progress slot (the fixture's max-tickets-in-progress 1).
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { delete e.steps.find(s => s.id === 'plan')['is-planning-stage']; });
  edit(sprintFile(f), s => {
    s.features[0].variations[0]['harness-status'] = hs('plan');
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0]['manual-priority'] = 1;
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'In Progress', 'manual-priority': 2, variations: [{ name: 'A', 'harness-status': hs('plan'), 'state-changes': [] }] });
  });
  ask(f, [{ question: 'Which cards?', status: 'Asked', blocking: true }]);
  try {
    await tick(f.ctx);
    assert.deepEqual(agentsOn(f), []);
    assert.deepEqual(agentsOn(f, 'ABC-4').map(a => a.state), ['plan']);
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC2: a run under a ticket with an open blocking question (a sub-engine\'s step) gets no agent', async () => {
  const f = controlFixture();
  at(f, { ...hs('local-testing'), 'sub-status': { state: 'test', 'state-engine': 'test' } });
  ask(f, [{ question: 'Which cards?', status: 'Asked', blocking: true }]);
  try {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.assignments()['transient-state-engines'].length, 1);          // the run is there, waiting
    assert.deepEqual(f.assignments().assignments, []);
    assert.equal(held(f).length, 1, f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC2: a done ticket\'s unflagged questions hold nothing and are not logged', async () => {
  const f = controlFixture();
  edit(sprintFile(f), s => { s.features[0].variations[0]['harness-status'] = hs('done'); s.features[0]['ticket-system-status'] = 'Done'; });
  ask(f, [{ question: 'Which cards?', status: 'Asked' }]);
  try {
    await tick(f.ctx);
    assert.deepEqual(held(f), []);
  } finally {
    f.ctx.stopAgents();
  }
});
