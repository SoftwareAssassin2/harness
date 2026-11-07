// ASS-217: a project that declares both a subscription and an API key — for
// host agents a second Claude config dir, data/projects/<id>/.claude-api,
// logged in with the key; for VMs both credentials, the VM's vms.json row
// recording credential-kind `both` — runs each agent on the subscription
// unless its claude kind is rate limited (ASS-215), else on the API key unless
// a project.json API cap (max-api-spend-per-day-usd, -per-sprint-usd) is
// reached; else the agent waits. Control picks per dispatch and records it on
// the assignment (payment-method), which assignments:remove carries onto the
// dispatch. At a cap, its running API agents are shut down gracefully.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';
import { readUsage } from '../../src/agents/session-usage.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const isoOf = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const inAnHour = () => Date.now() + 3600e3;
const projectFile = f => join(f.dir, 'projects', 'p', 'project.json');
const projectJson = f => JSON.parse(readFileSync(projectFile(f), 'utf8'));
// A hold on `kinds` in rate-limit.json, as project:set-rate-limit writes it, resetting at `resetsAt` (ms).
const hold = (f, kinds, resetsAt = inAnHour()) => writeFileSync(join(f.dir, 'projects', 'p', 'rate-limit.json'),
  JSON.stringify(Object.fromEntries(kinds.map(k => [k, { since: isoOf(resetsAt - 3600e3), type: 'five_hour', 'resets-at': isoOf(resetsAt) }]))));
const at = (f, state) => f.assignments().assignments.filter(a => a.state === state);
const sessionOf = (f, record) => readFileSync(join(f.ctx.agents.get(record['agent-name']).agent.dir, 'session.txt'), 'utf8');
const caps = (f, day, sprint) => edit(projectFile(f), p => { p['max-api-spend-per-day-usd'] = day; p['max-api-spend-per-sprint-usd'] = sprint; });
// $`usd` of api spend today, logged on ABC-3 A as a completed dispatch.
const spent = (f, usd) => edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
  s.start = new Date().toLocaleDateString('en-CA');                     // today's local date: spend.js's days are local, so a UTC date is tomorrow in the evening
  s.features[0].variations[0]['state-changes'] = [{ 'to-state': 'committed', timestamp: isoOf(Date.now()), 'agent-dispatch-log': [{ 'dispatched-to': 'Earlier', timestamp: isoOf(Date.now()), 'completed-timestamp': isoOf(Date.now()), billing: 'api', 'cost-usd': usd }] }];
});

// The fake agent's turns wait while the file FAKE_HOLD names exists (a host agent has control's process.env).
const turnsNeverEnd = f => { const file = join(f.dir, 'hold'); writeFileSync(file, ''); process.env.FAKE_HOLD = file; };
afterEach(() => { delete process.env.FAKE_HOLD; });

// The control fixture with p declaring both on the host: its .claude and its .claude-api.
function dual() {
  const f = controlFixture();
  for (const d of ['.claude', '.claude-api']) mkdirSync(join(f.dir, 'projects', 'p', d));
  return f;
}

test('ASS-217 AC3: not rate limited, a dual project\'s host agent runs on the subscription — its .claude — and the assignment records payment-method subscription', async () => {
  const f = dual();
  await tick(f.ctx);
  const [record] = at(f, 'plan');
  assert.equal(record?.['payment-method'], 'subscription', f.lines.join('\n'));
  assert.ok(await until(() => sessionOf(f, record).includes('config ')));
  assert.match(sessionOf(f, record), new RegExp(`config ${join(f.dir, 'projects', 'p', '.claude')}\\n`));
  assert.ok(f.lines.some(l => /^dispatch .* on the subscription$/.test(l)), f.lines.join('\n'));
});

