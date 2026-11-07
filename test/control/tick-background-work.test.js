// A project's background work switched off (ASS-127, project.json
// background-work false): control starts none of its check-health,
// check-variation-appeal or check-ticket-health runs — a ticket health check
// held by the project it would run on, the harness project — and holds those
// already going; a sprint ticket's gap resolution and its Blocked step go on.
// Read every tick: switched on, the work resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const engineFile = f => join(f.dir, 'engines', 'example-development', 'state-engine.json');
const step = { id: 'x', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] };

// The fixture with every background trigger due on p's engine — check-health
// every 300 s, check-variation-appeal every 600 s (ABC-3 has a second
// variation), check-ticket-health every 2nd state change, p the harness
// project — and a clock the test moves.
function background() {
  const f = controlFixture();
  edit(engineFile(f), e => {
    Object.assign(e, { 'check-health-interval-seconds': 300, 'check-variation-appeal-interval-seconds': 600, 'check-ticket-health-sample-every': 2 });
    e['check-ticket-health-steps'] = [{ ...step, id: 'check-ticket-health' }];
    e['check-variation-appeal-steps'] = [{ ...step, id: 'check-variation-appeal' }];
  });
  edit(join(f.dir, 'harness.json'), h => { h['harness-project'] = 'p'; h['max-tickets-in-planning'] = 2; });   // A and B both in planning (ASS-126: a planning step takes a slot)
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations.push({ name: 'B', 'harness-status': { state: 'plan', 'state-engine': 'example-development' }, 'state-changes': [{ 'from-state': 'committed', 'to-state': 'plan', 'agent-dispatch-log': [] }] }); });
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  const triggers = () => f.assignments()['transient-state-engines'].map(r => r.parent.trigger).filter(Boolean);
  return { ...f, triggers, later: seconds => { clock += seconds * 1000; } };
}

test('tick: with p\'s background work off, no check-health, check-variation-appeal or check-ticket-health run starts while its tickets move; switched on, they start again', async () => {
  const f = background();
  try {
    await f.agent('project:set-background-work', 'p', 'off');
    await tick(f.ctx);                                                                           // A moves twice: a sample, dropped
    assert.equal(f.variation()['harness-status'].state, 'plan');
    f.later(600);
    await tick(f.ctx);
    f.later(600);
    await tick(f.ctx);
    assert.deepEqual(f.triggers(), []);
    await f.agent('project:set-background-work', 'p', 'on');
    f.later(600);
    await tick(f.ctx);
    assert.deepEqual(f.triggers().toSorted(), ['check-health', 'check-variation-appeal']);
  } finally {
    f.ctx.stopAgents();
  }
});

// The fixture with h as the harness project, on its own engine, the only one
// that checks ticket health, sampling every 2nd state change of any project.
function harnessProject() {
  const f = controlFixture();
  const engine = JSON.parse(readFileSync(engineFile(f), 'utf8'));
  for (const key of ['check-health-interval-seconds', 'check-variation-appeal-interval-seconds', 'check-ticket-health-sample-every', 'check-health-steps']) delete engine[key];
  writeFileSync(engineFile(f), JSON.stringify(engine));
  mkdirSync(join(f.dir, 'engines', 'harness-e'));
  writeFileSync(join(f.dir, 'engines', 'harness-e', 'state-engine.json'), JSON.stringify({ ...engine, 'check-ticket-health-sample-every': 2, 'check-ticket-health-steps': [{ ...step, id: 'check-ticket-health' }] }));
  mkdirSync(join(f.dir, 'projects', 'h', 'sprints', 'sprint-1'), { recursive: true });
  writeFileSync(join(f.dir, 'projects', 'h', 'project.json'), JSON.stringify({ name: 'H', 'execution-state-engine': 'harness-e', 'work-sources': [], 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: join(f.dir, 'workspace'), 'active-branch': null }] }, null, 4));
  writeFileSync(join(f.dir, 'projects', 'h', 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(join(f.dir, 'projects', 'h', 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [], bugs: [], spikes: [] }));
  edit(join(f.dir, 'harness.json'), h => { h['harness-project'] = 'h'; });
  return { ...f, healthRuns: () => f.assignments()['transient-state-engines'].filter(r => r.parent.trigger === 'check-ticket-health').map(r => [r.project, r.parent['ticket-project']]) };
}

