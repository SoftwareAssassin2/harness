// An agent whose turn ended with background work still going (ASS-334): a
// backgrounded Bash, a ScheduleWakeup armed, a Monitor, a Workflow or a
// sub-agent. Finish holds the whole assignment group — the pen-holder and its
// pair — while any of their last turns left work pending, logging the wait
// once per span, and finishes as before once a later turn ends with nothing
// pending. The hold is bounded (agent-pending-work-wait-seconds, 30 minutes by
// default): work that never completes still releases the agent, logged as a
// timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';
import { sessionDir } from '../../src/agents/session.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const engineFile = f => join(f.dir, 'engines', 'example-development', 'state-engine.json');
// The agents named by the lines finish logged while it waited on pending work, and by the timeouts.
const named = lines => lines.map(l => l.split(' ')[1].replace(/:$/, ''));
const waiting = f => f.lines.filter(l => /^finish \S+: turn ended with pending background work; waiting up to .+ before finishing$/.test(l));
const timedOut = f => f.lines.filter(l => /^finish \S+: pending background work still outstanding after .+; finishing anyway \(timeout\)$/.test(l));
const assigned = f => f.assignments().assignments.map(a => a['agent-name']);
// A prompt queued in the agent's session inbox: startAgent's poller sends it
// to its stdin, so the fake agent answers another turn (process.js).
const prompt = (f, record, text) => appendFileSync(join(sessionDir(f.dir, record['agent-name'], record['start-time']), 'inbox.jsonl'), `${JSON.stringify({ prompt: text })}\n`);
// Another turn of the agent: the prompt that asks for it queued in its
// inbox, waited out until its next result lands.
const nextTurn = (f, live, record) => { const was = live.result; prompt(f, record, 'next'); return until(() => live.result !== was); };
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
// The plan step dispatched (one tick), the records it was dispatched on.
const dispatch = async f => { await tick(f.ctx); return f.assignments().assignments; };

// AC1: each shape of background work that leaves a turn pending.
for (const shape of ['bash', 'schedule', 'monitor', 'workflow', 'agent']) {
  test(`ASS-334 AC1: a turn that ended with ${shape} work pending leaves its assignment, its agent and its process alone, the wait logged once`, async () => {
    const f = controlFixture();
    process.env.FAKE_PENDING = shape;
    try {
      const [record] = await dispatch(f);
      const name = record['agent-name'];
      assert.ok(await turnsEnd(f.ctx));
      const live = f.ctx.agents.get(name);
      const { pid } = live.agent;
      await tick(f.ctx);
      assert.deepEqual(assigned(f), [name], f.lines.join('\n'));
      assert.ok(f.ctx.agents.has(name), f.lines.join('\n'));
      assert.ok(alive(pid), 'its process was signalled');
      assert.deepEqual(Object.keys(live.pending ?? {}), ['at'], JSON.stringify(live.pending));
      assert.deepEqual(named(waiting(f)), [name], f.lines.join('\n'));
      await tick(f.ctx);                                                         // the same pending span: the wait is logged once
      assert.deepEqual(named(waiting(f)), [name], f.lines.join('\n'));
      assert.deepEqual(assigned(f), [name], f.lines.join('\n'));
      assert.ok(alive(pid), 'its process was signalled');
    } finally {
      delete process.env.FAKE_PENDING;
      f.ctx.stopAgents();
    }
  });
}

// AC1: what is not pending work — a wakeup cancelled, a sub-agent in the
// foreground, a turn of nothing but text — finishes as it did before.
for (const [shape, what] of [['schedule-stop', 'a cancelled wakeup'], ['agent-foreground', 'a foreground sub-agent'], [null, 'nothing but text']]) {
  test(`ASS-334 AC1: a turn that ended with ${what} is not pending work: its agent is finished as before`, async () => {
    const f = controlFixture();
    if (shape) process.env.FAKE_PENDING = shape;
    try {
      const [record] = await dispatch(f);
      assert.ok(await turnsEnd(f.ctx));
      await tick(f.ctx);
      assert.ok(!assigned(f).includes(record['agent-name']), f.lines.join('\n'));
      assert.ok(!f.ctx.agents.has(record['agent-name']), f.lines.join('\n'));
      assert.deepEqual(waiting(f), [], f.lines.join('\n'));
      assert.ok(f.lines.some(l => /^finish \S+ ended \(\$0\.5000\)$/.test(l)), f.lines.join('\n'));
    } finally {
      delete process.env.FAKE_PENDING;
      f.ctx.stopAgents();
    }
  });
}

