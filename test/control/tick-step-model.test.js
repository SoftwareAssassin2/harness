// ASS-452 AC2: control dispatches a prompt step whose action names a model on
// exactly that model — every agent of the step, through assignments:create
// --model — the round robin and last-model-used untouched; a step naming none
// keeps the round robin. Run on the control fixture (its plan step, a prompt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

// The fixture with its plan step's action given `extra` (e.g. a model and an agent-count).
function withPlan(extra) {
  const f = controlFixture();
  const file = join(f.dir, 'engines', 'example-development', 'state-engine.json');
  const engine = JSON.parse(readFileSync(file, 'utf8'));
  for (const s of engine.steps) if (s.id === 'plan') s.action = { ...s.action, ...extra };
  writeFileSync(file, JSON.stringify(engine, null, 4));
  return f;
}

test('ASS-452 AC2: a step naming a model runs every agent on it, the round robin and last-model-used left as they were', async () => {
  const f = withPlan({ model: 'claude-opus-4-8', 'agent-count': 3 });
  try {
    const before = f.lastModelUsed();
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'plan');
    const records = f.assignments().assignments;
    assert.deepEqual(records.map(r => [r.prompt, r.model]), Array(3).fill(['review-plan', 'claude-opus-4-8']));
    assert.equal(f.lastModelUsed(), before);
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-452 AC2: a step naming no model keeps the round robin, from after last-model-used, which moves on', async () => {
  const f = withPlan({ 'agent-count': 2 });
  try {
    assert.equal(f.lastModelUsed(), 'claude-opus-5');
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(r => r.model), ['claude-sonnet-5', 'claude-opus-4-8']);
    assert.equal(f.lastModelUsed(), 'claude-opus-4-8');
  } finally {
    f.ctx.stopAgents();
  }
});