test('ASS-217 AC4: with the subscription rate limited, a dual project\'s host agent runs on the API key — its .claude-api — recorded as api, its kind anthropic', async () => {
  const f = dual();
  hold(f, ['claude']);
  await tick(f.ctx);
  const [record] = at(f, 'plan');
  assert.equal(record?.['payment-method'], 'api', f.lines.join('\n'));
  assert.equal(f.ctx.agents.get(record['agent-name']).kind, 'anthropic');
  assert.ok(await until(() => sessionOf(f, record).includes('config ')));
  assert.match(sessionOf(f, record), new RegExp(`config ${join(f.dir, 'projects', 'p', '.claude-api')}\\n`));
  assert.ok(f.lines.some(l => /^dispatch .* on the API key$/.test(l)), f.lines.join('\n'));
});

test('ASS-217 AC4: with both the subscription and the API key rate limited, the agent waits', async () => {
  const f = dual();
  hold(f, ['claude', 'anthropic']);
  await tick(f.ctx);
  assert.deepEqual(at(f, 'plan'), [], f.lines.join('\n'));
});

for (const [cap, day, sprint] of [['day', 5, null], ['sprint', null, 5]]) {
  test(`ASS-217 AC4: with the subscription rate limited and the ${cap} cap reached, no agent is dispatched on the API key; project.json's api-cap-hold names the ${cap} cap for the dashboard`, async () => {
    const f = dual();
    caps(f, day, sprint);
    spent(f, 5);
    hold(f, ['claude']);
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(at(f, 'plan'), [], f.lines.join('\n'));
    assert.deepEqual(projectJson(f)['api-cap-hold'], { since: projectJson(f)['api-cap-hold']?.since, cap, 'spend-usd': 5, 'limit-usd': 5 }, f.lines.join('\n'));
    assert.equal(f.lines.filter(l => new RegExp(`^agents p's API ${cap} cap is reached \\(\\$5\\.00 of \\$5\\)`).test(l)).length, 1, f.lines.join('\n'));
  });
}

test('ASS-271 AC3: the chat screen\'s api turns (chat-spend.json) count toward the API day cap: reached by them alone, no agent is dispatched on the API key', async () => {
  const f = dual();
  caps(f, 5, null);
  writeFileSync(join(f.dir, 'projects', 'p', 'chat-spend.json'), JSON.stringify({ turns: [{ timestamp: isoOf(Date.now()), chat: 'c', billing: 'api', 'cost-usd': 4 }, { timestamp: isoOf(Date.now()), chat: 'c', billing: 'api', 'cost-usd': 1, estimate: true }] }));
  hold(f, ['claude']);
  await tick(f.ctx);
  assert.deepEqual(at(f, 'plan'), [], f.lines.join('\n'));
  assert.equal(projectJson(f)['api-cap-hold']?.cap, 'day', f.lines.join('\n'));
});

test('ASS-217 AC4: null caps never hold an API dispatch, however much was spent', async () => {
  const f = dual();
  caps(f, null, null);
  spent(f, 1e6);
  hold(f, ['claude']);
  await tick(f.ctx);
  assert.equal(at(f, 'plan')[0]?.['payment-method'], 'api', f.lines.join('\n'));
  assert.equal(projectJson(f)['api-cap-hold'], undefined);
});

test('ASS-217 AC5: a cap reached while an agent runs on the API key shuts it down gracefully, then kills it after the delay; its step is dispatched again on the subscription once that resets, and the cap hold is cleared under the cap', async () => {
  const f = dual();
  const resetsAt = inAnHour();
  caps(f, 1, null);
  hold(f, ['claude'], resetsAt);
  turnsNeverEnd(f);
  await tick(f.ctx);
  const [record] = at(f, 'plan');
  assert.equal(record?.['payment-method'], 'api', f.lines.join('\n'));
  spent(f, 1);                              // the cap is reached
  await tick(f.ctx);
  assert.equal(at(f, 'plan')[0]?.status, 'Shutting Down', f.lines.join('\n'));
  assert.ok(f.lines.includes(`agents ${record['agent-name']} asked to shut down`), f.lines.join('\n'));
  f.ctx.now = () => new Date(Date.now() + 2000);   // past the fixture's 1s delay
  await tick(f.ctx);
  assert.ok(f.lines.some(l => l.startsWith(`agents ${record['agent-name']} killed after the shut-down delay`)), f.lines.join('\n'));
  // Still capped and still limited: it waits.
  await tick(f.ctx);
  assert.deepEqual(at(f, 'plan'), [], f.lines.join('\n'));
  // The subscription resets: dispatched there.
  f.ctx.now = () => new Date(resetsAt + 1000);
  await tick(f.ctx);
  assert.equal(at(f, 'plan')[0]?.['payment-method'], 'subscription', f.lines.join('\n'));
  // Under the cap again (a new day's spend), the hold is cleared.
  caps(f, null, null);
  await tick(f.ctx);
  assert.equal(projectJson(f)['api-cap-hold'], undefined, f.lines.join('\n'));
});