test('ASS-334 AC1: a rate-limited turn that also left work pending is still ended, its project held — the hold does not suppress the rate limit', async () => {
  const f = controlFixture();
  process.env.FAKE_PENDING = 'bash';
  process.env.FAKE_RATE_LIMIT = String(inAnHour());
  try {
    const [record] = await dispatch(f);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.ok(f.lines.some(l => /^finish \S+: rate limited \(five_hour\) on p's claude credential/.test(l)), f.lines.join('\n'));
    assert.ok(!assigned(f).includes(record['agent-name']), f.lines.join('\n'));
    assert.deepEqual(waiting(f), [], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_RATE_LIMIT;
    f.ctx.stopAgents();
  }
});

test('ASS-334 AC1: a process that died in its pending turn, before any result, is finished as before — the hold does not suppress an exit', async () => {
  const f = controlFixture();
  process.env.FAKE_PENDING = 'bash';
  process.env.FAKE_EXIT = '1';
  try {
    const [record] = await dispatch(f);
    assert.ok(await until(() => [...f.ctx.agents.values()].every(a => a.exited)));
    await tick(f.ctx);
    assert.ok(!f.ctx.agents.has(record['agent-name']), f.lines.join('\n'));
    assert.ok(f.lines.some(l => /exited without ending its turn/.test(l)), f.lines.join('\n'));
    assert.deepEqual(waiting(f), [], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_EXIT;
    f.ctx.stopAgents();
  }
});

test('ASS-334 AC1: an agent whose process dies after its pending turn is not held: it is finished on the next tick', async () => {
  const f = controlFixture();
  process.env.FAKE_PENDING = 'schedule';
  try {
    const [record] = await dispatch(f);
    assert.ok(await turnsEnd(f.ctx));
    const live = f.ctx.agents.get(record['agent-name']);
    process.kill(live.agent.pid, 'SIGKILL');
    assert.ok(await until(() => live.exited));
    await tick(f.ctx);
    assert.ok(!f.ctx.agents.has(record['agent-name']), f.lines.join('\n'));
    assert.ok(!assigned(f).includes(record['agent-name']), f.lines.join('\n'));
    assert.deepEqual(waiting(f), [], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    f.ctx.stopAgents();
  }
});

// A paired plan assignment: a pen-holder and a pair, each of whose first turn
// ends with a wakeup pending and whose second ends clean (FAKE_PENDING_UNTIL).
function pairedFixture() {
  const f = controlFixture();
  edit(engineFile(f), e => { e.steps.find(s => s.id === 'plan').action['agent-count'] = 2; });
  process.env.FAKE_PENDING = 'schedule';
  process.env.FAKE_PENDING_UNTIL = '1';
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  return f;
}
const unpair = f => { delete process.env.FAKE_PENDING; delete process.env.FAKE_PENDING_UNTIL; delete process.env.FAKE_OUTPUT; f.ctx.stopAgents(); };

test('ASS-334 AC1: the pen-holder\'s pending work holds the whole group while the pair\'s turn ends clean and approved; both are finished once it clears', async () => {
  const f = pairedFixture();
  try {
    const [pen, pair] = await dispatch(f);
    assert.equal(f.ctx.agents.size, 2, f.lines.join('\n'));
    assert.ok(await turnsEnd(f.ctx));
    const penLive = f.ctx.agents.get(pen['agent-name']), pairLive = f.ctx.agents.get(pair['agent-name']);
    assert.ok(await nextTurn(f, pairLive, pair));                 // the pair's second turn: nothing pending in it
    await f.agent('assignments:approve', pair['agent-name']);
    await tick(f.ctx);
    assert.deepEqual(assigned(f).toSorted(), [pen['agent-name'], pair['agent-name']].toSorted(), f.lines.join('\n'));
    assert.deepEqual([f.ctx.agents.has(pen['agent-name']), f.ctx.agents.has(pair['agent-name'])], [true, true], f.lines.join('\n'));
    assert.deepEqual([alive(penLive.agent.pid), alive(pairLive.agent.pid)], [true, true], 'a process was signalled');
    assert.equal(f.variation()['harness-status'].state, 'plan', f.lines.join('\n'));
    assert.deepEqual(named(waiting(f)), [pen['agent-name']], f.lines.join('\n'));
    // The pen-holder's own next turn clears it: the group is finished as before, each with its own cost, and the step moves on.
    assert.ok(await nextTurn(f, penLive, pen));
    await tick(f.ctx);
    assert.deepEqual(assigned(f).filter(n => [pen['agent-name'], pair['agent-name']].includes(n)), [], f.lines.join('\n'));
    assert.notEqual(f.variation()['harness-status'].state, 'plan', f.lines.join('\n'));
    const log = f.variation()['state-changes'][1]['agent-dispatch-log'];
    assert.deepEqual(log.map(d => d['dispatched-to']).toSorted(), [pen['agent-name'], pair['agent-name']].toSorted(), JSON.stringify(log));
    assert.ok(log.every(d => d['cost-usd'] > 0), JSON.stringify(log));
  } finally {
    unpair(f);
  }
});

test('ASS-334 AC1: the pair\'s pending work holds the group too, when it is the pen-holder whose turn ends clean', async () => {
  const f = pairedFixture();
  try {
    const [pen, pair] = await dispatch(f);
    assert.ok(await turnsEnd(f.ctx));
    const penLive = f.ctx.agents.get(pen['agent-name']), pairLive = f.ctx.agents.get(pair['agent-name']);
    assert.ok(await nextTurn(f, penLive, pen));                   // the pen-holder's second turn: nothing pending in it
    await f.agent('assignments:approve', pair['agent-name']);
    await tick(f.ctx);
    assert.deepEqual(assigned(f).toSorted(), [pen['agent-name'], pair['agent-name']].toSorted(), f.lines.join('\n'));
    assert.deepEqual([alive(penLive.agent.pid), alive(pairLive.agent.pid)], [true, true], 'a process was signalled');
    assert.equal(f.variation()['harness-status'].state, 'plan', f.lines.join('\n'));
    assert.deepEqual(named(waiting(f)), [pair['agent-name']], f.lines.join('\n'));
  } finally {
    unpair(f);
  }
});

test('ASS-334 AC2: pending work cleared by a later turn finishes the agent as before — its assignment removed with its cost, its step moved on, nothing left warned', async () => {
  const f = controlFixture();
  process.env.FAKE_PENDING = 'schedule';
  process.env.FAKE_PENDING_UNTIL = '1';
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    const [record] = await dispatch(f);
    const name = record['agent-name'];
    assert.ok(await turnsEnd(f.ctx));
    const live = f.ctx.agents.get(name);
    await tick(f.ctx);
    assert.deepEqual(named(waiting(f)), [name], f.lines.join('\n'));              // held, as AC1
    assert.deepEqual(assigned(f), [name], f.lines.join('\n'));
    assert.ok(await nextTurn(f, live, record));
    await tick(f.ctx);
    assert.ok(!assigned(f).includes(name), f.lines.join('\n'));
    assert.ok(!f.ctx.agents.has(name), f.lines.join('\n'));
    assert.equal(live.pending ?? null, null, JSON.stringify(live.pending));
    assert.ok(f.lines.some(l => /^finish \S+ ended \(\$1\.0000\)$/.test(l)), f.lines.join('\n'));
    assert.deepEqual(timedOut(f), [], f.lines.join('\n'));
    assert.deepEqual([...f.ctx.memory.warned].filter(k => k.startsWith('pending/')), [], 'a warned key was left behind');
    const log = f.variation()['state-changes'][1]['agent-dispatch-log'];
    assert.deepEqual(log.map(d => [d['dispatched-to'], d['cost-usd']]), [[name, 1]], JSON.stringify(log));
    assert.notEqual(f.variation()['harness-status'].state, 'plan', f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_PENDING_UNTIL;
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('ASS-334 AC2: a second turn that is pending too restarts the wait, so an agent still working is never timed out', async () => {
  const f = controlFixture();
  process.env.FAKE_PENDING = 'schedule';
  process.env.FAKE_PENDING_UNTIL = '2';
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  try {
    const [record] = await dispatch(f);
    const name = record['agent-name'];
    assert.ok(await turnsEnd(f.ctx));
    const live = f.ctx.agents.get(name);
    await tick(f.ctx);
    const at = live.pending?.at;
    assert.equal(typeof at, 'number', JSON.stringify(live.pending));
    clock += 60_000;
    assert.ok(await nextTurn(f, live, record));                   // a second pending turn
    await tick(f.ctx);
    assert.ok(live.pending?.at > at, `${JSON.stringify(live.pending)} is not past ${at}`);
    assert.deepEqual(assigned(f), [name], f.lines.join('\n'));
    assert.deepEqual(named(waiting(f)), [name, name], f.lines.join('\n'));        // a span each, logged once each
    assert.deepEqual(timedOut(f), [], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_PENDING_UNTIL;
    f.ctx.stopAgents();
  }
});

test('ASS-334 AC3: pending work that never completes is finished anyway once agent-pending-work-wait-seconds has passed, the timeout logged', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'harness.json'), h => { h['agent-pending-work-wait-seconds'] = 1; });
  process.env.FAKE_PENDING = 'schedule';
  process.env.FAKE_HOLD = join(f.dir, 'hold');                                    // no file yet: its first turn ends
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  try {
    const [record] = await dispatch(f);
    const name = record['agent-name'];
    assert.ok(await turnsEnd(f.ctx));
    const { pid } = f.ctx.agents.get(name).agent;
    writeFileSync(process.env.FAKE_HOLD, '');                                     // no turn of its ends from here on
    await tick(f.ctx);
    assert.deepEqual(named(waiting(f)), [name], f.lines.join('\n'));
    clock += 2_000;
    await tick(f.ctx);
    assert.ok(!f.ctx.agents.has(name), f.lines.join('\n'));
    assert.ok(await until(() => !alive(pid)));
    assert.deepEqual(named(timedOut(f)), [name], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_HOLD;
    f.ctx.stopAgents();
  }
});

test('ASS-334 AC3: with nothing set the bound is 30 minutes — still held at 1799 seconds, finished with the timeout at 1801', async () => {
  const f = controlFixture();
  process.env.FAKE_PENDING = 'schedule';
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  try {
    const [record] = await dispatch(f);
    const name = record['agent-name'];
    assert.ok(await turnsEnd(f.ctx));
    writeFileSync(process.env.FAKE_HOLD, '');
    await tick(f.ctx);
    assert.deepEqual(named(waiting(f)), [name], f.lines.join('\n'));
    clock += 1_799_000;
    await tick(f.ctx);
    assert.deepEqual(assigned(f), [name], f.lines.join('\n'));
    assert.deepEqual(timedOut(f), [], f.lines.join('\n'));
    clock += 2_000;
    await tick(f.ctx);
    assert.ok(!assigned(f).includes(name), f.lines.join('\n'));
    assert.deepEqual(named(timedOut(f)), [name], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_HOLD;
    f.ctx.stopAgents();
  }
});

test('ASS-334 AC3: agent-pending-work-wait-seconds 0 holds nothing — the pending agent is finished in the tick after its turn, the timeout logged', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'harness.json'), h => { h['agent-pending-work-wait-seconds'] = 0; });
  process.env.FAKE_PENDING = 'bash';
  try {
    const [record] = await dispatch(f);
    const name = record['agent-name'];
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.ok(!f.ctx.agents.has(name), f.lines.join('\n'));
    assert.deepEqual(waiting(f), [], f.lines.join('\n'));
    assert.deepEqual(named(timedOut(f)), [name], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    f.ctx.stopAgents();
  }
});

test('ASS-334 AC3: a paired group whose members are both still pending past the bound is finished anyway, the timeout naming each', async () => {
  const f = controlFixture();
  edit(engineFile(f), e => { e.steps.find(s => s.id === 'plan').action['agent-count'] = 2; });
  edit(join(f.dir, 'harness.json'), h => { h['agent-pending-work-wait-seconds'] = 1; });
  process.env.FAKE_PENDING = 'schedule';
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  try {
    const [pen, pair] = await dispatch(f);
    assert.ok(await turnsEnd(f.ctx));
    await f.agent('assignments:approve', pair['agent-name']);
    await tick(f.ctx);
    assert.deepEqual(named(waiting(f)).toSorted(), [pen['agent-name'], pair['agent-name']].toSorted(), f.lines.join('\n'));
    clock += 2_000;
    await tick(f.ctx);
    assert.deepEqual(assigned(f).filter(n => [pen['agent-name'], pair['agent-name']].includes(n)), [], f.lines.join('\n'));
    assert.deepEqual(named(timedOut(f)).toSorted(), [pen['agent-name'], pair['agent-name']].toSorted(), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_PENDING;
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});