test('tick: a ticket health check sampled from p\'s moves is held by the project it would run on — none with the harness project\'s background work off, one with only p\'s off', async () => {
  for (const [off, runs] of [['h', []], ['p', [['h', 'p']]]]) {
    const f = harnessProject();
    try {
      await f.agent('project:set-background-work', off, 'off');
      await tick(f.ctx);                                                                         // p's ABC-3 moves twice: sampled
      assert.notEqual(f.variation()['harness-status'].state, 'backlog');
      assert.deepEqual(f.healthRuns(), runs, `${off} off`);
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('tick: with p\'s background work off, a sprint ticket\'s gap resolution starts and its Blocked step\'s run starts and gets an agent', async () => {
  const f = controlFixture();
  edit(engineFile(f), e => { e.steps.find(s => s.id === 'blocked').action = { type: 'state-engine', engine: 'test' }; });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';                                       // backlog pairs Backlog: a gap
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'Blocked', variations: [{ name: 'A', 'harness-status': { state: 'blocked', 'state-engine': 'example-development' }, 'state-changes': [{ 'from-state': 'plan', 'to-state': 'blocked', 'agent-dispatch-log': [] }] }] });
  });
  const runs = () => f.assignments()['transient-state-engines'].map(r => [r['state-engine'], r.parent.trigger ?? r.parent['work-item']]);
  try {
    await f.agent('project:set-background-work', 'p', 'off');
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(runs().filter(r => r[0] !== 'investigate-gap').toSorted(), [['example-development/gap-resolution-steps', 'gap-resolution'], ['test', 'ABC-4']]);
    assert.ok(f.assignments().assignments.some(a => a['work-item'] === 'ABC-4'), JSON.stringify(f.assignments().assignments));
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a background run already going on p — and the runs under it — is held while p\'s background work is off: not moved, no agent; switched on, it goes on', async () => {
  const f = controlFixture();
  await f.agent('transient-state-engine:create', 'p', 'example-development/check-health-steps', 'check-health', JSON.stringify({ trigger: 'check-health' }));
  const runs = () => f.assignments()['transient-state-engines'].map(r => [r['state-engine'], r.state]);
  const agents = () => f.assignments().assignments.filter(a => a['transient-state-engine']).length;
  try {
    await f.agent('project:set-background-work', 'p', 'off');
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(runs(), [['example-development/check-health-steps', 'check-health']], 'its sub-engine run not started');
    await f.agent('project:set-background-work', 'p', 'on');
    await tick(f.ctx);                                                                           // its investigate-gap run starts, and gets an agent
    assert.deepEqual(runs(), [['example-development/check-health-steps', 'check-health'], ['investigate-gap', 'investigate']]);
    assert.equal(agents(), 1);
    f.ctx.stopAgents();
    await f.agent('assignments:remove', f.assignments().assignments[0]['agent-name']);
    await f.agent('project:set-background-work', 'p', 'off');
    await tick(f.ctx);
    assert.equal(agents(), 0, 'the run under it gets no agent');
    await f.agent('transient-state-engine:change-state', f.assignments()['transient-state-engines'][1].id, 'investigate', 'done');   // as though its agent had finished
    await tick(f.ctx);
    assert.deepEqual(runs(), [['example-development/check-health-steps', 'check-health'], ['investigate-gap', 'done']], 'not moved');
    await f.agent('project:set-background-work', 'p', 'on');
    await tick(f.ctx);
    assert.deepEqual(runs(), [], 'finished once on');
  } finally {
    f.ctx.stopAgents();
  }
});
