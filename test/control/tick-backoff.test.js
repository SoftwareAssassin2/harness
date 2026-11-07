// A step whose agent fails — an error result, or a process that dies before
// ending its turn — is not dispatched again at once: control backs off, longer
// each time, and the ticket stays where it is until an attempt succeeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const ended = ctx => until(() => [...ctx.agents.values()].every(a => a.result || a.exited));

for (const [failure, env, said] of [['an error result', 'FAKE_ERROR', /ended its turn in an error/], ['a process that dies mid-turn', 'FAKE_EXIT', /exited without ending its turn/]]) {
  test(`tick: after ${failure} the step is held — 30s, then 60s — and tried again once the hold is over; success moves on and forgets the failures`, async () => {
    const f = controlFixture();
    let now = Date.parse('2026-10-12T12:00:00Z');
    f.ctx.now = () => new Date(now);
    const agents = () => f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3').length;   // the fixture's timed health check runs too
    try {
      process.env[env] = '1';
      await tick(f.ctx);                                                  // backlog → committed → plan, an agent on it
      assert.equal(agents(), 1);
      assert.ok(await ended(f.ctx));
      await tick(f.ctx);
      assert.ok(f.lines.some(l => said.test(l) && /tried again in 30s/.test(l)), f.lines.join('\n'));
      assert.equal(f.variation()['harness-status'].state, 'plan');       // not moved on by a failed turn
      assert.equal(agents(), 0);                                          // and not dispatched again at once
      now += 29e3; await tick(f.ctx);
      assert.equal(agents(), 0);
      now += 2e3; await tick(f.ctx);                                     // the hold is over: tried again, failing again
      assert.equal(agents(), 1);
      assert.ok(await ended(f.ctx));
      await tick(f.ctx);
      assert.ok(f.lines.some(l => /tried again in 60s/.test(l)), f.lines.join('\n'));
      delete process.env[env];
      process.env.FAKE_OUTPUT = '{"is-approved":true}';
      now += 61e3; await tick(f.ctx);
      assert.ok(await ended(f.ctx));
      await tick(f.ctx);
      assert.notEqual(f.variation()['harness-status'].state, 'plan');   // succeeded: moved on
      assert.equal(f.ctx.memory.backoff.size, 0);
    } finally {
      delete process.env[env]; delete process.env.FAKE_OUTPUT;
      f.ctx.stopAgents();
    }
  });
}

test('tick: a script step that fails back into itself is held between tries, not re-run at once until it runs out of visits', async () => {
  const f = controlFixture();
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {     // build's script always fails: a bad usage
    e.steps.find(s => s.id === 'build').action.command = './agent.sh ticket:set-paused {project} {ticket} {variation} maybe';
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = { state: 'build', 'state-engine': 'example-development' };
  });
  let now = Date.parse('2026-10-12T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const runs = () => f.lines.filter(l => /ticket:set-paused p ABC-3 A maybe/.test(l)).length;
  try {
    await tick(f.ctx);
    assert.equal(runs(), 1, f.lines.join('\n'));                          // ran once, failed, held
    assert.equal(f.variation()['harness-status'].state, 'build');
    await tick(f.ctx);
    assert.equal(runs(), 1);
    now += 31e3; await tick(f.ctx);
    assert.equal(runs(), 2);
    assert.equal(f.variation()['harness-status'].state, 'build');        // still visits to spare, not blocked yet
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a failing script step whose exit sends it elsewhere (to Blocked) logs its exit code, not a retry it will not get (ASS-236 AC5)', async () => {
  const f = controlFixture();
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    const build = e.steps.find(s => s.id === 'build');
    build.action.command = './agent.sh ticket:set-paused {project} {ticket} {variation} maybe';
    build['exit-events'][1]['move-to-state'] = 'blocked';
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = { state: 'build', 'state-engine': 'example-development' };
  });
  try {
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'blocked', f.lines.join('\n'));
    assert.ok(f.lines.some(l => /^steps ABC-3 A build: script exited [1-9]\d*$/.test(l)), f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /tried again/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-240 AC1: a failed script step is kept on its variation (last-script-failure: the step, its exit code, when),
// so the grouped health check — another project's control, which never saw it — reads it in the sprint.
test('ASS-240 AC1: a script step that fails is recorded on its variation as its last-script-failure', async () => {
  const f = controlFixture();
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.find(s => s.id === 'build').action.command = './agent.sh ticket:set-paused {project} {ticket} {variation} maybe';
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = { state: 'build', 'state-engine': 'example-development' };
  });
  try {
    await tick(f.ctx);
    const exited = Number(f.lines.find(l => /ABC-3 A build: script exited [1-9]/.test(l))?.match(/exited (\d+)/)[1]);
    const { timestamp, ...failure } = f.variation()['last-script-failure'];
    assert.deepEqual(failure, { step: 'ABC-3 A build', 'exit-code': exited });
    assert.match(timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  } finally {
    f.ctx.stopAgents();
  }
});
