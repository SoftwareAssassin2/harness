// ASS-265: the example GitHub project's Too Large (ASS-264) offers a third choice, Split,
// beside Accept and Return — ASS-252's Split, reused: the split-ticket prompt's
// agent proposes smaller tickets through ticket:propose-split, Check the
// Proposal (ticket:split-proposed) makes sure it recorded one this time, and
// the ticket rests at Awaiting Split Decision, which shows the proposal as the
// harness's does. Accept runs ticket:apply-split (the tickets created, each
// starting refinement, and the original marked split: superseded, out of the
// backlog); Reject, a proposal not recorded or a failed apply each go back to
// Too Large, never to a dead end. The example GitHub project never splits but at the
// operator's word: no estimate takes it to Split. Walked through the engine as
// control reads it (test/support/engine-walk.js, ASS-258).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, isHumanStep, isDoneStep } from '../../src/control/engine.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { ROOT, loadEngines, walk, inOrder, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const engines = loadEngines();
const R = 'example-github-backlog-refinement', e = engines[R], H = 'harness-backlog-refinement';
// refine(answers) — an example GitHub ticket walked from its first step, groomed ready; `answers` by step id.
const refine = (answers = {}) => {
  const r = walk(engines, R, { answers: Object.fromEntries(Object.entries({ groom: { structuredOutput: { 'is-ready': true } }, ...answers }).map(([id, v]) => [`${R}/${id}`, v])) });
  return { ...r, steps: r.trail.map(p => p.split('/')[1]) };
};
// Estimated 8: noted, and at Too Large for the operator.
const EIGHT = { estimate: { structuredOutput: { points: 8, summary: 's' } } };
// at(step, ...decisions) — the operator's choice at each visit to a human step, in turn; none after them.
const at = (step, ...decisions) => ({ [step]: [...decisions.map(d => (typeof d === 'string' ? { humanReview: d } : d)), {}] });
const runs = (steps, text) => steps.some(id => JSON.stringify(stepOf(e, id).action).includes(text));

test('ASS-265 AC1: the example GitHub project\'s refinement validates, and its Too Large offers Split beside Accept and Return — Split asking for no note', () => {
  assert.deepEqual(validateStateEngine(e, ROOT, R, EXAMPLE_ENGINES), []);
  const choices = stepOf(e, 'too-large')['exit-events'].filter(x => x.condition['human-review']);
  assert.deepEqual(choices.map(x => x.condition['human-review']), ['Accept', 'Return', 'Split']);
  assert.notEqual(choices.find(x => x.condition['human-review'] === 'Split')['asks-for-reason'], true);
});

test('ASS-265 AC2: Split — the split-ticket prompt\'s agent proposes, the proposal is checked, and the ticket rests at Awaiting Split Decision, which shows it', () => {
  const r = refine({ ...EIGHT, ...at('too-large', 'Split') });
  assert.deepEqual([r.end, r.rests], ['awaiting-split-decision', true]);
  assert.ok(inOrder(r.steps, ['estimate', 'too-large', 'split', 'awaiting-split-decision']), r.steps.join(' '));
  assert.ok(runs(r.steps, 'ticket:split-proposed'), r.steps.join(' '));
  assert.ok(isHumanStep(e, 'awaiting-split-decision'));
  assert.equal(stepOf(e, 'awaiting-split-decision').shows, 'split-proposal');
  assert.equal(refine({ ...EIGHT, ...at('too-large', 'Split'), split: { turnComplete: false } }).end, 'split', 'Split\'s agent still working: the ticket stays');
  // ASS-252's pieces, reused: the same prompt, run as the harness's Split runs it, and the same apply.
  assert.deepEqual(stepOf(e, 'split').action, stepOf(engines[H], 'split').action);
  assert.deepEqual(stepOf(e, 'create-split-tickets').action, stepOf(engines[H], 'create-split-tickets').action);
});

test('ASS-265 AC3, AC5: an example GitHub ticket estimated 8 → Too Large → Split → Accept: the tickets created (ticket:apply-split), the original split — superseded for good, never Ready', () => {
  const r = refine({ ...EIGHT, ...at('too-large', 'Split'), ...at('awaiting-split-decision', 'Accept') });
  assert.deepEqual([r.end, r.rests], ['superseded', true]);
  assert.ok(inOrder(r.steps, ['estimate', 'too-large', 'split', 'awaiting-split-decision', 'superseded']), r.steps.join(' '));
  assert.ok(runs(r.steps.slice(r.steps.indexOf('awaiting-split-decision')), 'ticket:apply-split'), r.steps.join(' '));
  assert.ok(!isDoneStep(e, 'superseded') && !r.steps.includes('ready'), 'never joins a sprint');
  assert.deepEqual([stepOf(e, 'superseded').action.type, stepOf(e, 'superseded')['exit-events'] ?? []], ['none', []]);
});