// ASS-268: what the killed agent cost — its turns unfinished, usage.json's estimate — is on its dispatch before the cap is next evaluated.
test('ASS-268 AC4: an agent killed for the API cap has its spend recorded, so the kill never lifts the cap', async () => {
  const f = dual();
  edit(join(f.dir, 'harness.json'), h => { h['model-prices'] = { 'fake-model': { input: 50_000, output: 0, 'cache-read': 0, 'cache-write': 0 } }; });   // $0.50 an assistant event
  process.env.FAKE_UNFINISHED = '1';                                             // its turns never end
  try {
    caps(f, 10, null);
    spent(f, 0.6);
    hold(f, ['claude']);
    await tick(f.ctx);
    const [record] = at(f, 'plan');
    assert.equal(record?.['payment-method'], 'api', f.lines.join('\n'));
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 0.5));
    caps(f, 0.6, null);                                                          // the cap is reached
    await tick(f.ctx);
    assert.equal(at(f, 'plan')[0]?.status, 'Shutting Down', f.lines.join('\n'));
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 1));      // it answers the shut-down prompt, a turn that never ends
    f.ctx.now = () => new Date(Date.now() + 2000);                               // past the fixture's 1s delay
    await tick(f.ctx);
    assert.ok(f.lines.some(l => l.startsWith(`agents ${record['agent-name']} killed after the shut-down delay`)), f.lines.join('\n'));
    const d = f.variation()['state-changes'].flatMap(c => c['agent-dispatch-log'] ?? []).find(x => x['dispatched-to'] === record['agent-name']);
    assert.deepEqual([d['cost-usd'], d['cost-estimated'], d.billing, d['payment-method']], [1, true, 'api', 'api']);
    caps(f, 1, null);                                                            // the earlier $0.60 alone is under it; with the killed agent's $1, over
    await tick(f.ctx);
    assert.deepEqual(projectJson(f)['api-cap-hold'], { since: projectJson(f)['api-cap-hold']?.since, cap: 'day', 'spend-usd': 1.6, 'limit-usd': 1 }, f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /under its API caps again/.test(l)), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_UNFINISHED;
    f.ctx.stopAgents();
  }
});

