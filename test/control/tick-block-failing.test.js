// ASS-226: blockFailing forgets a step's failures only when it moved the
// ticket; a skipped step's backoff keeps doubling. A step inside Blocked that
// fails 3 times in a row sends the ticket to Blocked for Human, naming the
// step and its last error, instead of troubleshooting forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { failed, held } from '../../src/control/backoff.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');

// The control fixture with a Blocked for Human step, no timed health check,
// ABC-3 A at `at`; with `blocked`, Blocked troubleshoots (a one-prompt run).
function fixture({ at = 'plan', blocked = false, manual = false } = {}) {
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
  }
  if (at !== 'plan' || manual) edit(sprint(f), s => {
    if (manual) s.features[0]['worked-manually'] = '2026-10-12T11:00:00Z';
    if (at !== 'plan') { s.features[0]['ticket-system-status'] = 'Blocked'; s.features[0].variations[0]['harness-status'] = { state: at, 'state-engine': 'example-development' }; }
  });
  f.now = Date.parse('2026-10-12T12:00:00Z');
  f.ctx.now = () => new Date(f.now);
  return f;
}

const state = f => f.variation()['harness-status'].state;

test('ASS-226 AC2: a step inside Blocked that fails 3 times in a row sends the ticket to Blocked for Human, naming the step and its last error', async () => {
  const f = fixture({ at: 'blocked', blocked: true });
  const attempt = async () => {
    const mine = () => f.assignments().assignments.some(a => a['transient-state-engine']);
    for (let i = 0; i < 5 && !mine(); i++) { f.now += 31 * 60e3; await tick(f.ctx); }
    assert.ok(mine(), f.lines.join('\n'));
    assert.ok(await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited)));
    await tick(f.ctx);
  };
  process.env.FAKE_ERROR = '1';
  try {
    for (let i = 0; i < 2; i++) await attempt();
    assert.equal(state(f), 'blocked', f.lines.join('\n'));
    await attempt();
    assert.equal(state(f), 'blocked-for-human', f.lines.join('\n'));
    assert.match(f.variation()['ai-feedback-short'], /^troubleshoot failed 3 times in a row: .*ended its turn in an error \(error_during_execution\)$/);
    assert.ok(f.lines.some(l => /^steps ABC-3 A blocked → blocked-for-human \(failed 3 times in a row\)$/.test(l)), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_ERROR;
    f.ctx.stopAgents();
  }
});

test('ASS-226 AC2: the variation itself failing at blocked 3 times goes to Blocked for Human too', async () => {
  const f = fixture({ at: 'blocked' });
  const key = 'p/ABC-3/A/blocked';
  for (let i = 0; i < 3; i++) failed(f.ctx.memory, key, f.now, 'script exited 2');
  await tick(f.ctx);
  assert.equal(state(f), 'blocked-for-human', f.lines.join('\n'));
  assert.equal(f.variation()['ai-feedback-short'], 'blocked failed 3 times in a row: script exited 2');
  assert.equal(f.ctx.memory.backoff.has(key), false);   // moved: forgotten
  f.ctx.stopAgents();
});

// A skipped key keeps its failures: the next one holds it 4m, then 8m — past the old 2m cycle.
for (const [what, options, key] of [
  ['at Blocked for Human', { at: 'blocked-for-human' }, 'p/ABC-3/A/blocked-for-human'],
  ['of a manual ticket', { at: 'build', manual: true }, 'p/ABC-3/A/build'],
  ['of a run that maps to no ticket', { at: 'blocked-for-human' }, 'run/gone/troubleshoot'],
]) {
  test(`ASS-226 AC1, AC3: a failing step ${what} is not moved, and its backoff keeps doubling past 2m`, async () => {
    const f = fixture(options);
    const before = state(f);
    for (let i = 0; i < 3; i++) failed(f.ctx.memory, key, f.now);
    await tick(f.ctx);
    assert.equal(state(f), before, f.lines.join('\n'));
    assert.equal(f.ctx.memory.backoff.get(key)?.failures, 3);
    assert.equal(held(failed(f.ctx.memory, key, f.now).until - f.now), '4m');
    await tick(f.ctx);
    assert.equal(state(f), before);
    assert.equal(held(failed(f.ctx.memory, key, f.now).until - f.now), '8m');
    f.ctx.stopAgents();
  });
}
