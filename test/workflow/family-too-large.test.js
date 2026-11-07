// ASS-264: the family's backlog refinement on an estimate above its scale.
// family's story-point scale is 1, 2, 3, 5 (off-board points the same), but
// the shared estimate prompt may answer 8 or 13: those went back to Groom,
// re-groomed and re-estimated with no bound. Now an 8 or a 13 is noted on the
// ticket (ticket:note-too-large, at Note the Estimate) and rests at Too Large
// for the operator, as example's Awaiting Approval does: Accept takes it to
// Ready with no points, Return (with a note) sends it to Groom, the note
// reaching the groomer as the variation's rejection-reason. Estimate's
// catch-all back to Groom stays, bounded: past Estimate's max-visits the
// ticket goes to Too Large instead; the operator's choice there restarts the
// count. The harness's own refinement (software-assassin's) already sends 8
// and 13 to Split (ASS-252) and is not changed; nor are the shared estimate
// prompt and the flat engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState, isHumanStep, isDoneStep } from '../../src/control/engine.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { engineDir, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
const e = engine('family-backlog-refinement');
const accepted = { questions: () => [{ status: 'Answer Accepted' }] };
const next = (id, facts, changes) => nextState(stepOf(e, id), e, { ...accepted, ...facts }, changes);
const to = (id, facts, changes) => next(id, facts, changes)?.to;
const estimated = (output, changes) => next('estimate', { turnComplete: true, structuredOutput: output }, changes);
const decided = decision => ({ humanReview: { state: 'too-large', decision } });

// walk(moves) — a family ticket's history: each [from, to] a change, as ticket:change-state appends it.
const walk = moves => moves.map(([from, toState], i) => ({ 'state-engine': 'family-backlog-refinement', 'from-state': from, 'to-state': toState, timestamp: `2026-10-30T10:${String(i).padStart(2, '0')}:00Z` }));
// One pass from Groom to Estimate, and one back to Groom from Estimate's catch-all.
const toEstimate = [['groom', 'check-answers'], ['check-answers', 'find-dependencies'], ['find-dependencies', 'estimate']];
const regroomed = [...toEstimate, ['estimate', 'groom']];
const upTo = [['groom', 'check-answers'], ['check-answers', 'find-dependencies']];

test('ASS-264 AC1: family\'s refinement has Note the Estimate and Too Large between Estimate and Ready, and validates', () => {
  // ASS-265: Too Large's Split, its own steps between Too Large and Ready, Superseded last (family-split.test.js).
  assert.deepEqual(e.steps.toSorted((a, b) => a.sequence - b.sequence).map(s => s.id), [
    'groom', 'awaiting-answers', 'check-answers', 'find-dependencies', 'estimate', 'note-estimate-8', 'note-estimate-13', 'too-large',
    'split', 'check-split-proposal', 'awaiting-split-decision', 'create-split-tickets', 'ready', 'superseded',
  ]);
  assert.deepEqual(validateStateEngine(e, ROOT, 'family-backlog-refinement', EXAMPLE_ENGINES), []);
  assert.ok(isHumanStep(e, 'too-large'));
  assert.equal(stepOf(e, 'too-large').name, 'Too Large');
  assert.ok(isDoneStep(e, 'ready'));
});

test('ASS-264 AC1: an estimate of 8 or 13 is noted and goes to Too Large, never back to Groom; 1, 2, 3, 5 or none to Ready as before', () => {
  assert.equal(stepOf(e, 'estimate').action.prompt, 'estimate');                       // the shared prompt, unchanged
  for (const points of [1, 2, 3, 5, null]) assert.equal(estimated({ points, summary: 's' }).to, 'ready', String(points));
  for (const points of [8, 13]) {
    const step = `note-estimate-${points}`;
    assert.equal(estimated({ points, summary: 's' }).to, step, String(points));
    assert.deepEqual([stepOf(e, step).action.type, stepOf(e, step).action.command], ['script', `./agent.sh ticket:note-too-large {project} {ticket} ${points}`]);
    assert.equal(to(step, { exitCode: 0 }), 'too-large');
    assert.equal(to(step, { exitCode: 1 }), 'too-large');                              // a failed note still leaves it to the operator
  }
  assert.equal(next('estimate', { turnComplete: false, structuredOutput: { points: 8 } }), null);
});