// ASS-270: a single-turn agent on the API key counts what it has spent so far — usage.json's estimate of its
// unfinished turn, $0.50 at this price — so the day cap is reached mid-turn, not once the turn has ended.
test('ASS-270 AC1/AC5: a single-turn API agent crossing the day cap mid-turn is counted toward it and shut down, then killed after the delay', async () => {
  const f = dual();
  edit(join(f.dir, 'harness.json'), h => { h['model-prices'] = { 'fake-model': { input: 50_000, output: 0, 'cache-read': 0, 'cache-write': 0 } }; });   // $0.50 an assistant event
  const held = join(f.dir, 'hold-result');
  writeFileSync(held, '');
  process.env.FAKE_HOLD_RESULT = held;                                             // its assistant event said, its result never comes
  try {
    caps(f, 1, null);
    spent(f, 0.6);
    hold(f, ['claude']);
    await tick(f.ctx);
    const [record] = at(f, 'plan');
    assert.equal(record?.['payment-method'], 'api', f.lines.join('\n'));
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 0.5));
    assert.equal(live.result, null);                                               // mid-turn: live.cost still $0
    await tick(f.ctx);
    assert.deepEqual(projectJson(f)['api-cap-hold'], { since: projectJson(f)['api-cap-hold']?.since, cap: 'day', 'spend-usd': 1.1, 'limit-usd': 1 }, f.lines.join('\n'));
    assert.ok(f.lines.some(l => /^agents p's API day cap is reached \(\$1\.10 of \$1\)/.test(l)), f.lines.join('\n'));
    assert.equal(at(f, 'plan')[0]?.status, 'Shutting Down', f.lines.join('\n'));
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 1));      // it answers the shut-down prompt, its result held too
    f.ctx.now = () => new Date(Date.now() + 2000);                                 // past the fixture's 1s delay
    await tick(f.ctx);
    assert.ok(f.lines.some(l => l.startsWith(`agents ${record['agent-name']} killed after the shut-down delay`)), f.lines.join('\n'));
    const d = f.variation()['state-changes'].flatMap(c => c['agent-dispatch-log'] ?? []).find(x => x['dispatched-to'] === record['agent-name']);
    assert.deepEqual([d['cost-usd'], d['cost-estimated'], d.billing], [1, true, 'api']);
  } finally {
    rmSync(held, { force: true });
    delete process.env.FAKE_HOLD_RESULT;
    f.ctx.stopAgents();
  }
});

// ASS-270 AC4: a subscription agent's turn, however much usage.json estimates it, adds nothing to the API caps.
test('ASS-270 AC4: a subscription agent mid-turn counts $0 toward the API caps', async () => {
  const f = dual();
  edit(join(f.dir, 'harness.json'), h => { h['model-prices'] = { 'fake-model': { input: 50_000, output: 0, 'cache-read': 0, 'cache-write': 0 } }; });
  const held = join(f.dir, 'hold-result');
  writeFileSync(held, '');
  process.env.FAKE_HOLD_RESULT = held;
  process.env.FAKE_API_KEY_SOURCE = 'none';                                      // a subscription login
  try {
    caps(f, 1, null);
    spent(f, 0.6);
    await tick(f.ctx);
    const [record] = at(f, 'plan');
    assert.equal(record?.['payment-method'], 'subscription', f.lines.join('\n'));
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => readUsage(live.agent.dir)?.costUsd === 0.5));
    await tick(f.ctx);
    assert.equal(projectJson(f)['api-cap-hold'], undefined, f.lines.join('\n'));
    assert.equal(at(f, 'plan')[0]?.status, 'Running', f.lines.join('\n'));
  } finally {
    rmSync(held, { force: true });
    delete process.env.FAKE_HOLD_RESULT;
    delete process.env.FAKE_API_KEY_SOURCE;
    f.ctx.stopAgents();
  }
});

test('ASS-217 AC5: a cap never stops an agent running on the subscription', async () => {
  const f = dual();
  caps(f, 1, null);
  spent(f, 1);
  turnsNeverEnd(f);
  await tick(f.ctx);
  await tick(f.ctx);
  assert.equal(at(f, 'plan')[0]?.['payment-method'], 'subscription', f.lines.join('\n'));
  assert.equal(at(f, 'plan')[0]?.status, 'Running', f.lines.join('\n'));
});

test('ASS-217 AC6: once the subscription resets, new dispatches go back to it while an agent already on the API key runs on', async () => {
  const f = dual();
  const resetsAt = inAnHour();
  hold(f, ['claude'], resetsAt);
  turnsNeverEnd(f);
  await tick(f.ctx);
  const [first] = at(f, 'plan');
  assert.equal(first?.['payment-method'], 'api', f.lines.join('\n'));
  // A second ticket arrives; the limit has reset.
  edit(join(f.dir, 'harness.json'), h => { h['max-tickets-in-progress'] = 2; });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features.push({ ...structuredClone(s.features[0]), key: 'ABC-4' }); });
  f.ctx.now = () => new Date(resetsAt + 1000);
  await tick(f.ctx);
  await tick(f.ctx);
  const records = at(f, 'plan');
  assert.equal(records.find(r => r['work-item'] === 'ABC-4')?.['payment-method'], 'subscription', f.lines.join('\n'));
  const still = records.find(r => r['work-item'] === 'ABC-3');
  assert.deepEqual([still?.['agent-name'], still?.status, still?.['payment-method']], [first['agent-name'], 'Running', 'api'], f.lines.join('\n'));
});

