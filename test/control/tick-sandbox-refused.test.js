// ASS-428 AC4: a confined host agent whose agent.sh write the sandbox refused
// says so in its structured output — sandbox-refused, added to every confined
// agent's output schema — and control makes it the variation's health,
// "sandbox refused <command>", so the operator sees which command, not a
// vague block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { withSandboxRefused } from '../../src/control/dispatch.js';
import { sandboxRefusedFeedback } from '../../src/control/facts.js';
import { until } from '../support/until.js';

const ended = ctx => until(() => [...ctx.agents.values()].every(a => a.result || a.exited));

test('ASS-428 AC4: withSandboxRefused adds sandbox-refused (a list of commands) to an output schema, keeping the rest; no schema stays none', () => {
  const schema = { type: 'object', properties: { 'is-approved': { type: 'boolean' } }, required: ['is-approved'] };
  const added = withSandboxRefused(schema);
  assert.deepEqual(added.properties['sandbox-refused'].type, 'array');
  assert.deepEqual(added.properties['sandbox-refused'].items, { type: 'string' });
  assert.match(added.properties['sandbox-refused'].description, /agent\.sh write/);
  assert.deepEqual(added.required, ['is-approved'], 'never required');
  assert.deepEqual(added.properties['is-approved'], { type: 'boolean' });
  assert.equal(schema.properties['sandbox-refused'], undefined, 'the prompt\'s own schema is not changed');
  assert.equal(withSandboxRefused(undefined), undefined);
});

test('ASS-428 AC4: sandboxRefusedFeedback names each refused command — "sandbox refused <command>, <command>" — and says why; none named, null', () => {
  const h = sandboxRefusedFeedback({ 'sandbox-refused': ['work:append', 'vm:golden-write', 'work:append', ' '] });
  assert.equal(h.short, 'sandbox refused work:append, vm:golden-write');
  assert.match(h.long, /^sandbox refused work:append, vm:golden-write: .*Operation not permitted.*bare agent\.sh command line, its content given by file path/);
  for (const none of [undefined, null, {}, { 'sandbox-refused': [] }, { 'sandbox-refused': [''] }]) assert.equal(sandboxRefusedFeedback(none), null, JSON.stringify(none));
});

test('ASS-428 AC4: a confined host agent is started with sandbox-refused in its output schema; finishing with it, the variation\'s health says "sandbox refused <command>", logged', async () => {
  const f = controlFixture();
  try {
    process.env.FAKE_OUTPUT = JSON.stringify({ 'is-approved': false, 'sandbox-refused': ['work:append'] });
    await tick(f.ctx);                                                   // backlog → committed → plan, a confined agent on it
    const [record] = f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3');
    const live = f.ctx.agents.get(record['agent-name']);
    const args = () => readFileSync(join(live.agent.dir, 'session.txt'), 'utf8').split('\n').find(l => l.startsWith('args ')) ?? '';
    assert.ok(await until(() => args()));
    assert.ok(args().endsWith(`--settings ${join(f.dir, 'projects', 'p', 'host-agent-settings.json')}`), 'confined');
    assert.match(args(), /--json-schema \{[^\n]*"sandbox-refused":\{"type":"array"/);
    assert.ok(await ended(f.ctx));
    await tick(f.ctx);                                                   // finished: plan → plan (not approved), the refusal its health
    assert.equal(f.variation()['ai-feedback-short'], 'sandbox refused work:append');
    assert.match(f.variation()['ai-feedback-long'], /Operation not permitted/);
    assert.ok(f.lines.some(l => /^finish .*: plan: sandbox refused work:append$/.test(l)), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('ASS-428 AC4: an agent that names no refusal leaves the health alone', async () => {
  const f = controlFixture();
  try {
    process.env.FAKE_OUTPUT = JSON.stringify({ 'is-approved': false });
    await tick(f.ctx);
    assert.ok(await ended(f.ctx));
    await tick(f.ctx);
    assert.equal(f.variation()['ai-feedback-short'] ?? null, null);
    assert.ok(!f.lines.some(l => /sandbox refused/.test(l)));
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('ASS-428 AC4: a sub-engine run whose last agent named a refusal ends with the parent step\'s move, and the health it leaves says "sandbox refused <command>" (steps.js)', async () => {
  const f = controlFixture();
  const { writeFileSync } = await import('node:fs');
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.features[0]['ticket-system-status'] = 'In Progress';
  sprint.features[0].variations[0]['harness-status'] = { state: 'local-testing', 'state-engine': 'example-development' };
  writeFileSync(file, JSON.stringify(sprint, null, 4));
  try {
    process.env.FAKE_OUTPUT = JSON.stringify({ 'is-approved': true, 'sandbox-refused': ['automated-tests:record'] });
    for (let i = 0; i < 12 && f.variation()['harness-status'].state !== 'done'; i++) { await tick(f.ctx); await ended(f.ctx); }
    assert.equal(f.variation()['harness-status'].state, 'done', f.lines.join('\n'));
    assert.equal(f.variation()['ai-feedback-short'], 'sandbox refused automated-tests:record');
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});
