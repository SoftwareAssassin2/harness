// ASS-355: a ticket waits on what it depends on at any step, a dependency
// assigned to someone else included, without holding a seat. In a project
// with wait-for-dependencies: true, a sprint variation whose ticket depends on
// a ticket not done — in the sprint, the backlog, another project, or the
// downloader's outside-tickets.json — is held at its step: no agent, no step
// script, no sub-engine run, no slot or seat (the next ticket takes it), its
// VM stopped; an agent already running finishes its turn; the hold lifts with
// no re-run and no visit spent. Done is the status the engine's is-done step
// pairs. Driven tick by tick on the control fixture, a fake agent and, for the
// VM, a fake limactl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { planFor } from '../../src/control/plan.js';
import { superviseVms } from '../../src/control/vm-lifecycle.js';
import { until } from '../support/until.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const STATUS = { committed: 'To Do', plan: 'In Progress', build: 'In Progress', 'local-testing': 'In Progress', done: 'Done' };
// A sprint ticket, its one variation at `state` (a sub-status given as [engine, step]).
const at = (key, state, extra = {}, sub) => ({ key, title: key, 'ticket-system-status': STATUS[state], priority: Number(key.split('-')[1]), dependencies: [], variations: [{ name: 'A', 'harness-status': { ...hs(state), ...(sub ? { 'sub-status': { 'state-engine': sub[0], state: sub[1] } } : {}) }, 'state-changes': [] }], ...extra });
// An outside ticket, as ticket:sync-outside records it.
const outsider = (key, status, assignee = 'A Teammate') => ({ key, title: `Outside ${key}`, url: `https://example.test/browse/${key}`, 'ticket-system-status': status, 'ticket-system-assignment': assignee });

// The control fixture with p's sprint `sprint`, its outside-tickets.json
// `outside`, wait-for-dependencies on, and harness.json's `limits`.
function holding({ sprint = [], outside = [], limits = {} } = {}) {
  const f = controlFixture();
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, { 'max-tickets-in-planning': 5 }, limits));
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['wait-for-dependencies'] = true; });
  const sprintFile = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  edit(sprintFile, s => { s.features = sprint; });
  writeFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [] }));
  const outsideFile = join(f.dir, 'projects', 'p', 'outside-tickets.json');
  const setOutside = list => writeFileSync(outsideFile, JSON.stringify({ tickets: list }, null, 4));
  setOutside(outside);
  const inSprint = key => f.sprint().features.find(t => t.key === key);
  return {
    ...f,
    setOutside,
    editSprint: change => edit(sprintFile, change),
    inSprint,
    variationOf: key => inSprint(key).variations[0],
    stateOf: key => inSprint(key).variations[0]['harness-status'].state,
    dispatched: key => f.lines.filter(l => new RegExp(`^cli agent\\.sh assignments:create p \\S+ \\S+ \\S+ \\S+ \\S+ ${key} A `).test(l)).length,
    calls: pattern => f.lines.filter(l => pattern.test(l)),
    ticks: async (n = 1) => { for (let i = 0; i < n; i++) await tick(f.ctx); },
  };
}

test('ASS-355 AC1, AC2: a ticket at plan whose outside dependency is not done gets no agent and no slot; the wait is logged once', async () => {
  const f = holding({ sprint: [at('ABC-1', 'plan', { dependencies: ['EX-1'] })], outside: [outsider('EX-1', 'In Progress')] });
  try {
    await f.ticks(3);
    assert.equal(f.dispatched('ABC-1'), 0, f.lines.join('\n'));
    assert.equal(f.stateOf('ABC-1'), 'plan');
    assert.equal(f.calls(/: waits on EX-1$/).length, 1, f.lines.join('\n'));
    assert.equal(f.calls(/^dependencies ABC-1 A plan: waits on EX-1$/).length, 1, f.lines.join('\n'));
    const state = f.ctx.load(), project = state.projects.find(p => p.id === 'p');
    const plan = planFor(state, project);
    assert.deepEqual([plan.inPlanning, plan.reserved, plan.waiting, plan.dispatch], [[], [], [], []]);
  } finally { f.ctx.stopAgents(); }
});

