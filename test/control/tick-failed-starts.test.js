// ASS-167: an agent that cannot start — it exits with no result and never
// sends its init event (e.g. its CLI missing in the VM) — is a failed start
// of its step; 3 in a row, at a ticket step or at one of Blocked's own steps,
// send the ticket to Blocked for Human with its stderr as the feedback. A
// successful start resets the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// The control fixture with a Blocked for Human step and no timed health check
// (its agents would be counted as ABC-3's); with `blocked`, its
// Blocked step troubleshoots (a run of a one-prompt engine) and ABC-3 A is there.
function failedStartFixture({ blocked = false } = {}) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-health-interval-seconds'] = 1e9;
    e.steps.unshift({ id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, action: { type: 'human' } });
    if (blocked) Object.assign(e.steps.find(s => s.id === 'blocked'), { action: { type: 'state-engine', engine: 'troubleshoot' } });
  });
  if (blocked) {
    mkdirSync(join(f.dir, 'engines', 'troubleshoot'), { recursive: true });
    writeFileSync(join(f.dir, 'engines', 'troubleshoot', 'state-engine.json'), JSON.stringify({ steps: [
      { id: 'troubleshoot', sequence: 1, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
      { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
    ] }));
    edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
      s.features[0]['ticket-system-status'] = 'Blocked';
      s.features[0].variations[0]['harness-status'] = { state: 'blocked', 'state-engine': 'example-development' };
    });
  }
  let now = Date.parse('2026-10-12T12:00:00Z');
  f.ctx.now = () => new Date(now);
  // attempt(env) — ABC-3's next agent, under `env`: ticked (past any hold) until one is on it, then until it has ended and been finished.
  f.attempt = async env => {
    Object.assign(process.env, env);
    try {
      const mine = () => f.assignments().assignments.some(a => a['work-item'] === 'ABC-3' || a['transient-state-engine']);
      for (let i = 0; i < 5 && !mine(); i++) { now += 31 * 60e3; await tick(f.ctx); }
      assert.ok(mine(), f.lines.join('\n'));
      assert.ok(await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited)));
      await tick(f.ctx);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };
  return f;
}

const NO_START = { FAKE_NO_START: '1' };
const state = f => f.variation()['harness-status'].state;

test('ASS-167 AC1, AC2: a ticket step whose agent cannot start 3 times in a row sends the ticket to Blocked for Human, its stderr the feedback', async () => {
  const f = failedStartFixture();
  for (let i = 0; i < 2; i++) await f.attempt(NO_START);
  assert.equal(state(f), 'plan', f.lines.join('\n'));
  await f.attempt(NO_START);
  assert.equal(state(f), 'blocked-for-human', f.lines.join('\n'));
  assert.equal(f.variation()['ai-feedback-short'], 'agent could not start 3 times: claude: command not found');
  assert.equal(f.variation()['ai-feedback-long'], 'claude: command not found');
  assert.ok(f.lines.some(l => /^steps ABC-3 A plan → blocked-for-human \(could not start 3 times in a row\)$/.test(l)), f.lines.join('\n'));
});

test('ASS-167 AC2: one of Blocked\'s own steps whose agent cannot start 3 times in a row sends the ticket to Blocked for Human, not another troubleshoot', async () => {
  const f = failedStartFixture({ blocked: true });
  for (let i = 0; i < 2; i++) await f.attempt(NO_START);
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
  await f.attempt(NO_START);
  assert.equal(state(f), 'blocked-for-human', f.lines.join('\n'));
  assert.equal(f.variation()['ai-feedback-short'], 'agent could not start 3 times: claude: command not found');
});

// Three failures of any kind in a row inside Blocked go to Blocked for Human
// (ASS-226), so the reset is seen on the count itself.
test('ASS-167 AC3: a successful start resets the count — a failed start, one that starts (its turn an error): no count; a failed start: 1', async () => {
  const f = failedStartFixture({ blocked: true });
  const counts = () => [...(f.ctx.memory.failedStarts ?? new Map()).values()].map(s => s.count);
  await f.attempt(NO_START);
  assert.deepEqual(counts(), [1]);
  await f.attempt({ FAKE_ERROR: '1' });
  assert.deepEqual(counts(), []);
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
  await f.attempt(NO_START);
  assert.deepEqual(counts(), [1]);
});
