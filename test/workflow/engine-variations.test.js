// ASS-258: what each variation of the engines does, walked through the real
// engines as control reads them (test/support/engine-walk.js): where a ticket
// ends up and the steps it must pass on the way, so rewording a step or adding
// one leaves these passing. Covered elsewhere and not repeated here: the
// harness's refinement with Split (backlog-split.test.js, and through tick in
// test/control/tick-refine.test.js, example's Check the Points and Awaiting
// Approval among it), the grouped engines' paths (grouped-development.test.js),
// harness-development-v2's (v2-development.test.js) and the flat and grouped
// Blocked (blocked.test.js, grouped-blocked.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepOf, isDoneStep, isHumanStep } from '../../src/control/engine.js';
import { loadEngines, walk, inOrder } from '../support/engine-walk.js';

const engines = loadEngines();
// on(name, answers) — answers keyed by "<step>" of engine `name`, as walk() keys them.
const on = (name, answers) => Object.fromEntries(Object.entries(answers).map(([id, v]) => [`${name}/${id}`, v]));
// What a list of "<engine>/<step>" runs: any step's action naming `text` (a prompt, command or engine).
const runs = (trail, text) => trail.some(p => { const [name, id] = p.split('/'); return JSON.stringify(stepOf(engines[name], id).action).includes(text); });

// Backlog refinement without Split: example's and the example GitHub project's. ASS-265: the example GitHub project's splits only at the
// operator's word — Split at Too Large (example-github-split.test.js) — so never on its way there.
const NO_SPLIT = ['split-ticket', 'ticket:propose-split', 'ticket:apply-split', 'ticket:keep-whole', 'ticket:kept-whole', 'estimate-with-split'];
const REFINED_BY = { 'example-development': 'example-backlog-refinement', 'example-development-grouped': 'example-backlog-refinement', 'example-github-development': 'example-github-backlog-refinement' };
const SPLIT_AT_OPERATOR = { 'example-github-backlog-refinement': ['split', 'check-split-proposal', 'awaiting-split-decision', 'create-split-tickets', 'superseded'] };

test('example\'s and the example GitHub project\'s engines refine with their own refinement engines, which never split a ticket of their own accord', () => {
  for (const [top, refinement] of Object.entries(REFINED_BY)) {
    assert.ok(engines[top]['backlog-refinement-steps'].some(s => s.action.engine === refinement), top);
    const all = engines[refinement].steps.filter(s => !(SPLIT_AT_OPERATOR[refinement] ?? []).includes(s.id)).map(s => `${refinement}/${s.id}`);
    for (const text of NO_SPLIT) assert.ok(!runs(all, text), `${refinement} runs ${text}`);
  }
  for (const text of ['ticket:keep-whole', 'ticket:kept-whole', 'estimate-with-split'])
    assert.ok(!runs(engines['example-github-backlog-refinement'].steps.map(s => `example-github-backlog-refinement/${s.id}`), text), text);
});

test('example\'s refinement: groomed ready and estimated — however large, 13 points too — it waits for the operator, who accepts it to Ready or rejects it to be groomed again; a ticket with points is not estimated', () => {
  const R = 'example-backlog-refinement';
  const refine = answers => walk(engines, R, { answers: on(R, { groom: { structuredOutput: { 'is-ready': true } }, 'check-points': { exitCode: 1 }, ...answers }) });
  for (const points of [1, 2, 3, 5, 8, 13, null]) {
    const r = refine({ estimate: { structuredOutput: { points, summary: 's' } } });
    assert.ok(r.rests && isHumanStep(engines[R], r.end), `${points}: rests at ${r.end}`);
    assert.ok(runs(r.trail, 'prompt":"estimate"'), `${points}: estimated`);
  }
  const gate = refine({ estimate: { structuredOutput: { points: 13, summary: 's' } } }).end;
  const accepted = refine({ estimate: { structuredOutput: { points: 13, summary: 's' } }, [gate]: [{ humanReview: 'Accept' }, {}] });
  assert.deepEqual([accepted.end, accepted.rests], ['ready', false]);
  assert.ok(isDoneStep(engines[R], accepted.end));
  const rejected = refine({ estimate: { structuredOutput: { points: 3, summary: 's' } }, [gate]: [{ humanReview: 'Reject' }, { humanReview: 'Accept' }, {}] });
  assert.equal(rejected.end, 'ready');
  assert.ok(inOrder(rejected.trail, [`${R}/${gate}`, `${R}/groom`, `${R}/${gate}`, `${R}/ready`]), rejected.trail.join(' '));
  const pointed = refine({ 'check-points': { exitCode: 0 }, [gate]: [{ humanReview: 'Accept' }, {}] });
  assert.equal(pointed.end, 'ready');
  assert.ok(!runs(pointed.trail, 'prompt":"estimate"'), 'a ticket with points is not estimated');
});