test('ASS-355 AC1: a ticket at a script step (build) is held there — no script started — and one at a sub-engine step starts no run', async () => {
  const f = holding({ sprint: [at('ABC-1', 'build', { dependencies: ['EX-1'] }), at('ABC-2', 'local-testing', { dependencies: ['EX-1'] })], outside: [outsider('EX-1', 'To Do')], limits: { 'max-tickets-in-progress': 5 } });
  try {
    await f.ticks(2);
    assert.equal(f.stateOf('ABC-1'), 'build', f.lines.join('\n'));
    assert.deepEqual(f.calls(/ABC-1 A build →/), []);
    assert.deepEqual(f.calls(/transient-state-engine:create/), [], f.lines.join('\n'));
    assert.equal(f.dispatched('ABC-2'), 0);
    assert.equal(f.calls(/ABC-1 A build: waits on EX-1$/).length, 1, f.lines.join('\n'));
    assert.equal(f.calls(/ABC-2 A local-testing: waits on EX-1$/).length, 1, f.lines.join('\n'));
  } finally { f.ctx.stopAgents(); }
});

test('ASS-355 AC2 (release, scope 5): the outside dependency turning done releases the dependent at its step on the next tick — the script runs once, no step re-run, no visit spent', async () => {
  const f = holding({ sprint: [at('ABC-1', 'build', { dependencies: ['EX-1'] })], outside: [outsider('EX-1', 'In Review')], limits: { 'max-tickets-in-progress': 5 } });
  try {
    await f.ticks(2);
    const before = f.variationOf('ABC-1')['state-changes'].length;
    assert.equal(f.stateOf('ABC-1'), 'build');
    f.setOutside([outsider('EX-1', 'Done')]);
    await f.ticks();
    const changes = f.variationOf('ABC-1')['state-changes'];
    assert.deepEqual(changes.slice(before).map(c => [c['from-state'], c['to-state']]).slice(0, 1), [['build', 'local-testing']], f.lines.join('\n'));
    assert.equal(changes.filter(c => c['to-state'] === 'build').length, 0, 'never re-entered build: no visit spent there');
  } finally { f.ctx.stopAgents(); }
});

test('ASS-355 AC2 (release, scope 5): a prompt step held then released gets its agent at the same step, its state-changes untouched — no visit spent', async () => {
  const f = holding({ sprint: [at('ABC-1', 'plan', { dependencies: ['EX-1'] })], outside: [outsider('EX-1', 'In Progress')] });
  try {
    await f.ticks(2);
    const changes = f.variationOf('ABC-1')['state-changes'].length;
    f.setOutside([outsider('EX-1', 'Done')]);
    await f.ticks();
    assert.equal(f.dispatched('ABC-1'), 1, f.lines.join('\n'));
    assert.equal(f.stateOf('ABC-1'), 'plan');
    assert.equal(f.variationOf('ABC-1')['state-changes'].length, changes);
  } finally { f.ctx.stopAgents(); }
});

test('ASS-355 AC3: done is the status the engine\'s is-done step pairs — an engine pairing "Released" holds on "Done" and lifts on "Released"', async () => {
  const f = holding({ sprint: [at('ABC-1', 'plan', { dependencies: ['EX-1', 'ABC-2'] }), at('ABC-2', 'build', { 'ticket-system-status': 'Done' })], outside: [outsider('EX-1', 'Done')] });
  try {
    edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps.find(s => s.id === 'done')['paired-ticket-system-status'] = 'Released'; });
    await f.ticks();
    assert.equal(f.dispatched('ABC-1'), 0, f.lines.join('\n'));
    assert.equal(f.calls(/ABC-1 A plan: waits on EX-1, ABC-2$/).length, 1, f.lines.join('\n'));
    f.setOutside([outsider('EX-1', 'Released')]);
    f.editSprint(s => { s.features.find(t => t.key === 'ABC-2')['ticket-system-status'] = 'Released'; });
    await f.ticks();
    assert.equal(f.dispatched('ABC-1'), 1, f.lines.join('\n'));
  } finally { f.ctx.stopAgents(); }
});

