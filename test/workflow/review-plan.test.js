// ASS-231: a Review Plan rejection in grouped-plan and v2-plan goes back to
// the earliest step whose output a must-fix touches — revise-from, the grouped
// prompt's output — not always Write Execution Plan. The flat engines and the
// flat review-plan prompt are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { EXAMPLE_ENGINES, engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...path) => readFileSync(join(ROOT, ...path), 'utf8');
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
const GROUPED = ['grouped-plan', 'v2-plan'], FLAT = ['harness-development', 'example-development'];
const REVISE_FROM = ['root-cause-analysis', 'write-execution-plan', 'write-test-plan'];
const rejected = reviseFrom => ({ turnComplete: true, structuredOutput: { 'is-approved': false, ...(reviseFrom !== undefined && { 'revise-from': reviseFrom }) } });

test('AC1: the grouped review-plan prompt outputs revise-from on rejection — one of the three steps, the earliest a must-fix touches', () => {
  const json = JSON.parse(read('prompts', 'review-plan-grouped', 'prompt.json'));
  assert.deepEqual(json.output.properties['revise-from'].enum, REVISE_FROM);
  assert.deepEqual(json.output.required, ['is-approved']);
  const text = read('prompts', 'review-plan-grouped', 'prompt.txt');
  assert.match(text, /"revise-from"/);
  assert.match(text, /earliest/);
  for (const id of REVISE_FROM) assert.ok(text.includes(`"${id}"`), id);
  for (const name of GROUPED) assert.equal(stepOf(engine(name), 'review-plan').action.prompt, 'review-plan-grouped', name);
});

// routed(e, facts) — where Review Plan's verdict sends the plan: through grouped-plan's Record the Plan
// Objections (ASS-399), which goes on by the run's output — the review's revise-from — on exit 0.
function routed(e, facts) {
  const to = nextState(stepOf(e, 'review-plan'), e, facts).to;
  return to !== 'record-plan-objections' ? to : nextState(stepOf(e, to), e, { exitCode: 0, structuredOutput: facts.structuredOutput }).to;
}

test('AC2: grouped-plan and v2-plan route a rejection to its revise-from; a missing or unknown one falls back to Write Execution Plan', () => {
  for (const name of GROUPED) {
    const e = engine(name), step = stepOf(e, 'review-plan');
    for (const id of REVISE_FROM) assert.equal(routed(e, rejected(id)), id, `${name} ${id}`);
    for (const bad of [undefined, null, 'test-plan']) assert.equal(routed(e, rejected(bad)), 'write-execution-plan', `${name} ${bad}`);
    assert.equal(nextState(step, e, { turnComplete: true, structuredOutput: { 'is-approved': true } }).to, 'done');
    assert.deepEqual(validateStateEngine(e, ROOT, name, EXAMPLE_ENGINES), [], name);
  }
});

test('AC3: the flat review-plan prompt and the flat engines\' Review Plan are unchanged', () => {
  assert.doesNotMatch(read('prompts', 'review-plan', 'prompt.txt'), /revise-from/);
  assert.deepEqual(Object.keys(JSON.parse(read('prompts', 'review-plan', 'prompt.json')).output.properties), ['is-approved']);
  for (const name of FLAT) {
    const step = stepOf(engine(name), 'review-plan');
    assert.equal(step.action.prompt, 'review-plan', name);
    assert.ok(step['exit-events'].every(x => !x['move-to-state-from-structured-output']), name);
    assert.equal(nextState(step, engine(name), rejected('write-test-plan')).to, 'write-execution-plan', name);
  }
});

// walk(name, reviews) — the plan engine's run from its first step, every fact passing; Review Plan's verdict the next of `reviews`.
// A script step (grouped-plan's Record the Plan Objections, ASS-399) exits 0 and reads the run's output, every prompt's merged, as control's does.
// Its trail leaves out the record step, which only passes the plan on.
function walk(name, reviews) {
  const e = engine(name), trail = [], changes = [];
  let output = {};
  for (let at = firstStepId(e), i = 0; !stepOf(e, at)['is-done'] && i < 50; i++) {
    const script = stepOf(e, at).action.type === 'script';
    if (!script) trail.push(at);
    const own = at === 'review-plan' ? reviews.shift() : { 'is-approved': true };
    if (!script) output = { ...output, ...own };
    const facts = { turnComplete: true, exitCode: 0, fileUpdated: () => true, variation: { 'acceptance-criteria': [{}] }, structuredOutput: script ? output : own };
    const next = nextState(stepOf(e, at), e, facts, changes);
    changes.push({ 'from-state': at, 'to-state': next.to });
    at = next.to;
  }
  return trail;
}

test('AC4: a test-plan-only rejection re-runs Write Test Plan without visiting Write Execution Plan; one touching the root cause starts there', () => {
  for (const name of GROUPED) {
    const trail = walk(name, [rejected('write-test-plan').structuredOutput, { 'is-approved': true }]);
    assert.deepEqual(trail.slice(trail.indexOf('review-plan')), ['review-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan'], name);
    assert.equal(trail.filter(s => s === 'write-execution-plan').length, 1, name);
    const rca = walk(name, [rejected('root-cause-analysis').structuredOutput, { 'is-approved': true }]);
    assert.deepEqual(rca.slice(rca.indexOf('review-plan') + 1, rca.indexOf('review-plan') + 3), ['root-cause-analysis', 'review-root-cause-analysis'], name);
  }
});
