// A rate limit (ASS-94), per (project, credential kind) (ASS-215): the agent
// that hits one is ended with no strike against its step, and the reset is
// recorded in its project's rate-limit.json — { <kind>: { since, type,
// resets-at } }, never project.json — against the agent's kind: a VM agent's
// from its VM's vms.json row, a host agent's from `claude auth status`'s
// authMethod (api_key → anthropic, else claude). Until the clock passes it
// only that kind's agents are not dispatched; the tick runs in full.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const project = f => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'project.json'), 'utf8'));
const limitFile = f => join(f.dir, 'projects', 'p', 'rate-limit.json');
const rateLimit = f => existsSync(limitFile(f)) ? JSON.parse(readFileSync(limitFile(f), 'utf8')) : undefined;
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const isoOf = seconds => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
// A hold on `kinds`, as project:set-rate-limit writes it, resetting at `resetsAt` (epoch seconds).
const hold = (f, kinds, resetsAt = inAnHour()) => writeFileSync(limitFile(f), JSON.stringify(Object.fromEntries(kinds.map(k => [k, { since: isoOf(resetsAt - 3600), type: 'five_hour', 'resets-at': isoOf(resetsAt) }]))));
const at = (f, state) => f.assignments().assignments.filter(a => a.state === state);

test('tick: a rate-limited host turn ends its agent, records { claude: … } in rate-limit.json and holds claude dispatch until the clock passes it; then the kind is cleared and the step dispatched again', async () => {
  const f = controlFixture();
  const resetsAt = inAnHour(), iso = isoOf(resetsAt);
  process.env.FAKE_RATE_LIMIT = String(resetsAt);
  try {
    await tick(f.ctx);                                                   // the plan agent is dispatched, on the host
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);                                                   // finish sees the rate limit
    const limit = rateLimit(f);
    assert.equal(project(f)['rate-limit'], undefined);
    assert.deepEqual(Object.keys(limit ?? {}), ['claude'], JSON.stringify(limit));
    assert.match(limit.claude.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual({ type: limit.claude.type, 'resets-at': limit.claude['resets-at'] }, { type: 'five_hour', 'resets-at': iso });
    assert.ok(f.lines.some(l => new RegExp(`^finish \\S+: rate limited \\(five_hour\\) on p's claude credential; its claude agents are held until ${iso}$`).test(l)), f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /no exit of plan matched/.test(l)), 'a rate-limited turn is not a failed one');
    assert.deepEqual(f.assignments().assignments, []);
    assert.equal(f.ctx.agents.size, 0);
    assert.equal(f.variation()['harness-status'].state, 'plan');
    // Holding claude: the plan step (a planned dispatch) gets no agent; the hold logged once for its kind and reset.
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(f.lines.filter(l => /^hold /.test(l)), [`hold rate limited; p's claude agents are not dispatched until ${iso}`]);
    assert.deepEqual(f.assignments().assignments, []);
    // The reset passes: the kind is cleared and the step is dispatched again.
    delete process.env.FAKE_RATE_LIMIT;
    f.ctx.now = () => new Date((resetsAt + 1) * 1000);
    await tick(f.ctx);
    assert.equal(rateLimit(f), undefined);
    assert.ok(f.lines.includes('cli agent.sh project:clear-rate-limit p claude'), f.lines.join('\n'));
    assert.ok(f.assignments().assignments.some(a => a['work-item'] === 'ABC-3' && a.state === 'plan'), f.lines.join('\n'));
    assert.ok(await turnsEnd(f.ctx));
  } finally {
    delete process.env.FAKE_RATE_LIMIT;
    f.ctx.stopAgents();
  }
});

