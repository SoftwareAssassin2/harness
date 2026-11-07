// ASS-191: a per-ticket spending limit — harness.json's and project.json's
// max-spend-per-ticket-usd, the ticket's own max-spend-usd over both — and
// control's stop once a ticket's spend — its running agents' so far among it
// (ASS-270) — reaches it: no new agent, the running ones shut down, each active variation to Blocked for Human with the
// reason; handed back after the limit is raised, the ticket works on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { planDispatch } from '../../src/control/plan.js';
import { defaultSpendLimit, spendLimit, ticketSpend, overSpent, spendText, usageSpend, runningSpend, runningOn } from '../../src/control/spend.js';
import { readUsage } from '../../src/agents/session-usage.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const ran = cost => ({ 'dispatched-to': 'Thor', timestamp: '2026-10-27T10:00:00Z', 'completed-timestamp': '2026-10-27T10:30:00Z', 'cost-usd': cost });
const change = (log, extra = {}) => ({ 'from-state': 'plan', 'to-state': 'build', 'agent-dispatch-log': log, ...extra });

test('ASS-191 AC1: the limit is the ticket\'s max-spend-usd, else project.json\'s max-spend-per-ticket-usd, else harness.json\'s; none set, no limit', () => {
  const KEY = 'max-spend-per-ticket-usd';
  assert.equal(defaultSpendLimit({ [KEY]: 25 }, { [KEY]: 10 }), 10);   // the project's wins
  assert.equal(defaultSpendLimit({ [KEY]: 25 }, {}), 25);               // a project that sets none takes the harness's
  assert.equal(defaultSpendLimit({}, {}), null);
  assert.equal(defaultSpendLimit({ [KEY]: 25 }, { [KEY]: 0 }), 0);       // 0 is a limit, not none
  assert.equal(spendLimit({ key: 'T-1', 'max-spend-usd': 40 }, 10), 40); // the override wins over both
  assert.equal(spendLimit({ key: 'T-1' }, 10), 10);
  assert.equal(spendLimit({ key: 'T-1' }, null), null);
});

test('ASS-191 AC2: a ticket\'s spend is every agent cost recorded on it — each variation, every state change (a step\'s run, Blocked\'s, sub-state changes) — a deleted variation\'s and an unfinished agent\'s left out', () => {
  const t = { key: 'T-1', variations: [
    { name: 'A', 'state-changes': [change([ran(1.5), ran(0.25)]), change([ran(2)], { 'sub-state-change': true }), change([{ 'dispatched-to': 'Loki', 'cost-usd': null }])] },
    { name: 'B', 'state-changes': [change([ran(0.5)]), { 'from-state': 'build', 'to-state': 'blocked' }] },
    { name: 'C', 'is-deleted': true, 'state-changes': [change([ran(100)])] },
    { name: 'D' },
  ] };
  assert.equal(ticketSpend(t), 4.25);
  assert.equal(ticketSpend({ key: 'T-2' }), 0);
});

test('ASS-191 AC3: overSpent once the spend reaches the limit, with what spendText says of it', () => {
  const t = cost => ({ key: 'T-1', variations: [{ name: 'A', 'state-changes': [change([ran(cost)])] }] });
  assert.deepEqual(overSpent(t(10), {}, { 'max-spend-per-ticket-usd': 10 }), { spend: 10, limit: 10 });
  assert.equal(overSpent(t(9.99), {}, { 'max-spend-per-ticket-usd': 10 }), null);
  assert.equal(overSpent(t(1000), {}, {}), null);                     // no limit
  assert.equal(spendText(8.2, 10), '$8.20 of $10');
  assert.equal(spendText(0.5, 0.5), '$0.50 of $0.50');
});

// ASS-270: a ticket's running agents count toward its limit, what each has spent so far — its finished turns exact, the unfinished one estimated (usage.json).
test('ASS-270 AC2/AC4: usageSpend is a running agent\'s usage.json costUsd, 0 on a subscription or with nothing priced; runningSpend sums each ticket\'s, a record with no variation (no dispatch logged) counted on none', () => {
  assert.equal(usageSpend({ costUsd: 1.25, costExact: false, billing: 'api' }), 1.25);
  assert.equal(usageSpend({ costUsd: 1.25, costExact: false, billing: 'subscription' }), 0);
  assert.equal(usageSpend({ costUsd: null, costExact: false, billing: 'api' }), 0);
  assert.equal(usageSpend(null), 0);
  const on = (project, item, variation) => ({ project, 'work-item': item, variation });
  const running = runningSpend([
    { record: on('p', 'T-1', 'A'), usd: 1 }, { record: on('p', 'T-1', 'B'), usd: 0.5 }, { record: on('p', 'T-2', 'A'), usd: 2 },
    { record: on('q', 'T-1', 'A'), usd: 4 }, { record: on('p', 'T-3', null), usd: 8 }, { record: on('p', null, null), usd: 16 },
  ]);
  assert.deepEqual(running, { p: { 'T-1': 1.5, 'T-2': 2 }, q: { 'T-1': 4 } });
  assert.equal(runningOn(running, 'p', 'T-1'), 1.5);
  assert.equal(runningOn(running, 'p', 'T-3'), 0);
  assert.equal(runningOn(undefined, 'p', 'T-1'), 0);
});

