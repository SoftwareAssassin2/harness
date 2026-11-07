// ASS-252: the harness's backlog refinement splits a ticket too large for one
// sprint ticket. Estimate (estimate-with-split) says too-large — or estimates
// above 5 — and the ticket goes past Check Kept Whole to Split, whose agent
// (split-ticket) proposes smaller tickets through ticket:propose-split; the
// operator decides at Awaiting Split Decision: Accept runs ticket:apply-split
// (the tickets created, the original superseded), Reject (with a reason) goes
// back to Split, Keep whole marks it (off-board.sh ticket:keep-whole) and it
// goes on to Ready, never to Split again. Any other estimate goes to Ready as
// before. ASS-258: each path is walked through the engine as control reads it
// (test/support/engine-walk.js), so the tests say where a ticket goes, not how
// the engine is worded or how many steps it takes to get there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, isHumanStep, isDoneStep } from '../../src/control/engine.js';
import { ROOT, loadEngines, walk, inOrder } from '../support/engine-walk.js';

const engines = loadEngines();
const R = 'harness-backlog-refinement', e = engines[R];
const prompt = name => JSON.parse(readFileSync(join(ROOT, 'prompts', name, 'prompt.json'), 'utf8'));
// refine(answers) — a ticket walked through the harness's refinement from its first step, groomed ready; `answers` by step id.
const refine = (answers = {}) => {
  const r = walk(engines, R, { answers: Object.fromEntries(Object.entries({ groom: { structuredOutput: { 'is-ready': true } }, ...answers }).map(([id, v]) => [`${R}/${id}`, v])) });
  return { ...r, steps: r.trail.map(p => p.split('/')[1]) };
};
const estimated = output => ({ estimate: { structuredOutput: { summary: 's', 'too-large': false, ...output } } });
// Too large, and not kept whole before: Check Kept Whole's ticket:kept-whole fails.
const TOO_LARGE = { ...estimated({ points: 8 }), 'check-kept-whole': { exitCode: 1 } };
// decide(...) — the operator's choice at each visit to the gate, in turn; none after them (a choice decides only the visit it is made in: facts.js fresh).
const decide = (...decisions) => ({ 'awaiting-split-decision': [...decisions.map(d => (typeof d === 'string' ? { humanReview: d } : d)), {}] });
const runs = (steps, text) => steps.some(id => JSON.stringify(stepOf(e, id).action).includes(text));

test('ASS-252, ASS-258: the harness\'s engines refine with harness-backlog-refinement — harness-development-v2 the one the harness and software-assassin projects run', () => {
  for (const name of ['harness-development', 'harness-development-grouped', 'harness-development-v2'])
    assert.ok(engines[name]['backlog-refinement-steps'].some(s => s.action.engine === R), name);
});

test('ASS-252 AC1: an estimate of 1, 2, 3 or 5 points, or none, goes to Ready, never to Split; one off the scale is estimated again', () => {
  for (const points of [1, 2, 3, 5, null]) {
    const r = refine(estimated({ points }));
    assert.deepEqual([r.end, r.rests], ['ready', false], String(points));
    assert.ok(isDoneStep(e, r.end));
    assert.ok(!r.steps.includes('split'), String(points));
  }
  const again = refine({ estimate: [{ structuredOutput: { points: 4 } }, { structuredOutput: { points: 3, 'too-large': false, summary: 's' } }] });
  assert.equal(again.end, 'ready');
  assert.ok(inOrder(again.steps, ['estimate', 'groom', 'estimate', 'ready']), again.steps.join(' '));
});

test('ASS-252 AC1, AC2: a split proposed — too large, or above 5 — Split\'s agent proposes it and the ticket rests at the operator\'s gate, which shows the proposal', () => {
  for (const output of [{ points: 8 }, { points: 13 }, { points: 5, 'too-large': true }, { points: null, 'too-large': true }]) {
    const r = refine({ ...TOO_LARGE, ...estimated(output) });
    assert.deepEqual([r.end, r.rests], ['awaiting-split-decision', true], JSON.stringify(output));
    assert.ok(inOrder(r.steps, ['estimate', 'split', 'awaiting-split-decision']), r.steps.join(' '));
    assert.ok(!r.steps.includes('ready'));
  }
  const split = stepOf(e, 'split');
  assert.deepEqual([split.action.type, split.action.prompt, split.action['run-in-dev-container']], ['prompt', 'split-ticket', false]);
  assert.ok(isHumanStep(e, 'awaiting-split-decision'));
  assert.equal(stepOf(e, 'awaiting-split-decision').shows, 'split-proposal');   // the TUI shows the proposal there
  assert.equal(refine({ ...TOO_LARGE, split: { turnComplete: false } }).end, 'split', 'Split\'s agent still working: the ticket stays');
});

