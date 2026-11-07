// ASS-268: every agent's spend is recorded on its dispatch however its process
// ends — its turn finished, its process gone without a result, killed after
// the shut-down delay, or its assignment removed by another hand — the exact
// total where every turn ended, else usage.json's estimate (session-usage.js),
// flagged cost-estimated. The fake agent's assistant event uses 10/20/30/40
// tokens; at the fixture's price (input $10,000 a million) each is $0.10 of
// estimate, and each finished turn $0.50 exact.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { readUsage } from '../../src/agents/session-usage.js';
import { ticketSpend } from '../../src/control/spend.js';
import { tokenSpend } from '../../src/tui/ticket.js';
import { until } from '../support/until.js';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(() => { delete process.env.FAKE_UNFINISHED; });

// The control fixture with harness.json pricing the fake agent's model.
function spendFixture() {
  const f = controlFixture();
  const file = join(f.dir, 'harness.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'model-prices': { 'fake-model': { input: 10_000, output: 0, 'cache-read': 0, 'cache-write': 0 } } }));
  return f;
}
// The agent's dispatch on ABC-3 A, wherever it was logged.
const dispatchOf = (f, name) => f.variation()['state-changes'].flatMap(c => c['agent-dispatch-log'] ?? []).find(d => d['dispatched-to'] === name);
const spendOf = d => ({ cost: d['cost-usd'], estimated: d['cost-estimated'] ?? false, billing: d.billing, tokens: d.tokens, completed: Boolean(d['completed-timestamp']) });
const tokens = n => ({ input: 10 * n, output: 20 * n, 'cache-read': 30 * n, 'cache-write': 40 * n });

test('ASS-268 AC2: an agent whose turn finished has its exact cost recorded, unflagged', async () => {
  const f = spendFixture();
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => live.result && readUsage(live.agent.dir)?.costExact));
    await tick(f.ctx);
    assert.deepEqual(spendOf(dispatchOf(f, record['agent-name'])), { cost: 0.5, estimated: false, billing: 'api', tokens: tokens(1), completed: true }, f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-268 AC2/AC3: an agent that exits mid-turn, no result, has usage.json\'s estimate of the turn recorded, flagged cost-estimated, and it counts as the ticket\'s spend', async () => {
  const f = spendFixture();
  process.env.FAKE_UNFINISHED = '1';
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const name = record['agent-name'], live = f.ctx.agents.get(name);
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd > 0));
    process.kill(-live.agent.pid, 'SIGKILL');                                    // gone mid-turn: a crash, the VM gone
    assert.ok(await until(() => live.exited));
    await tick(f.ctx);
    assert.ok(f.lines.some(l => l === `finish ${name} ended without a result (~$0.1000, estimated)`), f.lines.join('\n'));
    assert.deepEqual(spendOf(dispatchOf(f, name)), { cost: 0.1, estimated: true, billing: 'api', tokens: tokens(1), completed: true });
    assert.equal(ticketSpend(f.ticket()), 0.1);                                 // spend like any other: the caps and the ticket's limit
    assert.equal(tokenSpend(f.variation()), '$0.10');                            // the ticket screen
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-268 AC2/AC5: an agent with one finished turn, killed after the shut-down delay mid-way through its second, has both recorded — the first exact, the second estimated', async () => {
  const f = spendFixture();
  process.env.FAKE_UNFINISHED = '2';
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const name = record['agent-name'], live = f.ctx.agents.get(name);
    assert.ok(await until(() => live.result));
    live.result = null;                                                          // its turn taken as not yet ended, as a pair agent awaiting approval: finish leaves it be
    await f.agent('assignments:pause', 'all', 'human');
    let clock = Date.now();
    f.ctx.now = () => new Date(clock);
    await tick(f.ctx);
    const [shutting] = f.assignments().assignments;
    assert.equal(shutting.status, 'Shutting Down');
    assert.ok(await until(() => readUsage(live.agent.dir)?.costExact === false));   // the shut-down prompt's turn is under way, and never ends
    clock = Date.parse(shutting['shut-down-requested']) + 1100;                  // past the fixture's 1s delay
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments, []);
    assert.ok(f.lines.some(l => l.startsWith(`agents ${name} killed after the shut-down delay`)), f.lines.join('\n'));
    assert.ok(await until(() => !alive(live.agent.pid)));
    const d = dispatchOf(f, name);
    assert.deepEqual(spendOf(d), { cost: 0.6, estimated: true, billing: 'api', tokens: tokens(2), completed: true });
    assert.deepEqual(d.memory, { recalls: 0, returned: 0, saves: 0, deletes: 0 });
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-268 AC2: an agent whose assignment another hand removed has what it cost recorded on its dispatch when its turn ends, then its process is ended', async () => {
  const f = spendFixture();
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const name = record['agent-name'], live = f.ctx.agents.get(name);
    await f.agent('assignments:remove', name);                                   // completed, no cost (as ticket:delete's removal)
    assert.ok(await until(() => live.result && readUsage(live.agent.dir)?.costExact));
    await tick(f.ctx);
    assert.ok(f.lines.includes(`finish ${name}: no assignment any more; ending its process`), f.lines.join('\n'));
    assert.ok(!f.ctx.agents.has(name));
    assert.deepEqual(spendOf(dispatchOf(f, name)), { cost: 0.5, estimated: false, billing: 'api', tokens: tokens(1), completed: true });
    assert.ok(await until(() => !alive(live.agent.pid)));
  } finally {
    f.ctx.stopAgents();
  }
});