test('ASS-215 AC3: under a claude hold the tick still runs in full — a script step runs and moves its ticket — while the run that follows gets no claude agent (the runs loop gated); the hold over, it does', async () => {
  const f = controlFixture();
  const resetsAt = inAnHour();
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0]['ticket-system-status'] = 'In Progress'; s.features[0].variations[0]['harness-status'] = hs('build'); });
  hold(f, ['claude'], resetsAt);
  try {
    await tick(f.ctx);
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'local-testing', f.lines.join('\n'));   // build's script ran under the hold
    assert.ok(f.assignments()['transient-state-engines'].some(r => r.state === 'test'), f.lines.join('\n'));
    assert.deepEqual(at(f, 'test'), [], f.lines.join('\n'));
    f.ctx.now = () => new Date((resetsAt + 1) * 1000);
    await tick(f.ctx);
    assert.equal(at(f, 'test').length, 1, f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-215 AC3: a limit recorded on anthropic alone does not hold the same project\'s claude host agent', async () => {
  const f = controlFixture();
  hold(f, ['anthropic']);
  try {
    await tick(f.ctx);
    assert.equal(at(f, 'plan').length, 1, f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /^error /.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-215 AC3: a host agent on an api_key login (FAKE_AUTH=api-key) is recorded and held under anthropic, not claude; a claude-only limit does not hold it', async () => {
  const f = controlFixture();
  f.ctx.env.FAKE_AUTH = 'api-key';
  const resetsAt = inAnHour(), iso = isoOf(resetsAt);
  process.env.FAKE_RATE_LIMIT = String(resetsAt);
  try {
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    const limit = rateLimit(f);
    assert.deepEqual(Object.keys(limit ?? {}), ['anthropic'], JSON.stringify(limit));
    assert.equal(limit.anthropic['resets-at'], iso);
    assert.ok(f.lines.some(l => /^finish \S+: rate limited \(five_hour\) on p's anthropic credential/.test(l)), f.lines.join('\n'));
    delete process.env.FAKE_RATE_LIMIT;
    await tick(f.ctx);
    assert.deepEqual(at(f, 'plan'), [], f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_RATE_LIMIT;
    f.ctx.stopAgents();
  }
  const g = controlFixture();
  g.ctx.env.FAKE_AUTH = 'api-key';
  hold(g, ['claude']);
  try {
    await tick(g.ctx);
    assert.equal(at(g, 'plan').length, 1, g.lines.join('\n'));
  } finally {
    g.ctx.stopAgents();
  }
});

test('ASS-215 AC3: claude auth status failing (FAKE_AUTH=broken) leaves a host agent claude, as before kinds — held by a claude limit, nothing thrown', async () => {
  const f = controlFixture();
  f.ctx.env.FAKE_AUTH = 'broken';
  hold(f, ['claude']);
  try {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(at(f, 'plan'), [], f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /^error .*auth status/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-215 AC3: a flat rate-limit.json from before kinds holds nothing and throws nothing', async () => {
  const f = controlFixture();
  writeFileSync(limitFile(f), JSON.stringify({ since: isoOf(inAnHour() - 3600), type: 'five_hour', 'resets-at': isoOf(inAnHour()) }));
  try {
    await tick(f.ctx);
    assert.equal(at(f, 'plan').length, 1, f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /^error /.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

// The plan step at run-location vm, ABC-3 A's VM abc-3-a recorded on the variation and in vms.json with credential
// kind `kind` (none when null), limactl a fake — as tick-vm.test.js sets a VM up.
function vmFixture(kind) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  edit(file('engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'plan' ? { ...s, 'run-location': 'vm' } : s)); });
  edit(file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0].vm = { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }; });
  writeFileSync(file('projects', 'p', 'vms.json'), JSON.stringify({ 'abc-3-a': { ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-19T00:00:00Z', ...(kind ? { 'credential-kind': kind } : {}) } }));
  const v = fakeVm(f.env);
  v.inVm('agent.sh', 'echo "{}"');
  f.ctx.env = v.env;
  return f;
}

test('ASS-215 AC3: a VM step\'s agent (its vms.json row anthropic) is not held by a claude-only limit, and is held by an anthropic one; its own limit is recorded under anthropic', async () => {
  const f = vmFixture('anthropic');
  hold(f, ['claude']);
  try {
    await tick(f.ctx);
    assert.equal(at(f, 'plan').length, 1, f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
  const g = vmFixture('anthropic');
  hold(g, ['anthropic']);
  try {
    await tick(g.ctx);
    await tick(g.ctx);
    assert.deepEqual(at(g, 'plan'), [], g.lines.join('\n'));
  } finally {
    g.ctx.stopAgents();
  }
  const h = vmFixture('anthropic');
  h.ctx.env.FAKE_RATE_LIMIT = String(inAnHour());   // a VM's agent has control's env
  try {
    await tick(h.ctx);
    assert.ok(await turnsEnd(h.ctx));
    await tick(h.ctx);
    assert.deepEqual(Object.keys(rateLimit(h) ?? {}), ['anthropic'], h.lines.join('\n'));
  } finally {
    h.ctx.stopAgents();
  }
});

test('ASS-215 AC3: a VM step\'s agent whose vms.json row records no kind yet is held while any kind is held for its project', async () => {
  const f = vmFixture(null);
  hold(f, ['claude']);
  try {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(at(f, 'plan'), [], f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});
