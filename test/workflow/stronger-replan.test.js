// ASS-399: a plan Review Plan keeps rejecting gets one stronger re-plan, then
// a question to the operator. In grouped-plan, the third rejection — the one
// that would end Plan at its max visits — goes to Write Execution Plan on a
// Stronger Model instead of Blocked, every objection so far recorded for it;
// that plan approved, Plan goes on as normal; rejected too, the operator is
// asked (question:ask, blocking) and Plan waits for the answer, then plans
// again with every step's visits counted afresh. Walked with control's own
// reading of an engine (src/control/engine.js nextState), as control moves a
// run: a prompt's output merged into the run's, a script step reading that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';
import { modelFor } from '../../src/control/dispatch.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { EXAMPLE_ENGINES, engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
const PLAN = engine('grouped-plan');
const rejected = reviseFrom => ({ 'is-approved': false, 'revise-from': reviseFrom });
const APPROVED = { 'is-approved': true };
const PASS = ['write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan'];
const STRONGER = ['record-objections-for-stronger-plan', 'write-execution-plan-stronger', 'write-test-plan', 'enrich-automated-test-data', 'review-plan'];

// walk(reviews, { open, from, changes }) — grouped-plan's run from `from` (its first step), every fact passing but
// Review Plan's verdicts, the next of `reviews` each time; open(), whether a blocking question is open on the
// ticket. Stops at a done step or where no exit matches (a step resting: Awaiting the Plan Answer while the
// question is open). Returns { trail, end, changes }, `changes` the run's moves, as control records them.
function walk(reviews, { open = () => true, from = firstStepId(PLAN), changes = [] } = {}) {
  const trail = [];
  let output = {};
  for (let at = from, i = 0; i < 100; i++) {
    const step = stepOf(PLAN, at);
    trail.push(at);
    if (step['is-done']) return { trail, end: at, changes };
    const own = at === 'review-plan' ? reviews.shift() : APPROVED;
    if (step.action.type === 'prompt') output = { ...output, ...own };
    const facts = {
      turnComplete: true, exitCode: 0, fileUpdated: () => true, variation: { 'acceptance-criteria': [{}] },
      questions: () => (open() ? [{ status: 'Asked', blocking: true }] : [{ status: 'Answered', blocking: true }]),
      structuredOutput: step.action.type === 'prompt' ? own : output,
    };
    const next = nextState(step, PLAN, facts, changes);
    if (!next) return { trail, end: at, changes };
    changes.push({ 'from-state': at, 'to-state': next.to });
    at = next.to;
  }
  throw new Error(`ran away: ${trail.slice(-10).join(' ')}`);
}
const fromReview = trail => trail.slice(trail.indexOf('review-plan'));

test('ASS-399: grouped-plan validates, its new steps on the host but the stronger re-plan, which runs in the VM like Write Execution Plan on the stronger model', () => {
  assert.deepEqual(validateStateEngine(PLAN, ROOT, 'grouped-plan', EXAMPLE_ENGINES), []);
  const plain = stepOf(PLAN, 'write-execution-plan'), stronger = stepOf(PLAN, 'write-execution-plan-stronger');
  assert.deepEqual(stronger.action, { ...plain.action, model: 'stronger' });
  assert.deepEqual([stronger['run-location'], stronger['is-planning-stage'], stronger['max-visits'], stronger['on-max-visits']], ['vm', true, 2, 'blocked']);
  assert.equal(plain.action.model, undefined, 'every other step keeps the round robin');
  for (const id of ['record-plan-objections', 'record-objections-for-stronger-plan', 'ask-operator-about-plan', 'awaiting-plan-answer']) {
    assert.equal(stepOf(PLAN, id)['run-location'], undefined, id);
    assert.equal(stepOf(PLAN, id)['is-planning-stage'], true, id);
  }
  for (const id of ['record-plan-objections', 'record-objections-for-stronger-plan']) assert.equal(stepOf(PLAN, id).action.command, './agent.sh plan:record-objections {project} {ticket} {variation}', id);
  assert.equal(stepOf(PLAN, 'ask-operator-about-plan').action.command, './agent.sh plan:ask-about-objections {project} {ticket} {variation}');
});

test('ASS-399 AC1: the third rejection, which would end Plan at its max visits, goes to Write Execution Plan on a Stronger Model, through the step that records the objections, whatever step the reviews named', () => {
  for (const reviseFrom of ['write-execution-plan', 'write-test-plan']) {
    const { trail } = walk([rejected(reviseFrom), rejected(reviseFrom), rejected(reviseFrom), APPROVED]);
    const again = reviseFrom === 'write-execution-plan' ? PASS : PASS.slice(1);
    assert.deepEqual(fromReview(trail), ['review-plan', 'record-plan-objections', ...again, 'record-plan-objections', ...again, ...STRONGER, 'done'], reviseFrom);
    assert.equal(trail.filter(s => s === 'write-execution-plan-stronger').length, 1, reviseFrom);
  }
  // Without ASS-399 the third rejection's re-plan was Write Execution Plan's fourth visit: Blocked.
  const before = structuredClone(PLAN);
  stepOf(before, 'review-plan')['exit-events'][1] = { condition: stepOf(PLAN, 'review-plan')['exit-events'][1].condition, 'move-to-state-from-structured-output': 'revise-from', 'move-to-state': 'write-execution-plan' };
  const changes = [{ 'from-state': 'review-root-cause-analysis', 'to-state': 'write-execution-plan' }, ...Array(2).fill({ 'from-state': 'record-plan-objections', 'to-state': 'write-execution-plan' })];
  assert.equal(nextState(stepOf(before, 'review-plan'), before, { turnComplete: true, structuredOutput: rejected('write-execution-plan') }, changes).to, 'blocked');
});