test('the example GitHub project\'s refinement: groomed ready, its dependencies found and estimated on its scale (1, 2, 3, 5 or none), it goes straight to Ready — no operator, no Split', () => {
  const R = 'example-github-backlog-refinement';
  for (const points of [1, 2, 3, 5, null]) {
    const r = walk(engines, R, { answers: on(R, { groom: { structuredOutput: { 'is-ready': true } }, estimate: { structuredOutput: { points, summary: 's' } } }) });
    assert.deepEqual([r.end, r.rests], ['ready', false], String(points));
    assert.ok(!r.trail.some(p => isHumanStep(engines[R], p.split('/')[1])), `${points}: no human step on the way`);
    assert.ok(runs(r.trail, 'find-dependencies') && runs(r.trail, 'prompt":"estimate"'), r.trail.join(' '));
  }
  // Not groomed ready: it waits for the answers, then is groomed again.
  const asked = walk(engines, R, { answers: on(R, { groom: [{ structuredOutput: { 'is-ready': false } }, { structuredOutput: { 'is-ready': true } }], estimate: { structuredOutput: { points: 2, summary: 's' } } }) });
  assert.equal(asked.end, 'ready');
  assert.ok(inOrder(asked.trail, [`${R}/groom`, `${R}/awaiting-answers`, `${R}/groom`, `${R}/ready`]), asked.trail.join(' '));
});

// ASS-264: above the example GitHub project's scale, 8 or 13, the estimate is noted and the ticket rests at Too Large for the
// operator: Accept to Ready, Return to be groomed again; an estimate that never matches is bounded there too.
test('the example GitHub project\'s refinement: estimated 8 or 13, it is noted and waits for the operator, who accepts it to Ready or returns it to be groomed again; Estimate is bounded', () => {
  const R = 'example-github-backlog-refinement';
  const refine = answers => walk(engines, R, { answers: on(R, { groom: { structuredOutput: { 'is-ready': true } }, ...answers }) });
  for (const points of [8, 13]) {
    const r = refine({ estimate: { structuredOutput: { points, summary: 's' } } });
    assert.deepEqual([r.end, r.rests], ['too-large', true], String(points));
    assert.ok(runs(r.trail, `ticket:note-too-large {project} {ticket} ${points}`), r.trail.join(' '));
    assert.ok(!r.trail.slice(r.trail.indexOf(`${R}/estimate`)).includes(`${R}/groom`), `${points}: never back to Groom`);
    const accepted = refine({ estimate: { structuredOutput: { points, summary: 's' } }, 'too-large': [{ humanReview: 'Accept' }, {}] });
    assert.deepEqual([accepted.end, accepted.rests], ['ready', false]);
  }
  const returned = refine({ estimate: [{ structuredOutput: { points: 13, summary: 's' } }, { structuredOutput: { points: 3, summary: 's' } }], 'too-large': [{ humanReview: 'Return' }, {}] });
  assert.equal(returned.end, 'ready');
  assert.ok(inOrder(returned.trail, [`${R}/too-large`, `${R}/groom`, `${R}/estimate`, `${R}/ready`]), returned.trail.join(' '));
  // An estimate no exit but the catch-all takes: groomed again, until Estimate's max-visits sends it to Too Large.
  const unmatched = refine({ estimate: { structuredOutput: {} } });
  assert.deepEqual([unmatched.end, unmatched.rests], ['too-large', true]);
  assert.equal(unmatched.trail.filter(p => p === `${R}/estimate`).length, stepOf(engines[R], 'estimate')['max-visits']);
});