test('ASS-270 AC2: overSpent counts what the ticket\'s running agents have spent so far on top of its recorded spend', () => {
  const t = { key: 'T-1', variations: [{ name: 'A', 'state-changes': [change([ran(6)])] }] };
  assert.equal(overSpent(t, {}, { 'max-spend-per-ticket-usd': 10 }), null);
  assert.deepEqual(overSpent(t, {}, { 'max-spend-per-ticket-usd': 10 }, 4), { spend: 10, limit: 10 });
  assert.equal(overSpent(t, {}, { 'max-spend-per-ticket-usd': 10 }, 3.99), null);
});

test('ASS-270 AC2: a ticket whose running agents take it to its limit is planned no agent and holds no slot', () => {
  const engine = { steps: [{ id: 'build', sequence: 1, action: { type: 'prompt', prompt: 'build' } }] };
  const at = (name, log = []) => ({ name, 'harness-status': { state: 'build', 'state-engine': 'e' }, 'state-changes': [change(log)] });
  const ranked = [{ key: 'T-1', variations: [at('A', [ran(6)]), at('B')] }, { key: 'T-2', variations: [at('A')] }];
  const plan = running => planDispatch({ ranked, engine, harness: { 'max-tickets-in-progress': 1 }, project: { 'max-spend-per-ticket-usd': 10 }, running });
  assert.deepEqual(plan({}).reserved, [{ key: 'T-1', variation: 'A' }]);
  assert.deepEqual(plan({ 'T-1': 4 }).reserved, [{ key: 'T-2', variation: 'A' }]);
});

test('ASS-191 AC3: a ticket at its limit is planned no agent and holds no slot; the next one is', () => {
  const engine = { steps: [{ id: 'build', sequence: 1, action: { type: 'prompt', prompt: 'build' } }] };
  const at = (name, log = []) => ({ name, 'harness-status': { state: 'build', 'state-engine': 'e' }, 'state-changes': [change(log)] });
  const ranked = [{ key: 'T-1', variations: [at('A', [ran(6)]), at('B', [ran(4)])] }, { key: 'T-2', variations: [at('A', [ran(9)])] }];
  const result = planDispatch({ ranked, engine, harness: { 'max-tickets-in-progress': 1 }, project: { 'max-spend-per-ticket-usd': 10 } });
  assert.deepEqual(result.dispatch.map(d => d.key), ['T-2']);
  assert.deepEqual(result.reserved, [{ key: 'T-2', variation: 'A' }]);
});

// The control fixture with a Blocked for Human step (the operator's: Resolved
// returns the ticket where it was) and project p's limit `limit`, harness.json's 25.
function limitFixture(limit) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.unshift({ id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, 'follow-return-to-state': true, action: { type: 'human' },
      'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }] });
  });
  edit(join(f.dir, 'harness.json'), h => { h['max-spend-per-ticket-usd'] = 25; });
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['max-spend-per-ticket-usd'] = limit; });
  return f;
}

test('ASS-191 AC3, AC4: at its limit the running agent is asked to shut down (ASS-270) and ends its turn, no agent is dispatched again, and the ticket goes to Blocked for Human saying why; the limit raised and the ticket handed back, it works on', async () => {
  const f = limitFixture(25);
  const hold = join(f.dir, 'hold');
  process.env.FAKE_HOLD = hold;
  writeFileSync(hold, '');
  const state = () => f.variation()['harness-status'].state;
  try {
    await tick(f.ctx);                                                                       // backlog → plan, an agent on it
    const [first] = f.assignments().assignments;
    const live = f.ctx.agents.get(first['agent-name']);
    assert.equal(state(), 'plan');
    await f.agent('ticket:set-spending-limit', 'p', 'ABC-3', '0');                          // the override: reached at once
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(a => [a['agent-name'], a.status]), [[first['agent-name'], 'Shutting Down']], f.lines.join('\n'));
    assert.ok(f.lines.includes(`agents ${first['agent-name']} asked to shut down (ABC-3 is at its spending limit: $0.00 of $0)`), f.lines.join('\n'));
    assert.equal(state(), 'plan');
    rmSync(hold);
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 1 && readUsage(live.agent.dir).costExact));   // its turn and the shut-down prompt's end ($1.00), no exit met
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments, [], f.lines.join('\n'));                  // nothing dispatched again
    assert.equal(state(), 'blocked-for-human', f.lines.join('\n'));
    assert.equal(f.variation()['ai-feedback-short'], 'spending limit reached: $1.00 of $0');
    await tick(f.ctx);
    assert.deepEqual([state(), f.assignments().assignments.length], ['blocked-for-human', 0]);
    await f.agent('ticket:set-spending-limit', 'p', 'ABC-3', '5');
    await f.agent('ticket:human-review', 'p', 'ABC-3', 'A', 'blocked-for-human', 'Resolved', '');
    await tick(f.ctx);
    assert.equal(state(), 'plan', f.lines.join('\n'));
    assert.deepEqual(f.assignments().assignments.map(a => [a['work-item'], a.state]), [['ABC-3', 'plan']]);
  } finally {
    delete process.env.FAKE_HOLD;
    f.ctx.stopAgents();
  }
});