test('ASS-264 AC2: Too Large rests for the operator: Accept goes to Ready, Return asks for a note and goes to Groom; a question not accepted sends it to Groom', () => {
  const gate = stepOf(e, 'too-large');
  assert.deepEqual(gate['exit-events'].filter(x => x.condition['human-review']).map(x => [x.condition['human-review'], x['move-to-state'], x['asks-for-reason'] === true]), [
    ['Accept', 'ready', false], ['Return', 'groom', true], ['Split', 'split', false],   // ASS-265: Split, family-split.test.js
  ]);
  assert.equal(to('too-large', {}), undefined);                                         // rests for the operator
  assert.equal(to('too-large', decided('Accept')), 'ready');
  assert.equal(to('too-large', decided('Return')), 'groom');
  assert.equal(to('too-large', { humanReview: { state: 'estimate', decision: 'Accept' } }), undefined);   // a choice made at another step
  assert.equal(to('too-large', { questions: () => [{ status: 'Answered' }] }), 'groom');
  // Modelled on example's Awaiting Approval: the same Accept, and a Reject that asks why, to Groom — and, ASS-265, Split besides.
  const example = stepOf(engine('example-backlog-refinement'), 'awaiting-approval');
  assert.deepEqual(example['exit-events'].map(x => [x['move-to-state'], x['asks-for-reason'] === true]), gate['exit-events'].filter(x => x.condition['human-review'] !== 'Split').map(x => [x['move-to-state'], x['asks-for-reason'] === true]));
});

test('ASS-264 AC3: Estimate\'s catch-all goes back to Groom until Estimate\'s max-visits; past them the ticket goes to Too Large instead', () => {
  const step = stepOf(e, 'estimate');
  assert.deepEqual([step['max-visits'], step['on-max-visits']], [3, 'too-large']);
  for (const output of [{}, { points: 4 }, undefined]) assert.equal(estimated(output).to, 'groom', JSON.stringify(output));
  const after = (...passes) => next('find-dependencies', { turnComplete: true }, walk([...passes.flat(), ...upTo]));
  // Estimated once, twice: Find Dependencies goes on to Estimate.
  assert.equal(after(regroomed).to, 'estimate');
  assert.equal(after(regroomed, regroomed).to, 'estimate');
  // Three times: no fourth estimate, nor groom after it, but Too Large, for max-visits.
  assert.deepEqual([after(regroomed, regroomed, regroomed).to, after(regroomed, regroomed, regroomed).reason], ['too-large', 'max-visits']);
  // A ticket reopened from Ready counts from there (engine.js sinceResolution).
  assert.equal(after(regroomed, regroomed, toEstimate, [['estimate', 'ready'], ['ready', 'groom']], regroomed, regroomed).to, 'estimate');
});

test('ASS-264 AC2, AC3: the operator\'s choice at Too Large restarts the count, so a Returned ticket is estimated again, up to max-visits more times', () => {
  assert.equal(stepOf(e, 'too-large')['restarts-visit-count'], true);
  const returned = [...regroomed, ...regroomed, ...regroomed, ...upTo, ['find-dependencies', 'too-large'], ['too-large', 'groom']];
  const after = (...passes) => to('find-dependencies', { turnComplete: true }, walk([...returned, ...passes.flat(), ...upTo]));
  assert.equal(after(), 'estimate');
  assert.equal(after(regroomed, regroomed), 'estimate');
  assert.equal(after(regroomed, regroomed, regroomed), 'too-large');
});

test('ASS-264 AC5: a family ticket walked through 8, Return, 13 and Accept ends at Ready, never grooming but at the operator\'s word', () => {
  const steps = [];
  let changes = [];
  const move = (from, facts) => { const target = to(from, facts, changes); changes = [...changes, ...walk([[from, target]])]; steps.push(target); return target; };
  move('groom', { turnComplete: true, structuredOutput: { 'is-ready': true } });
  move('check-answers', { exitCode: 0 });
  move('find-dependencies', { turnComplete: true });
  move('estimate', { turnComplete: true, structuredOutput: { points: 8, summary: 's' } });
  move('note-estimate-8', { exitCode: 0 });
  move('too-large', decided('Return'));
  move('groom', { turnComplete: true, structuredOutput: { 'is-ready': true } });
  move('check-answers', { exitCode: 0 });
  move('find-dependencies', { turnComplete: true });
  move('estimate', { turnComplete: true, structuredOutput: { points: 13, summary: 's' } });
  move('note-estimate-13', { exitCode: 0 });
  move('too-large', decided('Accept'));
  assert.deepEqual(steps, ['check-answers', 'find-dependencies', 'estimate', 'note-estimate-8', 'too-large', 'groom',
    'check-answers', 'find-dependencies', 'estimate', 'note-estimate-13', 'too-large', 'ready']);
});

// software-assassin runs harness-development-v2, whose refinement is harness-backlog-refinement: Split takes 8 and 13 (ASS-252).
test('ASS-264 AC4: software-assassin\'s refinement sends 8 and 13 towards Split, as before; it has no Too Large', () => {
  const v2 = engine('harness-development-v2'), harness = engine('harness-backlog-refinement');
  assert.equal(v2['backlog-refinement-steps'][0].action.engine, 'harness-backlog-refinement');
  for (const points of [8, 13]) assert.equal(nextState(stepOf(harness, 'estimate'), harness, { turnComplete: true, structuredOutput: { points, 'too-large': false, summary: 's' } })?.to, 'check-kept-whole', String(points));
  assert.equal(stepOf(harness, 'too-large'), undefined);
  assert.equal(stepOf(harness, 'estimate')['max-visits'], undefined);
});