// The development engines' main paths: from Backlog to Done, every check passing and every review approving.
const BUILT = ['enrich-ac', 'root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'review-plan', 'generate-automated-tests', 'generate-solution', 'automated-testing', 'code-review', 'security-review', 'local-testing', 'update-documentation', 'risk-assessment', 'variation-selection'];
const reachesDone = (name, r) => {
  assert.deepEqual([r.end, r.rests], ['done', false], `${name}: ${r.trail.slice(-5).join(' ')}`);
  assert.ok(isDoneStep(engines[name], r.end));
  assert.ok(!r.trail.some(p => /\/blocked(-for-human)?$/.test(p)), `${name}: blocked on the way`);
};

test('the flat harness-development: Backlog to Done — planned, built, tested, documented and reviewed, then its own pull request merged and the harness restarted onto it', () => {
  const name = 'harness-development', r = walk(engines, name, { from: 'backlog' });
  reachesDone(name, r);
  assert.ok(inOrder(r.trail, ['backlog', 'committed', ...BUILT, 'done'].map(id => `${name}/${id}`)), r.trail.join(' '));
  const tail = r.trail.slice(r.trail.indexOf(`${name}/variation-selection`));
  for (const command of ['merge-request:merge', 'code:update-workspace', 'harness:request-restart', 'harness:restarted']) assert.ok(runs(tail, command), command);
  assert.ok(r.trail.some(p => p.startsWith(`${stepOf(engines[name], 'local-testing').action.engine}/`)), 'Local Testing runs its sub-engine');
});

test('the flat example-development: Backlog to Done — the same build, then out of draft, the team\'s review (its feedback addressed) and QA until the ticket system says Done', () => {
  const name = 'example-development';
  const r = walk(engines, name, { from: 'backlog', answers: on(name, {
    'team-code-review': [{ scriptOutput: { 'needs-attention': true } }, { ticketSystemStatus: 'In Testing' }],
    'qa-testing': { ticketSystemStatus: 'Done' } }) });
  reachesDone(name, r);
  assert.ok(inOrder(r.trail, ['backlog', 'committed', ...BUILT, 'take-out-of-draft-mode', 'team-code-review', 'address-merge-request-feedback', 'team-code-review', 'qa-testing', 'done'].map(id => `${name}/${id}`)), r.trail.join(' '));
  assert.ok(!runs(r.trail, 'merge-request:merge '), 'example merges through its team, not by itself');
  const waiting = walk(engines, name, { from: 'backlog', answers: on(name, { 'team-code-review': { ticketSystemStatus: 'In Testing' } }) });
  assert.deepEqual([waiting.end, waiting.rests], ['qa-testing', true], 'QA waits for the ticket system');
});

test('the flat engines send a rejected review back to be rebuilt and still reach Done', () => {
  for (const name of ['harness-development', 'example-development']) {
    const r = walk(engines, name, { from: 'backlog', answers: on(name, {
      'code-review': [{ structuredOutput: { 'is-approved': false } }, {}],
      'team-code-review': { ticketSystemStatus: 'In Testing' }, 'qa-testing': { ticketSystemStatus: 'Done' } }) });
    reachesDone(name, r);
    assert.ok(inOrder(r.trail, ['code-review', 'generate-solution', 'automated-testing', 'code-review', 'security-review'].map(id => `${name}/${id}`)), name);
  }
});

test('example-github-development: Backlog to Done through every group — its Release merging the example GitHub project\'s pull request and ending there, no harness update or restart', () => {
  const name = 'example-github-development';
  const r = walk(engines, name, { from: 'backlog', answers: { 'v2-local-testing/await-golden-build': { exitCode: 4 } } });
  reachesDone(name, r);
  assert.ok(inOrder(r.trail, ['backlog', 'committed', 'setup', 'plan', 'build', 'test', 'document', 'review', 'release', 'done'].map(id => `${name}/${id}`)), r.trail.join(' '));
  const release = r.trail.filter(p => p.startsWith(`${stepOf(engines[name], 'release').action.engine}/`));
  assert.ok(runs(release, 'merge-request:merge'), release.join(' '));
  for (const command of ['code:update-workspace', 'harness:request-restart']) assert.ok(!runs(r.trail, command), command);
});