test('ASS-265 AC3, AC5: Reject at Awaiting Split Decision asks why and goes back to Too Large, where the operator chooses again', () => {
  const reject = stepOf(e, 'awaiting-split-decision')['exit-events'].find(x => x.condition['human-review'] === 'Reject');
  assert.equal(reject['asks-for-reason'], true);
  const r = refine({ ...EIGHT, ...at('too-large', 'Split', 'Accept'), ...at('awaiting-split-decision', 'Reject') });
  assert.deepEqual([r.end, r.rests], ['ready', false]);
  assert.ok(inOrder(r.steps, ['too-large', 'split', 'awaiting-split-decision', 'too-large', 'ready']), r.steps.join(' '));
  assert.ok(!runs(r.steps, 'ticket:apply-split'));
  // Rejected and left: it rests at Too Large.
  assert.equal(refine({ ...EIGHT, ...at('too-large', 'Split'), ...at('awaiting-split-decision', 'Reject') }).end, 'too-large');
  // Split again after a Reject: proposed again, then accepted.
  const again = refine({ ...EIGHT, ...at('too-large', 'Split', 'Split'), ...at('awaiting-split-decision', 'Reject', 'Accept') });
  assert.equal(again.end, 'superseded');
  assert.equal(again.steps.filter(id => id === 'split').length, 2);
});

test('ASS-265 AC3, AC5: a failed apply, or a proposal not recorded, goes back to Too Large — never a dead end', () => {
  const failed = refine({ ...EIGHT, ...at('too-large', 'Split'), ...at('awaiting-split-decision', 'Accept'), 'create-split-tickets': { exitCode: 1 } });
  assert.deepEqual([failed.end, failed.rests], ['too-large', true]);
  assert.ok(inOrder(failed.steps, ['awaiting-split-decision', 'create-split-tickets', 'too-large']), failed.steps.join(' '));
  const none = refine({ ...EIGHT, ...at('too-large', 'Split'), 'check-split-proposal': { exitCode: 1 } });
  assert.deepEqual([none.end, none.rests], ['too-large', true]);
  assert.ok(!none.steps.includes('awaiting-split-decision'), none.steps.join(' '));
  // From there the operator's other choices still work.
  assert.equal(refine({ ...EIGHT, ...at('too-large', 'Split', 'Accept'), 'check-split-proposal': { exitCode: 1 } }).end, 'ready');
});

test('ASS-265 AC3: at Awaiting Split Decision an open blocking question waits for its answer; a non-blocking one, or a choice made at another step, leaves it waiting for the operator', () => {
  const asked = refine({ ...EIGHT, ...at('too-large', 'Split'), ...at('awaiting-split-decision', { questions: () => [{ status: 'Asked' }] }) });
  assert.ok(inOrder(asked.steps, ['awaiting-split-decision', 'awaiting-answers', 'groom']), asked.steps.join(' '));
  assert.equal(refine({ ...EIGHT, ...at('too-large', 'Split'), ...at('awaiting-split-decision', { questions: () => [{ status: 'Asked', blocking: false }] }) }).end, 'awaiting-split-decision');
  assert.equal(refine({ ...EIGHT, ...at('too-large', 'Split'), 'awaiting-split-decision': { humanReview: 'Approved' } }).end, 'awaiting-split-decision');
});

test('ASS-265 AC4: the example GitHub project never reaches Split but by the operator\'s choice — no estimate, nor Estimate\'s max-visits, nor any other choice takes it there', () => {
  for (const points of [1, 2, 3, 5, null, 8, 13]) assert.ok(!refine({ estimate: { structuredOutput: { points, summary: 's' } } }).steps.includes('split'), String(points));
  assert.ok(!refine({ estimate: { structuredOutput: {} } }).steps.includes('split'), 'max-visits');
  for (const choice of ['Accept', 'Return']) assert.ok(!refine({ ...EIGHT, ...at('too-large', choice) }).steps.includes('split'), choice);
  // Split is entered from Too Large's Split alone.
  const into = engines[R].steps.flatMap(s => (s['exit-events'] ?? []).filter(x => x['move-to-state'] === 'split').map(x => [s.id, x.condition['human-review']]));
  assert.deepEqual(into, [['too-large', 'Split']]);
  assert.ok(!engines[R].steps.some(s => s['on-max-visits'] === 'split'));
});

// The split-ticket prompt was written for the harness's tickets: it sized pieces by the harness's code and
// its parts alone. An example GitHub ticket's agent reads the example GitHub project's code, {project-code-folder}; a harness
// ticket's still the harness's, {harness-folder}. Its steps and its one write are as they were.
test('ASS-265 AC2, AC4: the split-ticket prompt sizes a ticket by its own project\'s code — the harness\'s for a harness ticket, as before', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'split-ticket', 'prompt.txt'), 'utf8');
  assert.match(text, /Read the code it touches, in \{project-code-folder\} \(a harness ticket's: \{harness-folder\}\)/);
  assert.match(text, /5: across several parts of the system \(in the harness: control, the CLI and the TUI\)/);
  assert.match(text, /\{agent-sh\} ticket:propose-split \{project\} \{ticket\} -/);
  assert.match(text, /at awaiting-split-decision/);   // the example GitHub project's gate has the harness's gate's id, so the prompt's rejection note holds
});