test('ASS-399 AC1: the stronger re-plan runs on harness.json\'s stronger-model, else its first (strongest) Claude model; a step naming no model is left to the round robin', () => {
  const step = stepOf(PLAN, 'write-execution-plan-stronger');
  const claude = models => ({ 'agentic-command-line-interfaces': [{ name: 'codex', models: ['gpt-x'] }, { name: 'claude', models }] });
  assert.equal(modelFor(step, claude(['claude-opus-5-5', 'claude-sonnet-5'])), 'claude-opus-5-5');
  assert.equal(modelFor(step, { ...claude(['claude-opus-5-5', 'claude-sonnet-5']), 'stronger-model': 'claude-opus-5' }), 'claude-opus-5');
  assert.equal(modelFor(step, JSON.parse(readFileSync(join(ROOT, 'data', 'harness.json'), 'utf8'))), 'claude-opus-5-5');
  assert.equal(modelFor(step, {}), undefined);
  assert.equal(modelFor(stepOf(PLAN, 'write-execution-plan'), claude(['claude-opus-5-5'])), undefined);
});

test('ASS-399 AC1: Write Execution Plan reads every objection so far, plan-objections-{variation}.md, summing them up under the plan\'s Objections section; the flat prompt does not', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'write-execution-plan-grouped', 'prompt.txt'), 'utf8');
  assert.match(text, /\{ticket-folder\}\/plan-objections-\{variation\}\.md exists, it holds every review that rejected an earlier draft/);
  assert.match(text, /"## Objections"/);
  assert.match(text, /questions-and-answers\.json, follow the answer/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'prompts', 'write-execution-plan', 'prompt.txt'), 'utf8'), /plan-objections/);
});

test('ASS-399 AC2: the stronger plan approved, Plan goes on as normal to done', () => {
  const { trail, end } = walk([rejected('write-execution-plan'), rejected('write-execution-plan'), rejected('write-execution-plan'), APPROVED]);
  assert.equal(end, 'done');
  assert.deepEqual(trail.slice(-6), [...STRONGER, 'done']);
  assert.ok(!trail.includes('ask-operator-about-plan'));
});

test('ASS-399 AC3: the stronger plan rejected too, the operator is asked instead of Blocked; Plan rests until no blocking question is open, then plans again with every visit counted afresh', () => {
  const reviews = Array(4).fill(rejected('write-execution-plan'));
  const waiting = walk([...reviews]);
  assert.equal(waiting.end, 'awaiting-plan-answer');
  assert.deepEqual(waiting.trail.slice(-7), [...STRONGER, 'ask-operator-about-plan', 'awaiting-plan-answer']);
  assert.ok(!waiting.trail.includes('blocked'));
  // Answered: back to Write Execution Plan, the visits counted afresh — two more rejections re-plan as normal, the third goes to the stronger re-plan again.
  const answered = walk([...reviews.slice(0, 3), APPROVED], { open: () => false, from: 'awaiting-plan-answer', changes: waiting.changes });
  assert.deepEqual(answered.trail, ['awaiting-plan-answer', ...PASS, 'record-plan-objections', ...PASS, 'record-plan-objections', ...PASS, ...STRONGER, 'done']);
  // A failing record or question command still ends Plan at Blocked.
  for (const id of ['record-plan-objections', 'record-objections-for-stronger-plan', 'ask-operator-about-plan']) assert.equal(nextState(stepOf(PLAN, id), PLAN, { exitCode: 1 }).to, 'blocked', id);
});

test('ASS-399: validate.js takes an action\'s model only as "stronger", on a prompt step', () => {
  const engineWith = action => ({ steps: [{ id: 'a', sequence: 1, action, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] }, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }] });
  const prompt = { type: 'prompt', prompt: 'write-execution-plan-grouped', 'agent-count': 1 };
  assert.deepEqual(validateStateEngine(engineWith({ ...prompt, model: 'stronger' }), ROOT), []);
  assert.match(validateStateEngine(engineWith({ ...prompt, model: 'claude-opus-5' }), ROOT).join('\n'), /model "claude-opus-5" is not "stronger"/);
  assert.match(validateStateEngine(engineWith({ type: 'none', model: 'stronger' }), ROOT).join('\n'), /model needs a prompt action/);
});