test('ASS-355 AC4: an agent running when the hold begins finishes its turn — not killed — its finish moves the ticket on, and the next step waits', async () => {
  const f = holding({ sprint: [at('ABC-1', 'plan')], limits: { 'max-tickets-in-progress': 5 } });
  const hold = join(f.dir, 'hold');
  writeFileSync(hold, '');
  process.env.FAKE_HOLD = hold;
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await f.ticks();
    assert.equal(f.dispatched('ABC-1'), 1, f.lines.join('\n'));
    const [record] = f.assignments().assignments;
    const live = f.ctx.agents.get(record['agent-name']);
    // The hold begins: ABC-1 now depends on an outside ticket not done.
    f.editSprint(s => { s.features[0].dependencies = ['EX-1']; });
    f.setOutside([outsider('EX-1', 'In Progress')]);
    await f.ticks(2);
    assert.ok(f.ctx.agents.has(record['agent-name']), 'its agent still there');
    assert.ok(!live.result, 'mid-turn still');
    assert.deepEqual(f.calls(/stop|shut down|killed/i).filter(l => /ABC-1|Donkey|agent/.test(l) && !/waits/.test(l)), [], f.lines.join('\n'));
    rmSync(hold);
    await until(() => [...f.ctx.agents.values()].every(a => a.result));
    await f.ticks(2);
    assert.ok(f.lines.some(l => /^finish ABC-1 A plan → build$/.test(l)), f.lines.join('\n'));
    assert.equal(f.stateOf('ABC-1'), 'build', 'held at build: its script not started');
    assert.equal(f.dispatched('ABC-1'), 1);
    assert.deepEqual(f.calls(/ABC-1 A build →/), [], f.lines.join('\n'));
    assert.equal(f.calls(/ABC-1 A \S+: waits on EX-1$/).length, 1, 'said once: what it waits on has not changed');
  } finally {
    delete process.env.FAKE_HOLD;
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('ASS-355 AC6: a held variation frees its planning slot — the next ticket gets it; without the hold it would not', async () => {
  for (const held of [true, false]) {
    const f = holding({ sprint: [at('ABC-1', 'plan', { dependencies: ['EX-1'] }), at('ABC-2', 'committed')], outside: [outsider('EX-1', held ? 'In Progress' : 'Done')], limits: { 'max-tickets-in-planning': 1 } });
    try {
      await f.ticks();
      assert.equal(f.stateOf('ABC-2'), held ? 'plan' : 'committed', `${held}\n${f.lines.join('\n')}`);
      assert.equal(f.dispatched('ABC-2'), held ? 1 : 0, f.lines.join('\n'));
      assert.equal(f.dispatched('ABC-1'), held ? 0 : 1, f.lines.join('\n'));
    } finally { f.ctx.stopAgents(); }
  }
});

test('ASS-355 AC6: a held variation frees its in-progress slot — the next ticket\'s run gets the agent; a held run already there gets none until released', async () => {
  const f = holding({ sprint: [at('ABC-1', 'local-testing', { dependencies: ['EX-1'] }), at('ABC-2', 'local-testing')], outside: [outsider('EX-1', 'Done')], limits: { 'max-tickets-in-progress': 1 } });
  try {
    // Both runs made, no agent yet (max-agents 0): ABC-1 ranks first and holds the one in-progress slot.
    edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['max-agents'] = 0; });
    await f.ticks();
    assert.equal(f.assignments()['transient-state-engines'].length, 2, f.lines.join('\n'));
    assert.equal(planFor(f.ctx.load(), f.ctx.load().projects[0]).reserved.map(r => r.key).join(), 'ABC-1');
    // The hold begins (EX-1 back in progress) and agents are allowed: ABC-2 takes the slot and its run's agent; ABC-1's run none.
    f.setOutside([outsider('EX-1', 'In Progress')]);
    edit(join(f.dir, 'projects', 'p', 'project.json'), p => { delete p['max-agents']; });
    await f.ticks();
    assert.equal(planFor(f.ctx.load(), f.ctx.load().projects[0]).reserved.map(r => r.key).join(), 'ABC-2');
    const working = () => f.assignments().assignments.map(a => a['work-item']).toSorted();
    assert.deepEqual(working(), ['ABC-2'], f.lines.join('\n'));
    assert.equal(f.calls(/: waits on EX-1$/).length, 1, f.lines.join('\n'));   // once, whichever path asked first
  } finally { f.ctx.stopAgents(); }
});