test('ASS-217 AC7: a project with no .claude-api runs as before — no payment-method recorded, and its subscription limit holds its agents', async () => {
  const f = controlFixture();
  mkdirSync(join(f.dir, 'projects', 'p', '.claude'));
  await tick(f.ctx);
  assert.equal(at(f, 'plan')[0]?.['payment-method'], undefined, f.lines.join('\n'));
  const g = controlFixture();
  hold(g, ['claude']);
  await tick(g.ctx);
  await tick(g.ctx);
  assert.deepEqual(at(g, 'plan'), [], g.lines.join('\n'));
});

// The plan step at run-location vm in ABC-3 A's VM abc-3-a, its vms.json row recording `kind`, as tick-rate-limit.test.js sets one up.
function vmFixture(kind) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  edit(file('engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'plan' ? { ...s, 'run-location': 'vm' } : s)); });
  edit(file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0].vm = { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }; });
  writeFileSync(file('projects', 'p', 'vms.json'), JSON.stringify({ 'abc-3-a': { ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-19T00:00:00Z', 'credential-kind': kind } }));
  const v = fakeVm(f.env);
  v.inVm('agent.sh', 'echo "{}"');
  f.ctx.env = v.env;
  return { f, v };
}
// agentCall(v) — the agent's limactl shell, once fake-limactl has logged it: the tick spawns limactl and goes
// on, so a test waits for it (until) — read at once, under load it was not there yet (ASS-267).
const agentCall = v => v.calls().find(c => c.vm === 'abc-3-a' && c.argv.some(a => a.includes('fake-agent')));

test('ASS-217 AC2: in a VM holding both credentials, control picks one per dispatch — the subscription unsetting ANTHROPIC_API_KEY, the API key unsetting CLAUDE_CODE_OAUTH_TOKEN — with no VM restart', async () => {
  for (const [kinds, method, unset] of [[[], 'subscription', 'ANTHROPIC_API_KEY'], [['claude'], 'api', 'CLAUDE_CODE_OAUTH_TOKEN']]) {
    const { f, v } = vmFixture('both');
    hold(f, kinds);
    await tick(f.ctx);
    const [record] = at(f, 'plan');
    assert.equal(record?.['payment-method'], method, f.lines.join('\n'));
    assert.ok(await until(() => agentCall(v)), JSON.stringify(v.calls()));
    const call = agentCall(v);
    const i = call.argv.indexOf('env');
    assert.deepEqual(call.argv.slice(i, i + 3), ['env', '-u', unset], JSON.stringify(call.argv));
    assert.equal(f.ctx.agents.get(record['agent-name']).kind, method === 'api' ? 'anthropic' : 'claude');
    assert.ok(!v.calls().some(c => ['start', 'stop', 'delete'].includes(c.argv?.[0])), JSON.stringify(v.calls()));
    assert.ok(!f.lines.some(l => /vm:start|credentials refreshed/.test(l)), f.lines.join('\n'));
  }
});

test('ASS-217 AC7: a VM with one credential kind runs its agent unwrapped, no payment-method recorded', async () => {
  const { f, v } = vmFixture('claude');
  await tick(f.ctx);
  const [record] = at(f, 'plan');
  assert.ok(record, f.lines.join('\n'));
  assert.equal(record['payment-method'], undefined);
  assert.ok(await until(() => agentCall(v)), JSON.stringify(v.calls()));
  assert.ok(!agentCall(v).argv.includes('env'), JSON.stringify(agentCall(v).argv));
});