test('ASS-252 AC3: a split accepted — the tickets created (ticket:apply-split), the original superseded for good, never Ready; a failed apply goes back to the gate', () => {
  const r = refine({ ...TOO_LARGE, ...decide('Accept') });
  assert.deepEqual([r.end, r.rests], ['superseded', true]);
  assert.ok(!isDoneStep(e, 'superseded') && !r.steps.includes('ready'), 'never joins a sprint');
  assert.ok(runs(r.steps.slice(r.steps.indexOf('awaiting-split-decision')), 'ticket:apply-split'), r.steps.join(' '));
  const failed = refine({ ...TOO_LARGE, ...decide('Accept'), 'create-split-tickets': { exitCode: 1 } });
  assert.equal(failed.end, 'awaiting-split-decision');
  assert.ok(inOrder(failed.steps, ['awaiting-split-decision', 'create-split-tickets', 'awaiting-split-decision']));
});

test('ASS-252 AC3: a split rejected — the operator asked why — goes back to Split for another proposal, then decided again', () => {
  const reject = stepOf(e, 'awaiting-split-decision')['exit-events'].find(x => x.condition['human-review'] === 'Reject');
  assert.equal(reject['asks-for-reason'], true);
  const r = refine({ ...TOO_LARGE, ...decide('Reject', 'Accept') });
  assert.equal(r.end, 'superseded');
  assert.ok(inOrder(r.steps, ['split', 'awaiting-split-decision', 'split', 'awaiting-split-decision', 'superseded']), r.steps.join(' '));
  assert.equal(r.steps.filter(id => id === 'split').length, 2);
});

test('ASS-252 AC3: kept whole — marked (off-board.sh ticket:keep-whole) and on to Ready; estimated too large again later, it goes to Ready, not Split', () => {
  const r = refine({ ...TOO_LARGE, ...decide('Keep whole') });
  assert.deepEqual([r.end, r.rests], ['ready', false]);
  assert.ok(runs(r.steps.slice(r.steps.indexOf('awaiting-split-decision')), 'ticket:keep-whole'), r.steps.join(' '));
  assert.equal(refine({ ...TOO_LARGE, ...decide('Keep whole'), 'keep-whole': { exitCode: 1 } }).end, 'awaiting-split-decision', 'not marked: decided again');
  // Refined again with the mark: Check Kept Whole's ticket:kept-whole succeeds.
  const later = refine({ ...estimated({ points: 13 }), 'check-kept-whole': { exitCode: 0 } });
  assert.equal(later.end, 'ready');
  assert.ok(!later.steps.includes('split'));
});

test('ASS-252 AC3: at the gate an open blocking question sends the ticket to wait for its answer, then on round again; a non-blocking one, or a choice made at another step, leaves it waiting for the operator', () => {
  const asked = refine({ ...TOO_LARGE, ...decide({ questions: () => [{ status: 'Asked' }] }, 'Accept') });
  assert.ok(inOrder(asked.steps, ['awaiting-split-decision', 'awaiting-answers', 'groom', 'split', 'awaiting-split-decision', 'superseded']), asked.steps.join(' '));
  assert.equal(refine({ ...TOO_LARGE, ...decide({ questions: () => [{ status: 'Asked', blocking: false }] }) }).end, 'awaiting-split-decision');
  assert.equal(refine({ ...TOO_LARGE, 'awaiting-split-decision': { humanReview: 'Approved' } }).end, 'awaiting-split-decision');
});

test('ASS-252 AC2: the new prompts\' outputs are what the exits read', () => {
  const estimate = prompt('estimate-with-split');
  for (const field of ['points', 'too-large', 'summary']) assert.ok(estimate.output.required.includes(field), field);
  assert.equal(estimate.output.properties['too-large'].type, 'boolean');
  for (const points of [1, 2, 3, 5, 8, 13, null]) assert.ok(estimate.output.properties.points.enum.includes(points), String(points));
  assert.ok(prompt('split-ticket').output.required.includes('summary'));
  const text = readFileSync(join(ROOT, 'prompts', 'split-ticket', 'prompt.txt'), 'utf8');
  assert.match(text, /\{agent-sh\} ticket:propose-split \{project\} \{ticket\} -/);
  assert.match(text, /question:ask \{project\} \{ticket\} <--blocking\|--non-blocking>/);
  assert.doesNotMatch(text, /ticket:create/);   // Accept creates the tickets, not the agent
});