test('ASS-355 AC5: a person-only step is never held — at Blocked for Human no wait is logged and nothing is planned, the dependency not done', async () => {
  const f = holding({ sprint: [at('ABC-1', 'blocked', { dependencies: ['EX-1'], 'ticket-system-status': 'Blocked' })], outside: [outsider('EX-1', 'In Progress')] });
  try {
    await f.ticks();
    assert.deepEqual(f.calls(/waits on EX-1/), [], f.lines.join('\n'));
    const state = f.ctx.load();
    assert.deepEqual(planFor(state, state.projects[0]).dispatch, []);
  } finally { f.ctx.stopAgents(); }
});

test('ASS-355 AC8: a project with wait-for-dependencies off holds nothing past Committed, an outside dependency not done', async () => {
  const f = holding({ sprint: [at('ABC-1', 'plan', { dependencies: ['EX-1'] })], outside: [outsider('EX-1', 'In Progress')] });
  try {
    edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['wait-for-dependencies'] = false; });
    await f.ticks();
    assert.equal(f.dispatched('ABC-1'), 1, f.lines.join('\n'));
  } finally { f.ctx.stopAgents(); }
});

// The VM job (superviseVms) on the real grouped engine, as tick-vm-hold.test.js drives it: ABC-3 A at Build, its VM
// abc-3-a Running, depending on EX-1 outside; agent.sh a recorder, limactl a fake.
const ENGINE = 'example-development-grouped';
function vmHeld(status) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  for (const name of engineNames()) if (!existsSync(file('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), file('engines', name), { recursive: true });
  edit(file('harness.json'), h => { h['max-tickets-in-progress'] = null; });
  edit(file('projects', 'p', 'project.json'), p => { p['execution-state-engine'] = ENGINE; p['wait-for-dependencies'] = true; });
  const v = fakeVm(f.env);
  v.instance('abc-3-a', 'Running');
  writeFileSync(file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', 'ticket-system-status': 'In Progress', dependencies: ['EX-1'], variations: [{
    name: 'A', 'harness-status': { state: 'build', 'state-engine': ENGINE, 'sub-status': { state: 'generate-solution', 'state-engine': 'grouped-build' } }, 'state-changes': [],
    vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' },
  }] }] }));
  const outside = s => writeFileSync(file('projects', 'p', 'outside-tickets.json'), JSON.stringify({ tickets: [outsider('EX-1', s)] }));
  outside(status);
  const home = file('harness-home');
  mkdirSync(home, { recursive: true });
  f.ctx.env = { ...v.env, HARNESS_HOME: home };
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); return ''; };
  const assign = on => edit(f.ctx.paths.assignments, data => { data.assignments = on ? [{ 'agent-name': 'Donkey', project: 'p', 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'grouped-build', state: 'generate-solution', status: 'Running', 'process-id': 4242 }] : []; });
  const pass = async () => {
    const before = calls.length;
    await superviseVms(f.ctx, f.ctx.load());
    await Promise.all([...f.ctx.memory.vms.values()].map(r => r.job));
    return calls.slice(before).sort();
  };
  return { f, v, outside, assign, pass };
}

test('ASS-355 AC1: a held variation\'s Running VM is stopped as one waiting for a slot is, said why; started again once the hold lifts', async () => {
  const h = vmHeld('In Progress');
  assert.deepEqual(await h.pass(), ['vm:stop p abc-3-a']);
  assert.ok(h.f.lines.includes('vm p abc-3-a: stopped (ABC-3 A at build; waits on EX-1)'), h.f.lines.join('\n'));
  h.v.instance('abc-3-a', 'Stopped');
  assert.deepEqual(await h.pass(), []);   // held: stays stopped
  h.outside('Done');
  assert.deepEqual(await h.pass(), ['vm:start p ABC-3 A']);
});

test('ASS-355 AC4 with ASS-349: a held variation\'s VM with its agent still at work is not stopped until that agent finishes', async () => {
  const h = vmHeld('In Progress');
  h.assign(true);
  assert.deepEqual(await h.pass(), []);
  assert.ok(h.f.lines.includes('vm p abc-3-a: to stop (ABC-3 A at build; waits on EX-1); waits until its agent finishes'), h.f.lines.join('\n'));
  h.assign(false);
  assert.deepEqual(await h.pass(), ['vm:stop p abc-3-a']);
});
