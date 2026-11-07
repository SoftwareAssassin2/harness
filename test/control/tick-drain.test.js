// A restart's drain (ASS-200): once a restart is asked for, control starts no
// new work — nothing dispatched — while its running agents end their turns,
// up to harness.json's restart-drain-seconds (300 by default); then it stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick, startDrain, drained } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const working = f => f.assignments().assignments.map(a => a['work-item']).toSorted();
// ABC-4 added at plan, ready for an agent.
function addTicket(f) {
  const sprint = f.sprint();
  sprint.features.push({ key: 'ABC-4', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': hs('plan'), 'state-changes': [] }] });
  writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
}
// The fixture with its agents held at work (FAKE_HOLD) while fn runs.
async function held(fn) {
  const f = controlFixture();
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  try { return await fn(f); } finally { delete process.env.FAKE_HOLD; delete process.env.FAKE_OUTPUT; f.ctx.stopAgents(); }
}

test('ASS-200: while draining nothing is dispatched; the running agent ends its turn and is reaped, and then the drain is over', async () => {
  await held(async f => {
    await tick(f.ctx);
    assert.deepEqual(working(f), ['ABC-3']);                              // ABC-3's plan agent, held at work
    addTicket(f);
    startDrain(f.ctx);
    assert.equal(drained(f.ctx), false);
    assert.deepEqual(f.lines.filter(l => l.startsWith('restart ')), ['restart waiting for 1 agent to end its turn (up to 300s), dispatching none']);
    const before = f.lines.length;
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(drained(f.ctx), false);                                  // still 1: not logged again
    assert.deepEqual(working(f), ['ABC-3']);                              // ABC-4 not dispatched
    assert.ok(!f.lines.slice(before).some(l => /^dispatch /.test(l)), f.lines.slice(before).join('\n'));
    assert.equal(f.lines.filter(l => l.startsWith('restart ')).length, 1);
    rmSync(process.env.FAKE_HOLD);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);                                                    // finish reaps it
    assert.equal(f.ctx.agents.size, 0);
    assert.deepEqual(working(f), []);                                     // and nothing new took its seat
    assert.equal(drained(f.ctx), true);
  });
});

test('ASS-200: the drain ends at restart-drain-seconds with agents still running, saying so; they are left for control\'s shut-down to stop', async () => {
  await held(async f => {
    writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...f.harness(), 'restart-drain-seconds': 60 }));
    await tick(f.ctx);
    let clock = Date.now();
    f.ctx.now = () => new Date(clock);
    startDrain(f.ctx);
    assert.ok(f.lines.includes('restart waiting for 1 agent to end its turn (up to 60s), dispatching none'), f.lines.join('\n'));
    clock += 59_000;
    assert.equal(drained(f.ctx), false);
    clock += 1_000;
    assert.equal(drained(f.ctx), true);
    assert.ok(f.lines.includes('restart 1 agent still running after 60s: stopped with control'), f.lines.join('\n'));
    assert.equal(f.ctx.agents.size, 1);
  });
});

test('ASS-200: a drain with no agent running is over at once', async () => {
  const f = controlFixture();
  startDrain(f.ctx);
  assert.equal(drained(f.ctx), true);
  await tick(f.ctx);
  assert.deepEqual(working(f), []);                                       // a drained control dispatches nothing either
});

test('ASS-236 AC2: a draining control still runs its script steps (and starts their sub-engine runs), dispatching none', async () => {
  const f = controlFixture();
  const sprint = f.sprint();
  Object.assign(sprint.features[0], { 'ticket-system-status': 'In Progress' });
  sprint.features[0].variations[0]['harness-status'] = hs('build');
  writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
  startDrain(f.ctx);
  await tick(f.ctx);
  assert.equal(f.variation()['harness-status'].state, 'local-testing', f.lines.join('\n'));   // build's script ran and moved it on
  assert.deepEqual(f.assignments()['transient-state-engines'].map(r => r['state-engine']), ['test']);
  assert.deepEqual(working(f), []);                                       // its run's agent not dispatched
  assert.ok(!f.lines.some(l => /^dispatch /.test(l)), f.lines.join('\n'));
});

test('ASS-236 AC2: a control whose own agents are done stays drained-but-running while another control\'s agents still work, until they end or restart-drain-seconds pass', async () => {
  const f = controlFixture();
  const file = join(f.dir, 'assignments.json');
  const other = { 'agent-name': 'q-agent', project: 'q', 'work-item': 'XYZ-1', variation: 'A', state: 'plan', status: 'Working', 'process-id': process.pid };   // alive
  const stale = { ...other, 'agent-name': 'r-agent', project: 'r', 'process-id': 999_999_999 };                                                         // its process gone: not waited for
  const write = assignments => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), assignments }));
  write([other, stale]);
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  startDrain(f.ctx);
  assert.equal(drained(f.ctx), false);
  assert.ok(f.lines.includes('restart waiting for 0 agents of its own and 1 of other controls to end their turns (up to 300s), dispatching none'), f.lines.join('\n'));
  write([stale]);
  assert.equal(drained(f.ctx), true);                                     // the last control's agents are done: every control exits
  write([other]);
  startDrain(f.ctx);
  clock += 300_000;
  assert.equal(drained(f.ctx), true);                                     // not forever
  assert.ok(f.lines.includes('restart 1 agent of other controls still running after 300s: this control exits all the same'), f.lines.join('\n'));
});
