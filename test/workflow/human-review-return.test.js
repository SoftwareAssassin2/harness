// ASS-228: a Human Review rejection (v2-review; ASS-314 removed grouped-review's) names the
// step the ticket goes back to — Write Execution Plan (the default, today's
// replan), Write Test Plan or Generate Solution — through the top-level
// engine, as replan does; and every grouped/v2 prompt from the return step
// onward reads the operator's notes, operator-review-{variation}.md, as they
// read requirements-change. The flat engines and their prompts are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState } from '../../src/control/engine.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { EXAMPLE_ENGINES, engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...path) => readFileSync(join(ROOT, ...path), 'utf8');
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
// The top-level engines whose Review group runs an engine with a Human Review to reject at — v2-review's.
// ASS-314 took grouped-review's out, so harness-development-grouped and example-development-grouped have no return step to name.
const TOPS = { 'harness-development-v2': 'v2-review', 'family-development': 'v2-review' };
// Each return step: the done step the Review run ends at, the group the ticket re-enters and the step it starts there.
const RETURNS = { 'write-execution-plan': ['replan', 'plan'], 'write-test-plan': ['write-test-plan', 'plan'], 'generate-solution': ['generate-solution', 'build'] };
const rejected = returnTo => ({ humanReview: { state: 'human-review', decision: 'Rejected', reason: 'No', ...(returnTo !== undefined && { 'return-to': returnTo }) } });

test('ASS-228 AC1: a Human Review rejection ends the Review run at the operator\'s return step — Write Execution Plan (replan, also when none or an unknown one is named), Write Test Plan or Generate Solution — and the top-level engine re-enters Plan or Build there', () => {
  for (const [top, review] of Object.entries(TOPS)) {
    const reviewEngine = engine(review), human = stepOf(reviewEngine, 'human-review'), topEngine = engine(top), group = stepOf(topEngine, 'review');
    for (const [returnTo, [end, into]] of Object.entries(RETURNS)) {
      assert.equal(nextState(human, reviewEngine, rejected(returnTo)).to, end, `${review} ${returnTo}`);
      assert.equal(stepOf(reviewEngine, end)['is-done'], true, `${review} ${end}`);
      const next = nextState(group, topEngine, { subEngineDone: true, subEngineState: end });
      assert.deepEqual([next.to, next.exit['start-sub-engine-at']], [into, returnTo], `${top} ${returnTo}`);
      assert.ok(stepOf(engine(stepOf(topEngine, into).action.engine), returnTo), `${top}: ${into} has ${returnTo}`);
    }
    for (const none of [undefined, 'enrich-ac']) assert.equal(nextState(human, reviewEngine, rejected(none)).to, 'replan', `${review} ${none}`);
    assert.equal(nextState(human, reviewEngine, { humanReview: { state: 'human-review', decision: 'Approved', 'return-to': 'write-test-plan' } }).to, 'token-expense-check');
    assert.deepEqual(validateStateEngine(reviewEngine, ROOT, review, EXAMPLE_ENGINES), [], review);
    assert.deepEqual(validateStateEngine(topEngine, ROOT, top, EXAMPLE_ENGINES), [], top);
  }
});

// The grouped/v2 sub-engines a return step leads into or through, and the prompts they run.
const GROUPS = ['plan', 'build', 'local-testing', 'steps-to-test', 'document', 'review'];
const FLAT = ['harness-development', 'example-development', 'blocked'];
const promptsOf = name => engine(name).steps.map(s => s.action?.prompt).filter(Boolean);
const enginesUnder = (name, seen = new Set()) => { if (seen.has(name)) return seen; seen.add(name); for (const s of engine(name).steps) if (s.action?.type === 'state-engine') enginesUnder(s.action.engine, seen); return seen; };
const flatPrompts = new Set(FLAT.flatMap(name => [...enginesUnder(name)].flatMap(promptsOf)));
// Not from the return step onward: Enrich AC runs once, before any of them; the Token Expense Check only after Human Review approves.
const BEFORE_OR_AFTER = ['enrich-ac-grouped', 'check-if-ticket-will-spend-tokens-grouped'];
const READ_NOTES = 'If {ticket-folder}/operator-review-{variation}.md exists, it holds the operator\'s notes from rejecting earlier passes at Human Review: read it and address each note in this step\'s work.';

test('ASS-228 AC3: every grouped/v2 prompt from the return step onward reads operator-review-{variation}.md and addresses each note — review-plan-grouped and a new review-root-cause-analysis-grouped among them, wired into grouped-plan and v2-plan; no flat prompt does', () => {
  for (const name of ['grouped-plan', 'v2-plan']) assert.equal(stepOf(engine(name), 'review-root-cause-analysis').action.prompt, 'review-root-cause-analysis-grouped', name);
  const run = [...new Set(['grouped', 'v2'].flatMap(family => GROUPS.flatMap(g => promptsOf(`${family}-${g}`))))].filter(p => !BEFORE_OR_AFTER.includes(p));
  for (const p of ['review-root-cause-analysis-grouped', 'review-plan-grouped', 'write-test-plan-grouped', 'generate-solution-grouped', 'explain-the-change']) assert.ok(run.includes(p), p);
  for (const p of run) assert.ok(read('prompts', p, 'prompt.txt').includes(READ_NOTES), p);
  assert.deepEqual(run.filter(p => flatPrompts.has(p)), [], 'no grouped/v2 prompt is shared with a flat engine');
  for (const p of flatPrompts) assert.doesNotMatch(read('prompts', p, 'prompt.txt'), /operator-review/, `${p}: a flat engine's prompt is unchanged`);
  const copy = read('prompts', 'review-root-cause-analysis-grouped', 'prompt.txt');
  assert.equal(copy.replace(`${READ_NOTES}\n\n`, ''), read('prompts', 'review-root-cause-analysis', 'prompt.txt'), 'the copy is the flat prompt plus the notes');
  assert.deepEqual(JSON.parse(read('prompts', 'review-root-cause-analysis-grouped', 'prompt.json')).output, JSON.parse(read('prompts', 'review-root-cause-analysis', 'prompt.json')).output);
  assert.ok(existsSync(join(ROOT, 'prompts', 'review-root-cause-analysis-grouped', 'prompt.json')));
  assert.ok(readdirSync(join(ROOT, 'prompts')).includes('review-plan-grouped'), 'ASS-231\'s copy reused');
});