// ASS-270 AC2/AC5: one long turn crosses the limit — usage.json's estimate of it, $1.00 at the fixture's
// price, takes ABC-3 past its $0.75 — so its agent is shut down mid-turn, killed after the delay with the
// estimate recorded (its turn and the shut-down prompt's, $2.00, neither ended), and the ticket goes to Blocked for Human.
test('ASS-270 AC2/AC5: a ticket crossing its spending limit mid-turn has its agent shut down gracefully, killed after the delay, and goes to Blocked for Human', async () => {
  const f = limitFixture(0.75);
  edit(join(f.dir, 'harness.json'), h => { h['model-prices'] = { 'fake-model': { input: 100_000, output: 0, 'cache-read': 0, 'cache-write': 0 } }; });   // $1.00 an assistant event
  const hold = join(f.dir, 'hold-result');
  process.env.FAKE_HOLD_RESULT = hold;
  writeFileSync(hold, '');
  const state = () => f.variation()['harness-status'].state;
  try {
    let clock = Date.now();
    f.ctx.now = () => new Date(clock);
    await tick(f.ctx);                                                                       // backlog → plan, an agent on it: $0 spent
    const [record] = f.assignments().assignments;
    const name = record['agent-name'], live = f.ctx.agents.get(name);
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 1));                 // its turn under way, $1.00 estimated, no result
    await tick(f.ctx);
    const [shutting] = f.assignments().assignments;
    assert.equal(shutting.status, 'Shutting Down', f.lines.join('\n'));
    assert.ok(f.lines.includes(`agents ${name} asked to shut down (ABC-3 is at its spending limit: $1.00 of $0.75)`), f.lines.join('\n'));
    assert.equal(state(), 'plan');                                                           // its agent still winding down
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 2));                 // it answers the shut-down prompt, a turn that never ends either
    clock = Date.parse(shutting['shut-down-requested']) + 1100;                              // past the fixture's 1s delay
    await tick(f.ctx);
    assert.ok(f.lines.some(l => l.startsWith(`agents ${name} killed after the shut-down delay`)), f.lines.join('\n'));
    const d = f.variation()['state-changes'].flatMap(c => c['agent-dispatch-log'] ?? []).find(x => x['dispatched-to'] === name);
    assert.deepEqual([d['cost-usd'], d['cost-estimated']], [2, true]);
    await tick(f.ctx);
    assert.equal(state(), 'blocked-for-human', f.lines.join('\n'));
    assert.equal(f.variation()['ai-feedback-short'], 'spending limit reached: $2.00 of $0.75');
    assert.deepEqual(f.assignments().assignments, [], f.lines.join('\n'));
  } finally {
    rmSync(hold, { force: true });
    delete process.env.FAKE_HOLD_RESULT;
    f.ctx.stopAgents();
  }
});

test('ASS-191 AC3: a ticket under its limit is dispatched as ever; with no limit anywhere, nothing stops it', async () => {
  for (const limit of [5, null]) {
    const f = limitFixture(limit);
    if (limit == null) edit(join(f.dir, 'harness.json'), h => { delete h['max-spend-per-ticket-usd']; });
    try {
      await tick(f.ctx);
      assert.deepEqual(f.assignments().assignments.map(a => a['work-item']), ['ABC-3'], String(limit));
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('ASS-271 AC3: the chat screen\'s turns (chat-spend.json) never count toward a ticket\'s spending limit: a ticket under it is dispatched however much they cost', async () => {
  const f = limitFixture(5);
  writeFileSync(join(f.dir, 'projects', 'p', 'chat-spend.json'), JSON.stringify({ turns: [{ timestamp: new Date().toISOString(), chat: 'c', billing: 'api', 'cost-usd': 1000 }] }));
  try {
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(a => a['work-item']), ['ABC-3'], f.lines.join('\n'));
    assert.equal(overSpent({ key: 'ABC-3', variations: [] }, {}, { 'max-spend-per-ticket-usd': 5 }), null);
  } finally {
    f.ctx.stopAgents();
  }
});
