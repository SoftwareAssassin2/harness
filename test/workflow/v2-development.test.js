// The restructure, step R1 (ASS-110): harness-development-v2, a top-level
// harness engine laid out as the high-level groups only — Setup, Plan, Build,
// Test, Document, Review, Release — each a stub sub-engine of its own
// (v2-<group>) that passes straight through. Steps are added back one at a
// time from here; harness-development-grouped and its grouped-* sub-engines
// stay the reference (test/workflow/grouped-development.test.js), and
// example is untouched. Walked with control's own reading of an engine, as
// there. ASS-111 fills Setup from grouped-setup one step at a time: ADDED
// lists each group's steps put back so far, ahead of its Pass Through, and
// ENDS the done steps they brought after its Blocked; a group in FILLED has
// every step back, no Pass Through, and is its grouped-* engine exactly.
// ASS-112 fills Plan from grouped-plan the same way, two steps at a time;
// ASS-113 fills Build the same way, a pair per test run; ASS-114 fills Test
// the same way, a sub-flow per test run, its sub-engines v2-* copies too: a
// filled group with sub-engines is its grouped-* engine but for their names;
// ASS-115 fills Document the same way, a pair per test run; ASS-116 fills
// Review the same way, a pair per test run; ASS-117 fills Release the same
// way, a pair per test run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState, visitsInto } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { working, sameShared, inOrder, engineDir, engineNames, EXAMPLE_ENGINES } from '../support/engine-walk.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { humanGate } from '../../src/tui/ticket.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engines = Object.fromEntries(engineNames().filter(d => existsSync(join(engineDir(d), 'state-engine.json')))
  .map(d => [d, JSON.parse(readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8'))]));
// v2-build is grouped-build as it was before ASS-249 added CI Checks to the
// grouped one alone (v2 engines unchanged): grouped-build without that step,
// Automated Testing's exit 0 to Code Review again, the sequences closed up;
// nor its Await Sequential Merge (ASS-335, grouped-build's
// alone too): Generate Solution's finished turn to the refresh again; nor its
// Check Numbered Files (ASS-385, grouped-build's alone): the refresh straight on to Automated Testing.
const groupedBuild = (() => {
  const g = structuredClone(engines['grouped-build']);
  for (const [id, to] of [['ci-checks', 'code-review'], ['await-dependencies', 'refresh-before-testing'], ['check-numbered-files', 'automated-testing']]) {
    const at = g.steps.find(s => s.id === id).sequence;
    g.steps = g.steps.filter(s => s.id !== id).map(s => ({ ...s, ...(s.sequence > at ? { sequence: s.sequence - 1 } : {}) }));
    for (const s of g.steps) for (const e of s['exit-events'] ?? []) if (e['move-to-state'] === id) e['move-to-state'] = to;
  }
  return g;
})();
const TOP = 'harness-development-v2';
const GROUPS = ['setup', 'plan', 'build', 'test', 'document', 'review', 'release'];
const EXCEPTIONS = ['blocked-for-human', 'blocked', 'self-healing', 'requirements-changed'];   // requirements-changed: ASS-79's detour
const ids = name => engines[name].steps.map(s => s.id);
// ASS-258: a v2 step and its grouped reference compared by what they do (working: their wording and order aside), an
// engine and its reference by the steps they share (sameShared), a list of steps by their order, others between them
// allowed — so either may be reworded or gain a step without breaking these.
const same = (step, reference, message) => assert.deepEqual(working(step), working(reference), message);
const hasInOrder = (actual, expected, message = '') => assert.ok(inOrder(actual, expected), `${message}: ${actual.join(' ')} has not ${expected.join(' ')} in order`);
const ADDED = {};
const ENDS = {};
const FILLED = ['setup', 'plan', 'build', 'test', 'document', 'review', 'release'];
// switchedOn(step) — the step without its is-active (ASS-192): v2-review's Human Review is switched off, otherwise grouped-review's.
const switchedOn = ({ 'is-active': _, ...step }) => step;
// toHumanReview(step) — grouped-review's step read as it was before ASS-314 took its Human Review
// out: Risk Assessment going on to Human Review, which is what v2-review's still does. v2-review
// keeps the gate (harness, software-assassin); grouped-review (case-law) has none, so the engines
// differ in that one exit alone and the rest of grouped-review stays v2-review's reference.
const toHumanReview = step => (step?.id !== 'risk-assessment' ? step
  : { ...step, 'exit-events': step['exit-events'].map(e => (e['move-to-state'] === 'token-expense-check' ? { ...e, 'move-to-state': 'human-review' } : e)) });
// beforeQueue(engine) — the engine as it was before ASS-197 put the merge queue into v2-release (Merge Pull Request in its
// turn, rebased and fully re-tested; red to Back to Build, `rebuild`): grouped-release-harness's Merge Pull Request, no Rebuild, and Release's
// exit to Build gone. The grouped engines stay the reference; the queue is v2's alone (harness only, the operator's decision).
const beforeQueue = engine => ({ ...engine, steps: engine.steps.filter(s => !(s.id === 'rebuild' && engine === engines['v2-release']))
  .map(s => (s.id === 'merge-pull-request' && engine === engines['v2-release'] ? stepOf(engines['grouped-release-harness'], s.id)
    : s.id === 'release' && engine === engines[TOP] ? { ...s, 'exit-events': s['exit-events'].filter(e => e['move-to-state'] !== 'build') } : s)) });
// An engine with its v2-* sub-engines named as their grouped-* references (switchedOn).
const asGrouped = engine => ({ ...engine, steps: engine.steps.map(switchedOn).map(s => s.action.type === 'state-engine' ? { ...s, action: { ...s.action, engine: s.action.engine.replace(/^v2-/, 'grouped-') } } : s) });
// ASS-317: v2's Test re-runs on an unfinished verdict (did-not-finish), the grouped engines' not — a step read without that
// re-run exit (withoutReRun), and v2-local-testing's Test without the visit cap its self-loop needs too (withoutTestReRun).
const reRuns = exit => JSON.stringify(exit.condition).includes('"did-not-finish":true');
const withoutReRun = step => (step['exit-events'] ? { ...step, 'exit-events': step['exit-events'].filter(e => !reRuns(e)) } : step);
const withoutTestReRun = step => { if (step.id !== 'test') return step; const { 'max-visits': _, 'on-max-visits': __, ...rest } = withoutReRun(step); return rest; };
// The step's exit into `to`.
const exitTo = (step, to) => step['exit-events'].find(e => e['move-to-state'] === to);

test('AC1: harness-development-v2 is the exception states, Backlog, Committed, the seven groups in order and Done, each group a sub-engine of its own — the steps added back so far (ASS-111), then Pass Through straight to done, or once filled its grouped-* engine exactly; validate.js accepts them all', () => {
  hasInOrder(ids(TOP), [...EXCEPTIONS, 'backlog', 'committed', ...GROUPS, 'done']);
  for (const group of GROUPS) {
    const action = stepOf(engines[TOP], group).action;
    assert.deepEqual(action, { type: 'state-engine', engine: `v2-${group}` }, group);
    // Filled, it is the engine harness-development-grouped's group step runs (Release's grouped-release-harness).
    // Build's is grouped-build as it was before ASS-249's CI Checks (groupedBuild).
    if (FILLED.includes(group)) { const grouped = stepOf(engines['harness-development-grouped'], group).action.engine; sameShared(asGrouped(beforeQueue(engines[action.engine])), grouped === 'grouped-build' ? groupedBuild : engines[grouped], { message: group, as: withoutReRun, asReference: toHumanReview }); continue; }
    const stub = engines[action.engine], through = stepOf(stub, 'pass-through');
    hasInOrder(ids(action.engine), [...(ADDED[group] ?? []), 'pass-through', 'done', 'blocked', ...(ENDS[group] ?? [])], group);
    assert.deepEqual(stub.steps.map(s => s.sequence), stub.steps.map((_, i) => i + 1), group);
    assert.deepEqual([through.action, through['exit-events']], [{ type: 'none' }, [{ condition: { always: true }, 'move-to-state': 'done' }]], group);
    assert.equal(stepOf(stub, 'done')['is-done'], true, group);
  }
  for (const name of [TOP, ...GROUPS.map(g => `v2-${g}`)]) assert.deepEqual(validateStateEngine(engines[name], ROOT, name, EXAMPLE_ENGINES), [], name);
});

test('AC1: the exception states, Backlog, Committed, Done and the engine-wide settings are harness-development-grouped\'s — Blocked runs grouped-blocked — and Blocked hands a ticket back to the start of the group it came from', () => {
  const grouped = engines['harness-development-grouped'];
  for (const id of [...EXCEPTIONS, 'backlog', 'committed', 'done']) same(stepOf(engines[TOP], id), stepOf(grouped, id), id);
  assert.equal(stepOf(engines[TOP], 'blocked').action.engine, 'grouped-blocked');
  // check-health-steps runs check-health-v2 (ASS-149), not grouped's check-health; otherwise the same.
  const v2Health = steps => steps.map(s => s.action.engine === 'check-health-v2' ? { ...s, action: { ...s.action, engine: 'check-health' } } : s);
  const asWorking = value => (Array.isArray(value) ? value.map(working) : value);
  for (const key of Object.keys(grouped).filter(k => k !== 'steps')) assert.deepEqual(asWorking(key === 'check-health-steps' ? v2Health(engines[TOP][key]) : engines[TOP][key]), asWorking(grouped[key]), key);
  for (const group of GROUPS) {
    const step = stepOf(engines[TOP], group);
    assert.equal(step['return-to-state'], group, group);
    assert.deepEqual(step['exit-events'][0], { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked' }] }, 'move-to-state': 'blocked' }, group);
  }
});

// walk(top) — a ticket walked from committed with control's nextState, every
// fact the passing one (as walk() in grouped-development.test.js): a
// state-engine step runs its sub-engine's run to a done step first — from
// the step the exit into it named (start-sub-engine-at), else its first —
// and its exits read which one, and what the run returned merged as control
// merges it (moveRun); `given` overrides any of the facts. Returns the trail
// of "<engine>/<step>".
function walk(top, given = {}) {
  const trail = [];
  // exitCode, structuredOutput and humanReview may be functions of the step: what it gives there. A human approves at every
  // human step unless told otherwise; the output says the change spends no tokens unless it says it does (ASS-116).
  // Await the Golden Build's exit is goldenReady's, vm:golden-ready's: 4, no golden rebuild, unless given (ASS-157).
  const facts = { turnComplete: true, exitCode: 0, scriptOutput: { status: 'passed' }, agentNeedsWork: true, fileUpdated: () => true, scriptSucceeds: () => true, structuredOutput: { 'is-approved': true }, humanReview: at => ({ state: at, decision: 'Approved' }), variation: { 'acceptance-criteria': [{ 'criteria-number': 1, description: 'it works' }] }, ...given };
  const exitAt = at => {
    const f = { ...facts, ...Object.fromEntries(['exitCode', 'structuredOutput', 'humanReview'].filter(k => typeof facts[k] === 'function').map(k => [k, facts[k](at)])) };
    return { ...f, ...(at === 'await-golden-build' && { exitCode: facts.goldenReady ?? 4 }), structuredOutput: { 'will-spend-tokens': false, ...f.structuredOutput } };
  };
  const run = (name, start) => {
    const engine = engines[name], changes = [];
    let output = {};
    for (let at = start, startAt, i = 0; i < 100; i++) {
      trail.push(`${name}/${at}`);
      const step = stepOf(engine, at);
      if (step['is-done'] || ['blocked', 'blocked-for-human'].includes(at) && name === top) return { end: at, output };
      // A sub-engine's run first: a fact given as a function is asked of the step once its run is over.
      const child = step.action.type === 'state-engine' && run(step.action.engine, startAt ?? firstStepId(engines[step.action.engine]));
      const f = child ? { ...exitAt(at), subEngineDone: true, subEngineState: child.end, structuredOutput: { ...output, ...child.output } } : exitAt(at);
      if (['prompt', 'state-engine'].includes(step.action.type)) output = { ...output, ...f.structuredOutput };
      const next = nextState(step, engine, f, changes);
      assert.ok(next?.to, `${name}/${at}: no exit`);
      changes.push({ 'from-state': at, 'to-state': next.to });
      startAt = next.reason === 'exit' ? next.exit['start-sub-engine-at'] : undefined;
      at = next.to;
    }
    throw new Error(`${name} ran away: ${trail.slice(-10).join(' ')}`);
  };
  run(top, 'committed');
  return trail;
}

// The steps v2-plan's run visits before its done, every fact the passing one (ASS-112).
const PLAN = ['enrich-ac', 'root-cause-analysis', 'review-root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan'];
// The steps v2-build's run visits before its done, every fact the passing one (ASS-113).
const BUILD = ['refresh-repositories', 'generate-automated-tests', 'generate-solution', 'refresh-before-testing', 'automated-testing', 'code-review', 'security-review'];
// The steps v2-test's run visits before its done, every fact the passing one, its sub-engines' runs nested (ASS-114).
const TEST = ['local-testing', 'v2-local-testing/await-golden-build', 'v2-local-testing/test', 'v2-local-testing/take-screenshots', 'v2-local-testing/done', 'steps-to-test', 'v2-steps-to-test/write-steps-to-test', 'v2-steps-to-test/done'];
// The steps v2-document's run visits before its done, every fact the passing one (ASS-115).
const DOCUMENT = ['update-documentation', 'update-merge-request-details', 'check-merge-request-details', 'add-screenshots-to-merge-request'];
// The steps v2-review's run visits before its done, every fact the passing one (ASS-116): no tokens spent, so no Payment Gate; one variation, so Variation Selection passes on its own.
const REVIEW = ['explain-the-change', 'risk-assessment', 'human-review', 'token-expense-check', 'variation-selection'];
// The steps v2-release's run visits before its done, every fact the passing one (ASS-117).
const RELEASE = ['merge-pull-request', 'update-workspace', 'request-restart', 'await-restart'];
// The trail of a walk from Committed to Done, `setup`, `plan`, `build`, `test`, `document`, `review` and `release` the steps v2-setup's, v2-plan's, v2-build's, v2-test's, v2-document's, v2-review's and v2-release's runs visit before their done.
const trailThrough = (setup, plan = PLAN, build = BUILD, tested = TEST, document = DOCUMENT, review = REVIEW, release = RELEASE) => ['committed', ...GROUPS.flatMap(g => [g, ...({ setup, plan, build, test: tested, document, review, release }[g] ?? ['pass-through']).map(s => s.includes('/') ? s : `v2-${g}:${s}`), `v2-${g}:done`]), 'done']
  .map(p => p.includes(':') ? p.replace(':', '/') : p.includes('/') ? p : `${TOP}/${p}`);

test('AC2: a ticket goes from Committed to Done through every group in order, each group\'s run reaching its done — a set-up VM (ASS-111) leaving Setup at Check Setup Complete', () => {
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-111 AC1: v2-setup\'s first step is grouped-setup\'s Check Setup Complete — its action, condition scripts, planning flag and exits, "not complete" going to Create VM', () => {
  const step = stepOf(engines['v2-setup'], 'check-setup-complete'), reference = stepOf(engines['grouped-setup'], 'check-setup-complete');
  assert.equal(firstStepId(engines['v2-setup']), 'check-setup-complete');
  same(step, { ...reference, sequence: step.sequence });
  assert.equal(step['exit-events'][1]['move-to-state'], 'create-vm');
  assert.equal(step['exit-events'][0].condition['script-succeeds'], './agent.sh vm:setup-complete {project} {ticket} {variation}');
  assert.deepEqual(validateStateEngine(engines['v2-setup'], ROOT, 'v2-setup', EXAMPLE_ENGINES), []);
});

test('ASS-111 AC2: Check Setup Complete — vm:setup-complete succeeding (the VM set up already) goes to done; failing (no VM, not running, no marker) goes on to Create VM', () => {
  const engine = engines['v2-setup'], step = stepOf(engine, 'check-setup-complete'), asked = [];
  const facts = ok => ({ scriptSucceeds: command => { asked.push(command); return ok; } });
  assert.equal(nextState(step, engine, facts(true)).to, 'done');
  assert.equal(nextState(step, engine, facts(false)).to, 'create-vm');
  assert.ok(asked.every(c => c === './agent.sh vm:setup-complete {project} {ticket} {variation}'), asked.join(' | '));
});

// vm:setup-complete failing; every other script (Build's test checks) passing.
const NOT_SET_UP = { scriptSucceeds: command => !command.includes('vm:setup-complete') };

test('ASS-111 AC1 (step 2): Create VM is grouped-setup\'s — its vm:create script, recorded output, planning flag, max-visits 3 then Blocked, and exits, 0 going to Mark Setup Complete; v2-setup gains grouped-setup\'s Blocked for Human, and the Setup group step its exit to the top level\'s', () => {
  const step = stepOf(engines['v2-setup'], 'create-vm'), reference = stepOf(engines['grouped-setup'], 'create-vm');
  same(step, reference);
  assert.equal(step['exit-events'][0]['move-to-state'], 'mark-setup-complete');
  assert.equal(step.action.command, './agent.sh vm:create {project} {ticket} {variation}');
  assert.deepEqual([step['max-visits'], step['on-max-visits'], step['record-script-output']], [3, 'blocked', true]);
  same(stepOf(engines['v2-setup'], 'blocked-for-human'), stepOf(engines['grouped-setup'], 'blocked-for-human'));
  assert.deepEqual(stepOf(engines[TOP], 'setup')['exit-events'], stepOf(engines['harness-development-grouped'], 'setup')['exit-events']);
  assert.deepEqual(validateStateEngine(engines['v2-setup'], ROOT, 'v2-setup', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

const SETUP = [`${TOP}/setup`, 'v2-setup/check-setup-complete'];

test('ASS-111 AC2 (step 2): Create VM — exit 0 goes on to Mark Setup Complete; exit 3 (no room within the disk limit) ends Setup at Blocked for Human and the ticket at the top level\'s; any other exit tries again, and its third failure ends Setup at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-setup'], step = stepOf(engine, 'create-vm');
  assert.equal(nextState(step, engine, { exitCode: 0 }).to, 'mark-setup-complete');
  assert.equal(nextState(step, engine, { exitCode: 3 }).to, 'blocked-for-human');
  assert.deepEqual(nextState(step, engine, { exitCode: 1 }, [{ 'from-state': 'check-setup-complete', 'to-state': 'create-vm' }]), { to: 'create-vm', exit: step['exit-events'][2], reason: 'exit' });
  const thrice = ['check-setup-complete', 'create-vm', 'create-vm'].map(from => ({ 'from-state': from, 'to-state': 'create-vm' }));
  assert.deepEqual(nextState(step, engine, { exitCode: 1 }, thrice), { to: 'blocked', exit: step['exit-events'][2], reason: 'max-visits' });
  assert.deepEqual(walk(TOP, { ...NOT_SET_UP, exitCode: 3 }).slice(-5), [...SETUP, 'v2-setup/create-vm', 'v2-setup/blocked-for-human', `${TOP}/blocked-for-human`]);
  assert.deepEqual(walk(TOP, { ...NOT_SET_UP, exitCode: 1 }).slice(-7), [...SETUP, 'v2-setup/create-vm', 'v2-setup/create-vm', 'v2-setup/create-vm', 'v2-setup/blocked', `${TOP}/blocked`]);
});

test('ASS-111 AC1 (step 3): Mark Setup Complete is grouped-setup\'s — its vm:mark-setup-complete script, planning flag, max-visits 3 then Blocked, and exits — and, Setup\'s last step, Pass Through is gone: v2-setup is grouped-setup exactly, which validate.js accepts', () => {
  const step = stepOf(engines['v2-setup'], 'mark-setup-complete');
  same(step, stepOf(engines['grouped-setup'], 'mark-setup-complete'));
  assert.equal(step.action.command, './agent.sh vm:mark-setup-complete {project} {ticket} {variation}');
  assert.deepEqual([step['max-visits'], step['on-max-visits']], [3, 'blocked']);
  hasInOrder(ids('v2-setup'), ['check-setup-complete', 'create-vm', 'mark-setup-complete', 'done', 'blocked', 'blocked-for-human']);
  sameShared(engines['v2-setup'], engines['grouped-setup']);
  assert.deepEqual(validateStateEngine(engines['v2-setup'], ROOT, 'v2-setup', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-111 AC2 (step 3): Mark Setup Complete — exit 0 goes to done; any other exit tries again, and its third failure ends Setup at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-setup'], step = stepOf(engine, 'mark-setup-complete');
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, { exitCode: 1 }, [{ 'from-state': 'create-vm', 'to-state': 'mark-setup-complete' }]), { to: 'mark-setup-complete', exit: step['exit-events'][1], reason: 'exit' });
  const thrice = ['create-vm', 'mark-setup-complete', 'mark-setup-complete'].map(from => ({ 'from-state': from, 'to-state': 'mark-setup-complete' }));
  assert.deepEqual(nextState(step, engine, { exitCode: 1 }, thrice), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  const markFails = at => at === 'mark-setup-complete' ? 1 : 0;
  assert.deepEqual(walk(TOP, { ...NOT_SET_UP, exitCode: markFails }).slice(-8), [...SETUP, 'v2-setup/create-vm', 'v2-setup/mark-setup-complete', 'v2-setup/mark-setup-complete', 'v2-setup/mark-setup-complete', 'v2-setup/blocked', `${TOP}/blocked`]);
});

test('ASS-111 AC4: the whole Setup group, no gates, ends at the right done step for each of its exits — set up already: done at once; not: Create VM, Mark Setup Complete, done; no room within the disk limit: Blocked for Human; repeated failures: Blocked — and the Setup group step takes each on (Plan, Blocked for Human, Blocked)', () => {
  const ended = given => { const trail = walk(TOP, given), at = trail.indexOf(`${TOP}/setup`); return trail.slice(at, trail.indexOf(trail.find((p, i) => i > at && p.startsWith(`${TOP}/`))) + 1); };
  assert.deepEqual(ended({}), [...SETUP, 'v2-setup/done', `${TOP}/plan`]);
  assert.deepEqual(ended(NOT_SET_UP), [...SETUP, 'v2-setup/create-vm', 'v2-setup/mark-setup-complete', 'v2-setup/done', `${TOP}/plan`]);
  assert.deepEqual(ended({ ...NOT_SET_UP, exitCode: 3 }), [...SETUP, 'v2-setup/create-vm', 'v2-setup/blocked-for-human', `${TOP}/blocked-for-human`]);
  assert.deepEqual(ended({ ...NOT_SET_UP, exitCode: 1 }), [...SETUP, ...Array(3).fill('v2-setup/create-vm'), 'v2-setup/blocked', `${TOP}/blocked`]);
  assert.deepEqual(ended({ ...NOT_SET_UP, exitCode: at => at === 'mark-setup-complete' ? 1 : 0 }), [...SETUP, 'v2-setup/create-vm', ...Array(3).fill('v2-setup/mark-setup-complete'), 'v2-setup/blocked', `${TOP}/blocked`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
  assert.deepEqual(walk(TOP, NOT_SET_UP), trailThrough(['check-setup-complete', 'create-vm', 'mark-setup-complete']));
});

const PLANNING = [`${TOP}/plan`, 'v2-plan/enrich-ac'];

test('ASS-112 AC1 (pair 1): v2-plan\'s first steps are grouped-plan\'s Extract Acceptance Criteria and Root Cause Analysis — prompts, max-visits 3 then Blocked, run in the VM, planning flag and exits — Root Cause Analysis\'s finished analysis going to Review Root Cause Analysis since pair 2 (so the step is grouped-plan\'s exactly); the Plan group step needs no new exit (its own is grouped\'s); validate.js accepts them', () => {
  const engine = engines['v2-plan'], reference = id => stepOf(engines['grouped-plan'], id);
  assert.equal(firstStepId(engine), 'enrich-ac');
  same(stepOf(engine, 'enrich-ac'), reference('enrich-ac'));
  same(stepOf(engine, 'root-cause-analysis'), reference('root-cause-analysis'));
  for (const [id, prompt] of [['enrich-ac', 'enrich-ac-grouped'], ['root-cause-analysis', 'root-cause-analysis-grouped']]) {   // ASS-182: its own copy, recording on stdin
    const step = stepOf(engine, id);
    assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location']], ['prompt', prompt, 3, 'blocked', 'vm'], id);
    assert.ok(existsSync(join(ROOT, 'prompts', prompt, 'prompt.txt')), prompt);
  }
  assert.deepEqual(stepOf(engines[TOP], 'plan')['exit-events'], stepOf(engines['harness-development-grouped'], 'plan')['exit-events']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-plan', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-112 AC2 (pair 1): Extract Acceptance Criteria — its turn done with at least one criterion on the variation goes to Root Cause Analysis; none (or the turn not done) matches no exit, so the step runs again; entering Root Cause Analysis a fourth time goes to Blocked instead', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'enrich-ac');
  const criteria = list => ({ turnComplete: true, variation: { 'acceptance-criteria': list } });
  assert.deepEqual(nextState(step, engine, criteria([{ 'criteria-number': 1, description: 'x' }])), { to: 'root-cause-analysis', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, criteria([])), null);
  assert.equal(nextState(step, engine, { turnComplete: true, variation: {} }), null);
  assert.equal(nextState(step, engine, { ...criteria([{ 'criteria-number': 1, description: 'x' }]), turnComplete: false }), null);
  const thrice = ['enrich-ac', 'root-cause-analysis', 'root-cause-analysis'].map(from => ({ 'from-state': from, 'to-state': 'root-cause-analysis' }));
  assert.deepEqual(nextState(step, engine, criteria([{ 'criteria-number': 1, description: 'x' }]), thrice), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' });
});

test('ASS-112 AC2 (pair 1): Root Cause Analysis — root-cause-analysis.md written this turn goes on to Review Root Cause Analysis (pair 2); not written tries again, and its third failure ends Plan at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'root-cause-analysis'), asked = [];
  const facts = ok => ({ turnComplete: true, fileUpdated: (file, since) => { asked.push(`${file} ${since}`); return ok; } });
  assert.deepEqual(nextState(step, engine, facts(true)), { to: 'review-root-cause-analysis', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(false), [{ 'from-state': 'enrich-ac', 'to-state': 'root-cause-analysis' }]), { to: 'root-cause-analysis', exit: step['exit-events'][1], reason: 'exit' });
  const thrice = ['enrich-ac', 'root-cause-analysis', 'root-cause-analysis'].map(from => ({ 'from-state': from, 'to-state': 'root-cause-analysis' }));
  assert.deepEqual(nextState(step, engine, facts(false), thrice), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  assert.ok(asked.length && asked.every(a => a === 'root-cause-analysis.md turn-start'), asked.join(' | '));
  assert.deepEqual(walk(TOP, { fileUpdated: () => false }).slice(-7), [...PLANNING, ...Array(3).fill('v2-plan/root-cause-analysis'), 'v2-plan/blocked', `${TOP}/blocked`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete'], PLAN));
});

const thrice = (to, from) => from.map(f => ({ 'from-state': f, 'to-state': to }));

test('ASS-112 AC1 (pair 2): v2-plan\'s next steps are grouped-plan\'s Review Root Cause Analysis and Write Execution Plan, field for field — prompts, max-visits 3 then Blocked, run in the VM, planning flag and exits — Write Execution Plan\'s written plan going to Write Test Plan since pair 3 (so the step is grouped-plan\'s exactly); validate.js accepts them', () => {
  const engine = engines['v2-plan'], reference = id => stepOf(engines['grouped-plan'], id);
  same(stepOf(engine, 'review-root-cause-analysis'), reference('review-root-cause-analysis'));
  same(stepOf(engine, 'write-execution-plan'), reference('write-execution-plan'));
  // ASS-228: Review Root Cause Analysis runs its grouped copy, which reads the operator's Human Review notes.
  for (const [id, prompt] of [['review-root-cause-analysis', 'review-root-cause-analysis-grouped'], ['write-execution-plan', 'write-execution-plan-grouped']]) {
    const step = stepOf(engine, id);
    assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location']], ['prompt', prompt, 3, 'blocked', 'vm'], id);
    assert.ok(existsSync(join(ROOT, 'prompts', prompt, 'prompt.txt')), prompt);
  }
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-plan', EXAMPLE_ENGINES), []);
});

test('ASS-112 AC2 (pair 2): Review Root Cause Analysis — approved goes to Write Execution Plan; not approved back to Root Cause Analysis; no verdict (or the turn not done) matches no exit; always rejected, Root Cause Analysis\'s fourth entry ends Plan at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'review-root-cause-analysis');
  const verdict = approved => ({ turnComplete: true, structuredOutput: { 'is-approved': approved } });
  assert.deepEqual(nextState(step, engine, verdict(true)), { to: 'write-execution-plan', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, verdict(false)), { to: 'root-cause-analysis', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: true, structuredOutput: {} }), null);
  assert.equal(nextState(step, engine, { ...verdict(true), turnComplete: false }), null);
  assert.deepEqual(nextState(step, engine, verdict(false), thrice('root-cause-analysis', ['enrich-ac', 'review-root-cause-analysis', 'review-root-cause-analysis'])), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  assert.deepEqual(nextState(step, engine, verdict(true), thrice('write-execution-plan', ['review-root-cause-analysis', 'write-execution-plan', 'write-execution-plan'])), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' });
  const rejected = walk(TOP, { structuredOutput: { 'is-approved': false } });
  assert.deepEqual(rejected.slice(-10), [...PLANNING, ...Array(3).fill(['root-cause-analysis', 'review-root-cause-analysis']).flat().map(s => `v2-plan/${s}`), 'v2-plan/blocked', `${TOP}/blocked`]);
});

test('ASS-112 AC2 (pair 2): Write Execution Plan — execution-plan.md written this turn goes on to Write Test Plan (pair 3); not written tries again, and its third failure ends Plan at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'write-execution-plan'), asked = [];
  const facts = ok => ({ turnComplete: true, fileUpdated: (file, since) => { asked.push(`${file} ${since}`); return ok; } });
  assert.deepEqual(nextState(step, engine, facts(true)), { to: 'write-test-plan', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(false), thrice('write-execution-plan', ['review-root-cause-analysis'])), { to: 'write-execution-plan', exit: step['exit-events'][1], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(false), thrice('write-execution-plan', ['review-root-cause-analysis', 'write-execution-plan', 'write-execution-plan'])), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  assert.ok(asked.length && asked.every(a => a === 'execution-plan.md turn-start'), asked.join(' | '));
  const unwritten = walk(TOP, { fileUpdated: file => file !== 'execution-plan.md' });
  assert.deepEqual(unwritten.slice(-5), [...Array(3).fill('v2-plan/write-execution-plan'), 'v2-plan/blocked', `${TOP}/blocked`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete'], PLAN));
});

test('ASS-112 AC1 (pair 3): v2-plan\'s next steps are grouped-plan\'s Write Test Plan and Enrich Automated Test Data, field for field — prompts, max-visits 3 then Blocked, run in the VM, planning flag and exits — Enrich Automated Test Data\'s finished turn going to Review Plan since step 7 (so the step is grouped-plan\'s exactly); validate.js accepts them', () => {
  const engine = engines['v2-plan'], reference = id => stepOf(engines['grouped-plan'], id);
  same(stepOf(engine, 'write-test-plan'), reference('write-test-plan'));
  same(stepOf(engine, 'enrich-automated-test-data'), reference('enrich-automated-test-data'));
  assert.deepEqual(stepOf(engine, 'enrich-automated-test-data')['exit-events'].map(e => e['move-to-state']), ['review-plan']);
  for (const [id, prompt] of [['write-test-plan', 'write-test-plan-grouped'], ['enrich-automated-test-data', 'enrich-automated-test-data-grouped']]) {
    const step = stepOf(engine, id);
    assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location'], step['is-planning-stage']], ['prompt', prompt, 3, 'blocked', 'vm', true], id);
    assert.ok(existsSync(join(ROOT, 'prompts', prompt, 'prompt.txt')), prompt);
  }
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-plan', EXAMPLE_ENGINES), []);
});

test('ASS-112 AC2 (pair 3): Write Test Plan — test-plan.md written this turn goes on to Enrich Automated Test Data; not written tries again, and its third failure ends Plan at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'write-test-plan'), asked = [];
  const facts = ok => ({ turnComplete: true, fileUpdated: (file, since) => { asked.push(`${file} ${since}`); return ok; } });
  assert.deepEqual(nextState(step, engine, facts(true)), { to: 'enrich-automated-test-data', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(false), thrice('write-test-plan', ['write-execution-plan'])), { to: 'write-test-plan', exit: step['exit-events'][1], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(false), thrice('write-test-plan', ['write-execution-plan', 'write-test-plan', 'write-test-plan'])), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  assert.equal(nextState(step, engine, { ...facts(true), turnComplete: false }), null);
  assert.ok(asked.length && asked.every(a => a === 'test-plan.md turn-start'), asked.join(' | '));
  const unwritten = walk(TOP, { fileUpdated: file => file !== 'test-plan.md' });
  assert.deepEqual(unwritten.slice(-5), [...Array(3).fill('v2-plan/write-test-plan'), 'v2-plan/blocked', `${TOP}/blocked`]);
});

test('ASS-112 AC2 (pair 3): Enrich Automated Test Data — its turn done goes on to Review Plan (step 7), whatever it wrote; the turn not done matches no exit; entering it a fourth time goes to Blocked instead; the whole Plan group, every fact the passing one, visits all seven steps', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'enrich-automated-test-data');
  assert.deepEqual(nextState(step, engine, { turnComplete: true, fileUpdated: () => false }), { to: 'review-plan', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: false }), null);
  const into = stepOf(engine, 'write-test-plan'), written = { turnComplete: true, fileUpdated: () => true };
  assert.deepEqual(nextState(into, engine, written, thrice('enrich-automated-test-data', ['write-test-plan', 'write-test-plan', 'write-test-plan'])), { to: 'blocked', exit: into['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete'], PLAN));
});

test('ASS-112 AC1 (step 7): Review Plan is grouped-plan\'s — the review-plan-grouped prompt (ASS-231), max-visits 3 then Blocked, run in the VM, planning flag and exits — and, Plan\'s last step, Pass Through is gone: v2-plan is grouped-plan exactly, which validate.js accepts', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'review-plan');
  same(step, stepOf(engines['grouped-plan'], 'review-plan'));
  assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location'], step['is-planning-stage']], ['prompt', 'review-plan-grouped', 3, 'blocked', 'vm', true]);   // ASS-231: its own copy
  assert.ok(existsSync(join(ROOT, 'prompts', 'review-plan-grouped', 'prompt.txt')));
  hasInOrder(ids('v2-plan'), [...PLAN, 'done', 'blocked']);
  sameShared(engine, engines['grouped-plan']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-plan', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

// Review Plan's verdict `approved`, every other step's approved.
const planReview = approved => at => ({ 'is-approved': at === 'review-plan' ? approved : true });

test('ASS-112 AC2 (step 7): Review Plan — approved goes to done; not approved back to Write Execution Plan; no verdict (or the turn not done) matches no exit; always rejected, Write Execution Plan\'s fourth entry ends Plan at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-plan'], step = stepOf(engine, 'review-plan');
  const verdict = approved => ({ turnComplete: true, structuredOutput: { 'is-approved': approved } });
  assert.deepEqual(nextState(step, engine, verdict(true)), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, verdict(false)), { to: 'write-execution-plan', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: true, structuredOutput: {} }), null);
  assert.equal(nextState(step, engine, { ...verdict(true), turnComplete: false }), null);
  assert.deepEqual(nextState(step, engine, verdict(false), thrice('write-execution-plan', ['review-root-cause-analysis', 'review-plan', 'review-plan'])), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  const into = stepOf(engine, 'enrich-automated-test-data');
  assert.deepEqual(nextState(into, engine, { turnComplete: true }, thrice('review-plan', Array(3).fill('enrich-automated-test-data'))), { to: 'blocked', exit: into['exit-events'][0], reason: 'max-visits' });
  const loop = ['write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan'].map(s => `v2-plan/${s}`);
  assert.deepEqual(walk(TOP, { structuredOutput: planReview(false) }).slice(-11), ['v2-plan/review-plan', ...loop, ...loop.slice(0, -1), 'v2-plan/review-plan', 'v2-plan/blocked', `${TOP}/blocked`]);
});

test('ASS-112 AC4: the whole Plan group, no gates, ends at the right done step for each of its exits — all approved: every step once, then done and Build; Root Cause Analysis rejected once then approved: back to it, then on to done; the plan rejected once: back to Write Execution Plan, then done; repeated failures (an unwritten file, a plan always rejected): Blocked, and the ticket at the top level\'s Blocked', () => {
  const ended = given => { const trail = walk(TOP, given), at = trail.indexOf(`${TOP}/plan`); return trail.slice(at, trail.indexOf(trail.find((p, i) => i > at && p.startsWith(`${TOP}/`))) + 1); };
  const plan = steps => [`${TOP}/plan`, ...steps.map(s => `v2-plan/${s}`)];
  // A verdict that is `false` the first time the step gives one, then true.
  const onceRejected = id => { let seen = 0; return at => ({ 'is-approved': at !== id || seen++ > 0 }); };
  const [eac, rca, rrca, wep, wtp, eatd, rp] = PLAN;
  assert.deepEqual(ended({}), plan([...PLAN, 'done']).concat(`${TOP}/build`));
  assert.deepEqual(ended({ structuredOutput: onceRejected(rrca) }), plan([eac, rca, rrca, rca, rrca, wep, wtp, eatd, rp, 'done']).concat(`${TOP}/build`));
  assert.deepEqual(ended({ structuredOutput: onceRejected(rp) }), plan([...PLAN, wep, wtp, eatd, rp, 'done']).concat(`${TOP}/build`));
  assert.deepEqual(ended({ structuredOutput: planReview(false) }), plan([...PLAN, wep, wtp, eatd, rp, wep, wtp, eatd, rp, 'blocked']).concat(`${TOP}/blocked`));
  assert.deepEqual(ended({ structuredOutput: at => ({ 'is-approved': at !== rrca }) }), plan([eac, ...Array(3).fill([rca, rrca]).flat(), 'blocked']).concat(`${TOP}/blocked`));
  assert.deepEqual(ended({ fileUpdated: file => file !== 'test-plan.md' }), plan([eac, rca, rrca, wep, wtp, wtp, wtp, 'blocked']).concat(`${TOP}/blocked`));
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

const BUILDING = [`${TOP}/build`, 'v2-build/refresh-repositories', 'v2-build/generate-automated-tests'];
const VERIFY = './agent.sh automated-tests:verify-exist-and-runnable {project} {ticket} {variation}';

test('ASS-113 AC1 (pair 1): v2-build\'s first steps are grouped-build\'s Generate Automated Tests and Generate Solution, field for field — prompts, max-visits 3 and 5 then Blocked, run in the VM, exits — Generate Solution\'s finished turn going to Automated Testing since pair 2 (so the step is grouped-build\'s exactly); the Build group step needs no new exit (its own is grouped\'s); validate.js accepts them', () => {
  const engine = engines['v2-build'], reference = id => stepOf(groupedBuild, id);
  assert.equal(firstStepId(engine), 'refresh-repositories');
  same(stepOf(engine, 'generate-automated-tests'), reference('generate-automated-tests'));
  same(stepOf(engine, 'generate-solution'), reference('generate-solution'));
  for (const [id, prompt, visits] of [['generate-automated-tests', 'generate-automated-tests-grouped', 3], ['generate-solution', 'generate-solution-grouped', 5]]) {
    const step = stepOf(engine, id);
    assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location']], ['prompt', prompt, visits, 'blocked', 'vm'], id);
    assert.ok(existsSync(join(ROOT, 'prompts', prompt, 'prompt.txt')), prompt);
  }
  assert.deepEqual(stepOf(engines[TOP], 'build')['exit-events'], stepOf(engines['harness-development-grouped'], 'build')['exit-events']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-build', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-113 AC2 (pair 1): Generate Automated Tests — its turn done with the tests recorded and listable (automated-tests:verify-exist-and-runnable) goes to Generate Solution; not, tries again, and its third failure ends Build at Blocked and the ticket at the top level\'s Blocked; the turn not done matches no exit', () => {
  const engine = engines['v2-build'], step = stepOf(engine, 'generate-automated-tests'), asked = [];
  const facts = ok => ({ turnComplete: true, scriptSucceeds: command => { asked.push(command); return ok; } });
  assert.deepEqual(nextState(step, engine, facts(true)), { to: 'generate-solution', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(false), thrice('generate-automated-tests', ['generate-automated-tests'])), { to: 'generate-automated-tests', exit: step['exit-events'][1], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(false), thrice('generate-automated-tests', ['review-plan', 'generate-automated-tests', 'generate-automated-tests'])), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  assert.equal(nextState(step, engine, { ...facts(true), turnComplete: false }), null);
  assert.ok(asked.length && asked.every(c => c === VERIFY), asked.join(' | '));
  const unlisted = walk(TOP, { scriptSucceeds: command => command !== VERIFY });
  assert.deepEqual(unlisted.slice(-7), [`${TOP}/build`, 'v2-build/refresh-repositories', ...Array(3).fill('v2-build/generate-automated-tests'), 'v2-build/blocked', `${TOP}/blocked`]);
});

test('ASS-113 AC2 (pair 1): Generate Solution — its turn done goes on to Automated Testing (pair 2), whatever it built; the turn not done matches no exit; entering it a sixth time goes to Blocked instead', () => {
  const engine = engines['v2-build'], step = stepOf(engine, 'generate-solution');
  assert.deepEqual(nextState(step, engine, { turnComplete: true }), { to: 'refresh-before-testing', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: false }), null);
  const into = stepOf(engine, 'generate-automated-tests'), listed = { turnComplete: true, scriptSucceeds: () => true };
  const five = Array(5).fill({ 'from-state': 'generate-automated-tests', 'to-state': 'generate-solution' });
  assert.deepEqual(nextState(into, engine, listed, five), { to: 'blocked', exit: into['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(nextState(into, engine, listed, five.slice(1)), { to: 'generate-solution', exit: into['exit-events'][0], reason: 'exit' });
  const trail = walk(TOP);
  assert.deepEqual(trail.slice(trail.indexOf(`${TOP}/build`), trail.indexOf(`${TOP}/test`) + 1), [...BUILDING, 'v2-build/generate-solution', 'v2-build/refresh-before-testing', 'v2-build/automated-testing', 'v2-build/code-review', 'v2-build/security-review', 'v2-build/done', `${TOP}/test`]);
  assert.deepEqual(trail, trailThrough(['check-setup-complete']));
});

const RUN_TESTS = './agent.sh automated-tests:verify-success {project} {ticket} {variation}';
// The Build part of a walk: from the Build group step to the top-level step after it.
const built = given => { const trail = walk(TOP, given), at = trail.indexOf(`${TOP}/build`); return trail.slice(at, trail.indexOf(trail.find((p, i) => i > at && p.startsWith(`${TOP}/`))) + 1); };
const build = steps => [`${TOP}/build`, ...steps.map(s => `v2-build/${s}`)];

test('ASS-113 AC1 (pair 2): v2-build\'s next steps are grouped-build\'s Automated Testing and Code Review, field for field — the automated-tests:verify-success script and the code-review-grouped prompt, max-visits 3 then Blocked, run in the VM, exits — Code Review\'s approval going to Security Review since step 5 (so the step is grouped-build\'s exactly); validate.js accepts them', () => {
  const engine = engines['v2-build'], reference = id => stepOf(groupedBuild, id);
  same(stepOf(engine, 'automated-testing'), reference('automated-testing'));
  const review = stepOf(engine, 'code-review');
  same(review, reference('code-review'));
  const testing = stepOf(engine, 'automated-testing');
  assert.deepEqual([testing.action.type, testing.action.command, testing['max-visits'], testing['on-max-visits'], testing['run-location']], ['script', RUN_TESTS, 3, 'blocked', 'vm']);
  assert.deepEqual([review.action.type, review.action.prompt, review['max-visits'], review['on-max-visits'], review['run-location']], ['prompt', 'code-review-grouped', 3, 'blocked', 'vm']);
  assert.ok(existsSync(join(ROOT, 'prompts', 'code-review-grouped', 'prompt.txt')));
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-build', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-113 AC2 (pair 2): Automated Testing — exit 0 (every test passes, or fails only as on master) goes to Code Review; exit 3 (could not run, or red on master with nothing to compare) ends Build at Blocked and the ticket at the top level\'s Blocked; any other exit (a new failure) goes back to Generate Solution; entering it a fourth time goes to Blocked instead', () => {
  const engine = engines['v2-build'], step = stepOf(engine, 'automated-testing');
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }), { to: 'code-review', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, { exitCode: 3 }), { to: 'blocked', exit: step['exit-events'][1], reason: 'exit' });
  for (const exitCode of [1, 2, 127]) assert.deepEqual(nextState(step, engine, { exitCode }), { to: 'generate-solution', exit: step['exit-events'][3], reason: 'exit' }, String(exitCode));
  const into = stepOf(engine, 'refresh-before-testing');
  assert.deepEqual(nextState(into, engine, { exitCode: 0 }, thrice('automated-testing', ['refresh-before-testing', 'refresh-before-testing', 'refresh-before-testing'])), { to: 'blocked', exit: into['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(built({ exitCode: at => (at === 'automated-testing' ? 3 : 0) }), build(['refresh-repositories', 'generate-automated-tests', 'generate-solution', 'refresh-before-testing', 'automated-testing', 'blocked']).concat(`${TOP}/blocked`));
  const red = at => at === 'automated-testing' ? 1 : 0;
  assert.deepEqual(built({ exitCode: red }), build(['refresh-repositories', 'generate-automated-tests', ...Array(3).fill(['generate-solution', 'refresh-before-testing', 'automated-testing']).flat(), 'generate-solution', 'refresh-before-testing', 'blocked']).concat(`${TOP}/blocked`));
  // Red once, then green: back to Generate Solution, then on.
  let runs = 0;
  assert.deepEqual(built({ exitCode: at => at === 'automated-testing' && runs++ === 0 ? 1 : 0 }), build(['refresh-repositories', 'generate-automated-tests', 'generate-solution', 'refresh-before-testing', 'automated-testing', 'generate-solution', 'refresh-before-testing', 'automated-testing', 'code-review', 'security-review', 'done']).concat(`${TOP}/test`));
});

// ASS-162: a lost automated-tests-<variation>.json (an outage mid-step) goes back to the step that writes it, not round Generate Solution until Blocked.
test('ASS-162: Automated Testing — exit 4 (the automated-tests list is missing) goes back to Generate Automated Tests; a file with failing tests (exit 1) still goes to Generate Solution, and passing on to Code Review; grouped-build\'s step is the same', () => {
  const engine = engines['v2-build'], step = stepOf(engine, 'automated-testing');
  assert.deepEqual(nextState(step, engine, { exitCode: 4 }), { to: 'generate-automated-tests', exit: step['exit-events'][2], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, { exitCode: 1 }).to, 'generate-solution');
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }).to, 'code-review');
  same(stepOf(groupedBuild, 'automated-testing'), step);
  // Missing once, then written again: back to Generate Automated Tests, then on.
  let runs = 0;
  assert.deepEqual(built({ exitCode: at => at === 'automated-testing' && runs++ === 0 ? 4 : 0 }), build(['refresh-repositories', 'generate-automated-tests', 'generate-solution', 'refresh-before-testing', 'automated-testing', 'generate-automated-tests', 'generate-solution', 'refresh-before-testing', 'automated-testing', 'code-review', 'security-review', 'done']).concat(`${TOP}/test`));
});

test('ASS-113 AC2 (pair 2): Code Review — approved goes on to Security Review (step 5); not approved back to Generate Solution; no verdict (or the turn not done) matches no exit; always rejected, the fourth entry into Automated Testing (its max-visits 3, reached before Code Review\'s) ends Build at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-build'], step = stepOf(engine, 'code-review');
  const verdict = approved => ({ turnComplete: true, structuredOutput: { 'is-approved': approved } });
  assert.deepEqual(nextState(step, engine, verdict(true)), { to: 'security-review', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, verdict(false)), { to: 'generate-solution', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: true, structuredOutput: {} }), null);
  assert.equal(nextState(step, engine, { ...verdict(true), turnComplete: false }), null);
  const into = stepOf(engine, 'automated-testing');
  assert.deepEqual(nextState(into, engine, { exitCode: 0 }, thrice('code-review', ['automated-testing', 'automated-testing', 'automated-testing'])), { to: 'blocked', exit: into['exit-events'][0], reason: 'max-visits' });
  const loop = ['generate-solution', 'refresh-before-testing', 'automated-testing', 'code-review'];
  assert.deepEqual(built({ structuredOutput: at => ({ 'is-approved': at !== 'code-review' }) }), build(['refresh-repositories', 'generate-automated-tests', ...loop, ...loop, ...loop, 'generate-solution', 'refresh-before-testing', 'blocked']).concat(`${TOP}/blocked`));
  let reviews = 0;
  assert.deepEqual(built({ structuredOutput: at => ({ 'is-approved': at !== 'code-review' || reviews++ > 0 }) }), build(['refresh-repositories', 'generate-automated-tests', ...loop, ...loop, 'security-review', 'done']).concat(`${TOP}/test`));
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-113 AC1 (step 5): v2-build\'s last step is grouped-build\'s Security Review, field for field — the security-review-grouped prompt, max-visits 3 then Blocked, run in the VM, exits — and, Build\'s last step, Pass Through is gone: v2-build is grouped-build exactly, which validate.js accepts', () => {
  const engine = engines['v2-build'], step = stepOf(engine, 'security-review');
  same(step, stepOf(groupedBuild, 'security-review'));
  assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location']], ['prompt', 'security-review-grouped', 3, 'blocked', 'vm']);
  assert.ok(existsSync(join(ROOT, 'prompts', 'security-review-grouped', 'prompt.txt')));
  hasInOrder(ids('v2-build'), [...BUILD, 'done', 'blocked']);
  sameShared(engine, groupedBuild);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-build', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-113 AC2 (step 5): Security Review — approved goes to done and the ticket to Test; not approved back to Generate Solution; no verdict (or the turn not done) matches no exit; always rejected, the fourth entry into Automated Testing ends Build at Blocked and the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-build'], step = stepOf(engine, 'security-review');
  const verdict = approved => ({ turnComplete: true, structuredOutput: { 'is-approved': approved } });
  assert.deepEqual(nextState(step, engine, verdict(true)), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, verdict(false)), { to: 'generate-solution', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: true, structuredOutput: {} }), null);
  assert.equal(nextState(step, engine, { ...verdict(true), turnComplete: false }), null);
  assert.deepEqual(nextState(stepOf(engine, 'code-review'), engine, verdict(true), thrice('security-review', ['code-review', 'code-review', 'code-review'])), { to: 'blocked', exit: stepOf(engine, 'code-review')['exit-events'][0], reason: 'max-visits' });
  const loop = ['generate-solution', 'refresh-before-testing', 'automated-testing', 'code-review', 'security-review'];
  assert.deepEqual(built({ structuredOutput: at => ({ 'is-approved': at !== 'security-review' }) }), build(['refresh-repositories', 'generate-automated-tests', ...loop, ...loop, ...loop, 'generate-solution', 'refresh-before-testing', 'blocked']).concat(`${TOP}/blocked`));
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-113 AC4: the whole Build group, no gates, ends at the right done step for each of its exits — all good: every step once, then done and Test; Automated Testing red then green: back to Generate Solution, then done; Code Review rejected once: back to Generate Solution, then done; Security Review rejected once: back to Generate Solution, then done; not runnable (exit 3): Blocked; repeated failures (tests never listable, tests always red, a review always rejected): Blocked, and the ticket at the top level\'s Blocked', () => {
  // A verdict that is `false` the first time the step gives one, then true.
  const onceRejected = id => { let seen = 0; return at => ({ 'is-approved': at !== id || seen++ > 0 }); };
  const [rr, gat, gs, rt, at, cr, sr] = BUILD, toTest = steps => build([...steps, 'done']).concat(`${TOP}/test`), toBlocked = steps => build([...steps, 'blocked']).concat(`${TOP}/blocked`);
  assert.deepEqual(built({}), toTest(BUILD));
  let runs = 0;
  assert.deepEqual(built({ exitCode: step => step === at && runs++ === 0 ? 1 : 0 }), toTest([rr, gat, gs, rt, at, gs, rt, at, cr, sr]));
  assert.deepEqual(built({ structuredOutput: onceRejected(cr) }), toTest([rr, gat, gs, rt, at, cr, gs, rt, at, cr, sr]));
  assert.deepEqual(built({ structuredOutput: onceRejected(sr) }), toTest([...BUILD, gs, rt, at, cr, sr]));
  assert.deepEqual(built({ exitCode: step => step === at ? 3 : 0 }), toBlocked([rr, gat, gs, rt, at]));
  assert.deepEqual(built({ scriptSucceeds: command => command !== VERIFY }), toBlocked([rr, gat, gat, gat]));
  assert.deepEqual(built({ exitCode: step => step === at ? 1 : 0 }), toBlocked([rr, gat, ...Array(3).fill([gs, rt, at]).flat(), gs, rt]));
  assert.deepEqual(built({ structuredOutput: at => ({ 'is-approved': at !== cr }) }), toBlocked([rr, gat, ...Array(3).fill([gs, rt, at, cr]).flat(), gs, rt]));
  assert.deepEqual(built({ structuredOutput: at => ({ 'is-approved': at !== sr }) }), toBlocked([rr, gat, ...Array(3).fill([gs, rt, at, cr, sr]).flat(), gs, rt]));
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

const REFRESH = './agent.sh vm:refresh-repositories {project} {ticket} {variation}';

test('ASS-218 AC1: Build starts by refreshing the VM\'s reference repositories, and refreshes them again before every Automated Testing — vm:refresh-repositories, on the host (it reaches the VM itself); exit 0 goes on, any other (no running VM) ends Build at Blocked; grouped-build is the same, and validate.js accepts them', () => {
  const engine = engines['v2-build'];
  sameShared(engine, groupedBuild);
  for (const [id, next] of [['refresh-repositories', 'generate-automated-tests'], ['refresh-before-testing', 'automated-testing']]) {
    const step = stepOf(engine, id);
    assert.deepEqual([step.action, step['run-location']], [{ type: 'script', command: REFRESH }, undefined], id);
    assert.deepEqual(nextState(step, engine, { exitCode: 0 }).to, next, id);
    assert.deepEqual(nextState(step, engine, { exitCode: 1 }).to, 'blocked', id);
  }
  assert.equal(firstStepId(engine), 'refresh-repositories');
  assert.equal(nextState(stepOf(engine, 'generate-solution'), engine, { turnComplete: true }).to, 'refresh-before-testing');
  assert.deepEqual(built({ exitCode: at => (at === 'refresh-repositories' ? 1 : 0) }), build(['refresh-repositories', 'blocked']).concat(`${TOP}/blocked`));
  assert.deepEqual(built({ exitCode: at => (at === 'refresh-before-testing' ? 1 : 0) }), build(['refresh-repositories', 'generate-automated-tests', 'generate-solution', 'refresh-before-testing', 'blocked']).concat(`${TOP}/blocked`));
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-build', EXAMPLE_ENGINES), []);
});

// The Test part of a walk: from the Test group step to the top-level step after it.
const tested = given => { const trail = walk(TOP, given), at = trail.indexOf(`${TOP}/test`); return trail.slice(at, trail.findIndex((p, i) => i > at && p.startsWith(`${TOP}/`)) + 1); };
const LOCAL = [`${TOP}/test`, 'v2-test/local-testing', 'v2-local-testing/await-golden-build', 'v2-local-testing/test'];
// The test prompt's verdict `approved`, every other step's approved.
const testVerdict = approved => at => ({ 'is-approved': at === 'test' ? approved : true });
// ASS-317: the test prompt's third verdict — the suite did not finish within
// the turn (did-not-finish), which is no rejection but a re-run. An unfinished
// run carries is-approved false too, so a verdict is given whole, the field
// false on a finished one, as the agent returns it: a run's output is merged
// visit by visit, so a field left out of a later verdict keeps the earlier
// one's true and the step would re-run for ever.
const UNFINISHED = { 'is-approved': false, 'did-not-finish': true, summary: 'npm test still running' };
const FINISHED = approved => ({ 'is-approved': approved, 'did-not-finish': false, summary: 'x' });
// The test prompt's verdicts by visit (the last repeated, as the shared walk()'s
// answers are), every other step's approved — a fresh count for each call.
const testVerdicts = (...verdicts) => { let n = 0; return at => (at === 'test' ? verdicts[Math.min(n++, verdicts.length - 1)] : { 'is-approved': true }); };
// ASS-317: a Test re-run as control records it — the variation stays in the
// top-level step, the move itself a sub-state-change, one level per engine
// below it (as nest() in test/control/engine.test.js): reRun(['v2-test',
// 'local-testing']) is the outer step's re-run, reRun(['v2-test',
// 'local-testing'], ['v2-local-testing', 'test']) the inner one's inside it.
// visitsInto counts no such change as a visit (src/control/engine.js:129).
const nested = ([[engine, step], ...rest]) => ({ 'state-engine': engine, 'from-state': step, 'to-state': step, ...(rest.length ? { 'sub-state-change': nested(rest) } : {}) });
const reRun = (...levels) => ({ 'from-state': 'test', 'to-state': 'test', 'sub-state-change': nested(levels) });

test('ASS-114 AC1 (pair 1): v2-test\'s first step is grouped-test\'s Local Testing, running v2-local-testing — grouped-local-testing field for field (Test, then Take Screenshots, then done) after ASS-157\'s Await the Golden Build, but for Test\'s prompt, test-grouped, the grouped copy of the flat engines\' test — its approval going on to Steps to Test since pair 2 (so the step is grouped-test\'s but for its sub-engine\'s name), its rejection to the Rebuild done step; the Test group step takes grouped\'s exits (Rebuild back into Build at Generate Solution) and records the run\'s verdict as local-testing; validate.js accepts them', () => {
  const engine = engines['v2-test'], ref = stepOf(engines['grouped-test'], 'local-testing');
  assert.equal(firstStepId(engine), 'local-testing');
  const local = stepOf(engine, 'local-testing');
  same(withoutReRun(local), { ...ref, action: { type: 'state-engine', engine: 'v2-local-testing' } });
  assert.deepEqual([ref.action.engine, ref['exit-events'][0]['move-to-state'], ref['exit-events'][1]['move-to-state']], ['grouped-local-testing', 'steps-to-test', 'rebuild']);
  assert.deepEqual([local['max-visits'], local['on-max-visits']], [3, 'blocked']);
  same({ ...stepOf(engine, 'rebuild'), sequence: 0 }, { ...stepOf(engines['grouped-test'], 'rebuild'), sequence: 0 });
  const sub = engines['v2-local-testing'], reference = engines['grouped-local-testing'];
  // ASS-157: v2's alone first awaits a golden rebuild's image build (Await the Golden Build), its steps after it a sequence on.
  hasInOrder(ids('v2-local-testing'), ['await-golden-build', 'test', 'take-screenshots', 'done']);
  sameShared(sub, { ...reference, steps: reference.steps.map(s => s.id === 'test' ? { ...s, action: { ...s.action, prompt: 'test-grouped' } } : s) }, { as: withoutTestReRun });
  for (const [id, prompt] of [['test', 'test-grouped'], ['take-screenshots', 'take-screenshots-grouped']]) {
    const step = stepOf(sub, id);
    assert.deepEqual([step.action.type, step.action.prompt, step['run-location']], ['prompt', prompt, 'vm'], id);
    assert.ok(existsSync(join(ROOT, 'prompts', prompt, 'prompt.txt')), prompt);
  }
  const top = stepOf(engines[TOP], 'test'), grouped = stepOf(engines['harness-development-grouped'], 'test');
  assert.deepEqual(top['exit-events'], grouped['exit-events']);
  assert.deepEqual(top['exit-events'][1], { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'rebuild' }] }, 'move-to-state': 'build', 'start-sub-engine-at': 'generate-solution' });
  assert.equal(top['record-output-as'], 'local-testing');
  same({ ...top, action: null }, { ...grouped, action: null });
  for (const name of ['v2-local-testing', 'v2-test', TOP]) assert.deepEqual(validateStateEngine(engines[name], ROOT, name, EXAMPLE_ENGINES), [], name);
});

test('ASS-157: Await the Golden Build — v2-local-testing\'s first step, a timer script (vm:golden-ready about every 10 seconds): current (2), failed (3) and no golden rebuild (4) go on to Test, the walk\'s ordinary ticket straight through; building (0) and an error match no exit, so it waits, asked again on its timer; no visit limit', () => {
  const engine = engines['v2-local-testing'], step = stepOf(engine, 'await-golden-build');
  assert.equal(firstStepId(engine), 'await-golden-build');
  assert.deepEqual(step.action, { type: 'script', command: './agent.sh vm:golden-ready {project} {work-item}', mode: 'timer', 'timer-minutes': step.action['timer-minutes'] });
  assert.ok(step.action['timer-minutes'] * 60 >= 9 && step.action['timer-minutes'] * 60 <= 11);
  for (const exitCode of [2, 3, 4]) assert.equal(nextState(step, engine, { exitCode })?.to, 'test', String(exitCode));
  for (const exitCode of [0, 1]) assert.equal(nextState(step, engine, { exitCode }), null, String(exitCode));
  assert.equal(step['max-visits'], undefined);
  for (const goldenReady of [2, 3]) assert.deepEqual(tested({ goldenReady }).slice(0, 5), [...LOCAL, 'v2-local-testing/take-screenshots'], String(goldenReady));
});

test('ASS-114 AC2 (pair 1): Test — its turn done and every criterion passed goes to Take Screenshots; any failed ends Local Testing at done with the verdict, skipping the screenshots; no verdict (or the turn not done) matches no exit', () => {
  const engine = engines['v2-local-testing'], step = stepOf(engine, 'test');
  const verdict = approved => ({ turnComplete: true, structuredOutput: { 'is-approved': approved, summary: 'x' } });
  assert.deepEqual(nextState(step, engine, verdict(true)), { to: 'take-screenshots', exit: exitTo(step, 'take-screenshots'), reason: 'exit' });
  assert.deepEqual(nextState(step, engine, verdict(false)), { to: 'done', exit: exitTo(step, 'done'), reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: true, structuredOutput: {} }), null);
  assert.equal(nextState(step, engine, { ...verdict(true), turnComplete: false }), null);
});

test('ASS-114 AC2 (pair 1): Take Screenshots — its turn done goes to done, whatever it captured (an empty list too); the turn not done matches no exit; Test\'s verdict, merged with the screenshots, carries Local Testing on to Steps to Test (pair 2), done and the ticket to Document', () => {
  const engine = engines['v2-local-testing'], step = stepOf(engine, 'take-screenshots');
  assert.deepEqual(nextState(step, engine, { turnComplete: true, structuredOutput: { screenshots: [] } }), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: false }), null);
  // take-screenshots-grouped returns screenshots alone: the run keeps Test's is-approved.
  assert.deepEqual(tested({ structuredOutput: at => (at === 'take-screenshots' ? { screenshots: [] } : { 'is-approved': true }) }), [...LOCAL, 'v2-local-testing/take-screenshots', 'v2-local-testing/done', 'v2-test/steps-to-test', 'v2-steps-to-test/write-steps-to-test', 'v2-steps-to-test/done', 'v2-test/done', `${TOP}/document`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-114 AC2 (pair 1): Local Testing — Test failing a criterion ends v2-test at Rebuild, and the Test group step sends the ticket back into Build at Generate Solution (not its first step), then through Build and Test again; only an unfinished Test re-enters Local Testing within a run (ASS-317); always failing, the Test group step\'s fourth entry ends the ticket at the top level\'s Blocked', () => {
  const engine = engines['v2-test'], step = stepOf(engine, 'local-testing');
  const ended = (approved, at = 'done') => ({ subEngineDone: true, subEngineState: at, structuredOutput: { 'is-approved': approved } });
  assert.deepEqual(nextState(step, engine, ended(true)), { to: 'steps-to-test', exit: exitTo(step, 'steps-to-test'), reason: 'exit' });
  assert.deepEqual(nextState(step, engine, ended(false)), { to: 'rebuild', exit: exitTo(step, 'rebuild'), reason: 'exit' });
  assert.equal(nextState(step, engine, { subEngineDone: false, structuredOutput: { 'is-approved': true } }), null);
  // Each Test is a new run that starts there, so the bound on rebuilds is the Test group step's own; its max-visits (3, then Blocked, as grouped's) bounds an unfinished Test's re-runs alone (ASS-317 AC2).
  const top = stepOf(engines[TOP], 'test');
  assert.deepEqual(nextState(top, engines[TOP], ended(false, 'rebuild')), { to: 'build', exit: top['exit-events'][1], reason: 'exit' });
  assert.deepEqual(nextState(top, engines[TOP], ended(true, 'blocked')).to, 'blocked');
  assert.deepEqual(nextState(top, engines[TOP], ended(true, 'done')).to, 'document');
  // Failing once, then passing: back into Build at Generate Solution, then Test from its start.
  let runs = 0;
  const once = at => ({ 'is-approved': at !== 'test' || runs++ > 0 });
  assert.deepEqual(tested({ structuredOutput: once }), [...LOCAL, 'v2-local-testing/done', 'v2-test/rebuild', `${TOP}/build`]);
  runs = 0;
  const trail = walk(TOP, { structuredOutput: once }), rebuilt = trail.indexOf('v2-test/rebuild'), passing = trailThrough(['check-setup-complete']);
  assert.deepEqual(trail.slice(rebuilt + 1, trail.lastIndexOf(`${TOP}/test`) + 1), [`${TOP}/build`, ...BUILD.slice(2).map(s => `v2-build/${s}`), 'v2-build/done', `${TOP}/test`]);
  assert.deepEqual(trail.slice(trail.lastIndexOf(`${TOP}/test`)), passing.slice(passing.indexOf(`${TOP}/test`)));
  // Always failing: Build and Test take turns until Test's fourth entry (its max-visits 3, reached before Build's 5).
  const failing = walk(TOP, { structuredOutput: testVerdict(false) });
  assert.deepEqual(failing.filter(p => p.startsWith(`${TOP}/`)).slice(-9), ['plan', 'build', 'test', 'build', 'test', 'build', 'test', 'build', 'blocked'].map(s => `${TOP}/${s}`));
  assert.equal(failing.filter(p => p === 'v2-build/generate-automated-tests').length, 1, 'a rebuild skips Generate Automated Tests');
});

test('ASS-317 AC1: Test — an unfinished verdict (did-not-finish, the suite cut short within the turn) re-runs Test, neither done nor Take Screenshots, even saying approved; a finished one (the field false or absent) goes as before; the turn not done matches no exit; the re-run is bounded — a fourth entry into Test goes to done', () => {
  const engine = engines['v2-local-testing'], step = stepOf(engine, 'test');
  const facts = output => ({ turnComplete: true, structuredOutput: output });
  assert.deepEqual(nextState(step, engine, facts(UNFINISHED)), { to: 'test', exit: exitTo(step, 'test'), reason: 'exit' });
  assert.ok(reRuns(exitTo(step, 'test')), 'the re-run exit reads did-not-finish');
  assert.equal(nextState(step, engine, facts({ ...UNFINISHED, 'is-approved': true }))?.to, 'test', 'a re-run wins over an untrustworthy approval');
  assert.equal(nextState(step, engine, facts(FINISHED(false)))?.to, 'done');
  assert.equal(nextState(step, engine, facts({ 'is-approved': false, summary: 'x' }))?.to, 'done');
  assert.equal(nextState(step, engine, facts(FINISHED(true)))?.to, 'take-screenshots');
  assert.equal(nextState(step, engine, { turnComplete: false, structuredOutput: UNFINISHED }), null);
  assert.deepEqual([step['max-visits'], step['on-max-visits']], [3, 'done']);
  assert.deepEqual(nextState(step, engine, facts(UNFINISHED), thrice('test', ['await-golden-build', 'test'])), { to: 'test', exit: exitTo(step, 'test'), reason: 'exit' });
  assert.deepEqual(nextState(step, engine, facts(UNFINISHED), thrice('test', ['await-golden-build', 'test', 'test'])), { to: 'done', exit: exitTo(step, 'test'), reason: 'max-visits' });
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-local-testing', EXAMPLE_ENGINES), []);
});

test('ASS-317 AC2: Local Testing — an unfinished run (did-not-finish) re-runs Local Testing, not Rebuild; a genuine rejection (the field false or absent) still ends v2-test at Rebuild, the only exit there; a fourth entry ends v2-test at Blocked, not Rebuild', () => {
  const engine = engines['v2-test'], step = stepOf(engine, 'local-testing');
  const ended = output => ({ subEngineDone: true, subEngineState: 'done', structuredOutput: output });
  assert.deepEqual(nextState(step, engine, ended(UNFINISHED)), { to: 'local-testing', exit: exitTo(step, 'local-testing'), reason: 'exit' });
  assert.equal(nextState(step, engine, ended(FINISHED(false)))?.to, 'rebuild');
  assert.equal(nextState(step, engine, ended({ 'is-approved': false }))?.to, 'rebuild');
  assert.equal(nextState(step, engine, ended(FINISHED(true)))?.to, 'steps-to-test');
  assert.equal(nextState(step, engine, { subEngineDone: false, structuredOutput: UNFINISHED }), null);
  const into = to => engine.steps.flatMap(s => s['exit-events'] ?? []).filter(e => e['move-to-state'] === to);
  assert.equal(into('local-testing').length, 1);
  assert.ok(reRuns(into('local-testing')[0]), 'the one exit into Local Testing reads did-not-finish');
  assert.equal(into('rebuild').length, 1);
  assert.ok(!JSON.stringify(into('rebuild')[0].condition).includes('did-not-finish'), 'Rebuild is the genuine rejection alone');
  assert.ok(JSON.stringify(into('rebuild')[0].condition).includes('"is-approved":false'));
  assert.deepEqual([step['max-visits'], step['on-max-visits']], [3, 'blocked']);
  assert.deepEqual(nextState(step, engine, ended(UNFINISHED), thrice('local-testing', Array(3).fill('local-testing'))), { to: 'blocked', exit: exitTo(step, 'local-testing'), reason: 'max-visits' });
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-test', EXAMPLE_ENGINES), []);
});

test('ASS-317 AC3: an unfinished Test verdict neither enters Build nor spends a harness-development-v2 Test visit — its re-runs are sub-state-changes visitsInto leaves out, so Build\'s done still goes to Test after two real Test visits; once unfinished then passing: Test re-run, then on to Document; always unfinished: bounded (3 × 3 runs), Blocked, never Build or Rebuild; unfinished then genuinely rejected: Rebuild and Build, as before', () => {
  const real = [{ 'from-state': 'plan', 'to-state': 'build' }, { 'from-state': 'build', 'to-state': 'test' }, { 'from-state': 'test', 'to-state': 'build' }, { 'from-state': 'build', 'to-state': 'test' }];
  const withReRuns = [...real.slice(0, 2), reRun(['v2-test', 'local-testing'], ['v2-local-testing', 'test']), reRun(['v2-test', 'local-testing']), ...real.slice(2), reRun(['v2-test', 'local-testing'], ['v2-local-testing', 'test']), reRun(['v2-test', 'local-testing'], ['v2-local-testing', 'test']), reRun(['v2-test', 'local-testing'])];
  assert.equal(visitsInto(withReRuns, 'test'), visitsInto(real, 'test'));
  assert.equal(visitsInto(withReRuns, 'test'), 2);
  const build = stepOf(engines[TOP], 'build');
  assert.deepEqual(nextState(build, engines[TOP], { subEngineDone: true, subEngineState: 'done' }, [...withReRuns, { 'from-state': 'test', 'to-state': 'build' }]), { to: 'test', exit: exitTo(build, 'test'), reason: 'exit' });
  // Unfinished once, then passing: Test again within the run, then Take Screenshots on to Document; the top-level Test entered once, Build never after it.
  const once = walk(TOP, { structuredOutput: testVerdicts(UNFINISHED, FINISHED(true)) }), first = once.indexOf(`${TOP}/test`);
  assert.deepEqual(once.slice(first, once.indexOf(`${TOP}/document`) + 1), [...LOCAL, 'v2-local-testing/test', 'v2-local-testing/take-screenshots', 'v2-local-testing/done', 'v2-test/steps-to-test', 'v2-steps-to-test/write-steps-to-test', 'v2-steps-to-test/done', 'v2-test/done', `${TOP}/document`]);
  assert.equal(once.filter(p => p === `${TOP}/test`).length, 1);
  assert.ok(!once.slice(first).includes(`${TOP}/build`), 'no Build after Test');
  // Always unfinished: Test's own cap (3) ends each run at done, Local Testing's (3) then v2-test at Blocked — the ticket at the top level's Blocked, never Build.
  const always = walk(TOP, { structuredOutput: testVerdicts(UNFINISHED) }), at = always.indexOf(`${TOP}/test`);
  assert.equal(always.at(-1), `${TOP}/blocked`);
  assert.deepEqual(always.filter(p => p.startsWith(`${TOP}/`)).slice(-2), [`${TOP}/test`, `${TOP}/blocked`]);
  assert.ok(!always.slice(at).includes(`${TOP}/build`), 'no Build after Test');
  assert.ok(!always.includes('v2-test/rebuild'), 'never Rebuild');
  assert.ok(always.includes('v2-test/blocked'), 'v2-test ends at Blocked');
  assert.equal(always.filter(p => p === 'v2-local-testing/test').length, 9, 'Test\'s cap times Local Testing\'s');
  // Unfinished, then genuinely rejected: the re-run, then Rebuild and Build — an unfinished run masks no real failure.
  const mixed = walk(TOP, { structuredOutput: testVerdicts(UNFINISHED, FINISHED(false)) }), from = mixed.indexOf(`${TOP}/test`);
  assert.deepEqual(mixed.slice(from, mixed.indexOf(`${TOP}/build`, from) + 1), [...LOCAL, 'v2-local-testing/test', 'v2-local-testing/done', 'v2-test/rebuild', `${TOP}/build`]);
});

const DOCUMENTING = [`${TOP}/document`, 'v2-document/update-documentation'];

test('ASS-115 AC1 (pair 1): v2-document\'s first steps are grouped-document\'s Update Documentation and Update Merge Request Details, field for field — prompts, max-visits 3 then Blocked, run in the VM, exits — Update Merge Request Details\' finished turn going on to Add Screenshots to Merge Request (step 3); the Document group step needs no new exit (its own is grouped\'s); validate.js accepts them', () => {
  const engine = engines['v2-document'], reference = id => stepOf(engines['grouped-document'], id);
  assert.equal(firstStepId(engine), 'update-documentation');
  same(stepOf(engine, 'update-documentation'), reference('update-documentation'));
  same(stepOf(engine, 'update-merge-request-details'), reference('update-merge-request-details'));
  for (const [id, prompt] of [['update-documentation', 'update-documentation-grouped'], ['update-merge-request-details', 'update-merge-request-details-grouped']]) {
    const step = stepOf(engine, id);
    assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location']], ['prompt', prompt, 3, 'blocked', 'vm'], id);
    assert.ok(existsSync(join(ROOT, 'prompts', prompt, 'prompt.txt')), prompt);
  }
  assert.deepEqual(stepOf(engines[TOP], 'document')['exit-events'], stepOf(engines['harness-development-grouped'], 'document')['exit-events']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-document', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-115 AC2 (pair 1): Update Documentation — its turn done goes on to Update Merge Request Details, whatever it changed; the turn not done matches no exit; entering Update Merge Request Details a fourth time goes to Blocked instead', () => {
  const engine = engines['v2-document'], step = stepOf(engine, 'update-documentation');
  assert.deepEqual(nextState(step, engine, { turnComplete: true }), { to: 'update-merge-request-details', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: false }), null);
  assert.deepEqual(nextState(step, engine, { turnComplete: true }, thrice('update-merge-request-details', Array(3).fill('update-documentation'))), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' });
});

test('ASS-115 AC2 (pair 1): Update Merge Request Details — its turn done goes on to Check Merge Request Details (ASS-219), then Add Screenshots to Merge Request; the turn not done matches no exit; the whole Document group, every fact the passing one, visits each step once', () => {
  const engine = engines['v2-document'], step = stepOf(engine, 'update-merge-request-details');
  assert.deepEqual(nextState(step, engine, { turnComplete: true }), { to: 'check-merge-request-details', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: false }), null);
  const trail = walk(TOP);
  assert.deepEqual(trail.slice(trail.indexOf(`${TOP}/document`), trail.indexOf(`${TOP}/review`) + 1), [...DOCUMENTING, 'v2-document/update-merge-request-details', 'v2-document/check-merge-request-details', 'v2-document/add-screenshots-to-merge-request', 'v2-document/done', `${TOP}/review`]);
  assert.deepEqual(trail, trailThrough(['check-setup-complete']));
});

const STEPS = ['v2-test/steps-to-test', 'v2-steps-to-test/write-steps-to-test', 'v2-steps-to-test/done'];

test('ASS-114 AC1 (pair 2): v2-test\'s last step is grouped-test\'s Steps to Test, running v2-steps-to-test — grouped-steps-to-test exactly (Write Steps to Test, the write-steps-to-test prompt in the VM, then done) — max-visits 3 then Blocked; and, Test\'s last sub-flow, Pass Through is gone: v2-test is grouped-test but for its sub-engines\' names, which validate.js accepts', () => {
  const engine = engines['v2-test'], step = stepOf(engine, 'steps-to-test');
  same(step, { ...stepOf(engines['grouped-test'], 'steps-to-test'), action: { type: 'state-engine', engine: 'v2-steps-to-test' } });
  assert.deepEqual([step['max-visits'], step['on-max-visits'], step['exit-events']], [3, 'blocked', [{ condition: { 'is-done': true }, 'move-to-state': 'done' }]]);
  sameShared(engines['v2-steps-to-test'], engines['grouped-steps-to-test']);
  hasInOrder(ids('v2-steps-to-test'), ['write-steps-to-test', 'done']);
  const write = stepOf(engines['v2-steps-to-test'], 'write-steps-to-test');
  assert.deepEqual([write.action.type, write.action.prompt, write['run-location']], ['prompt', 'write-steps-to-test-grouped', 'vm']);   // ASS-182: its own copy, posting on stdin
  assert.ok(existsSync(join(ROOT, 'prompts', 'write-steps-to-test-grouped', 'prompt.txt')));
  hasInOrder(ids('v2-test'), ['local-testing', 'steps-to-test', 'done', 'blocked', 'rebuild']);
  sameShared(asGrouped(engine), engines['grouped-test'], { as: withoutReRun });
  for (const name of ['v2-steps-to-test', 'v2-test', TOP]) assert.deepEqual(validateStateEngine(engines[name], ROOT, name, EXAMPLE_ENGINES), [], name);
});

test('ASS-114 AC2 (pair 2): Write Steps to Test — its turn done goes to done, whatever it wrote (its exit is turn-complete, not file-updated, so re-entered with steps-to-test.md already written it cannot loop, ASS-136); the turn not done matches no exit; Steps to Test — its run done goes to done and the ticket to Document; not done matches no exit; no step re-enters it within a run (its max-visits is grouped\'s, unreachable)', () => {
  const sub = engines['v2-steps-to-test'], write = stepOf(sub, 'write-steps-to-test');
  assert.deepEqual(nextState(write, sub, { turnComplete: true, fileUpdated: () => false }), { to: 'done', exit: write['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(write, sub, { turnComplete: false }), null);
  const engine = engines['v2-test'], step = stepOf(engine, 'steps-to-test');
  assert.deepEqual(nextState(step, engine, { subEngineDone: true, subEngineState: 'done' }), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { subEngineDone: false }), null);
  assert.deepEqual(engine.steps.flatMap(s => (s['exit-events'] ?? []).map(e => e['move-to-state'])).filter(to => to === 'steps-to-test'), ['steps-to-test']);
  assert.deepEqual(tested({}), [`${TOP}/test`, ...TEST.map(s => s.includes('/') ? s : `v2-test/${s}`), 'v2-test/done', `${TOP}/document`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-114 AC4: the whole Test group, no gates, ends at the right done step for each of its exits — all good: Local Testing (Test, Take Screenshots), Steps to Test, done and Document; nothing captured (an empty list): the same; Test failing once: Rebuild, back into Build at Generate Solution, then the whole of Test again and Document; failing every time: Build and Test take turns until the Test group step\'s fourth entry ends the ticket at the top level\'s Blocked', () => {
  const passing = [`${TOP}/test`, ...TEST.map(s => s.includes('/') ? s : `v2-test/${s}`), 'v2-test/done', `${TOP}/document`];
  assert.deepEqual(tested({}), passing);
  assert.deepEqual(tested({ structuredOutput: at => (at === 'take-screenshots' ? { screenshots: [] } : { 'is-approved': true }) }), passing);
  let runs = 0;
  const once = walk(TOP, { structuredOutput: at => ({ 'is-approved': at !== 'test' || runs++ > 0 }) });
  const first = once.indexOf(`${TOP}/test`), again = once.lastIndexOf(`${TOP}/test`);
  assert.deepEqual(once.slice(first, again + 1), [...LOCAL, 'v2-local-testing/done', 'v2-test/rebuild', `${TOP}/build`, ...BUILD.slice(2).map(s => `v2-build/${s}`), 'v2-build/done', `${TOP}/test`]);
  assert.deepEqual(once.slice(again, once.indexOf(`${TOP}/document`) + 1), passing);
  assert.ok(!once.slice(first, again).some(p => STEPS.includes(p)), 'a failed Test skips Steps to Test');
  const failing = walk(TOP, { structuredOutput: testVerdict(false) });
  assert.deepEqual(failing.filter(p => p.startsWith(`${TOP}/`)).slice(-9), ['plan', 'build', 'test', 'build', 'test', 'build', 'test', 'build', 'blocked'].map(s => `${TOP}/${s}`));
  assert.ok(!failing.some(p => STEPS.includes(p)), 'never Steps to Test');
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

// The Document part of a walk: from the Document group step to the top-level step after it.
const documented = given => { const trail = walk(TOP, given), at = trail.indexOf(`${TOP}/document`); return trail.slice(at, trail.findIndex((p, i) => i > at && p.startsWith(`${TOP}/`)) + 1); };

test('ASS-115 AC1 (step 3): v2-document\'s last step is grouped-document\'s Add Screenshots to Merge Request, field for field — the add-screenshots-to-merge-request-grouped prompt, max-visits 3 then Blocked, run in the VM, exits — and, Document\'s last step, Pass Through is gone: v2-document is grouped-document exactly, which validate.js accepts', () => {
  const engine = engines['v2-document'], step = stepOf(engine, 'add-screenshots-to-merge-request');
  same(step, stepOf(engines['grouped-document'], 'add-screenshots-to-merge-request'));
  assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location']], ['prompt', 'add-screenshots-to-merge-request-grouped', 3, 'blocked', 'vm']);
  assert.ok(existsSync(join(ROOT, 'prompts', 'add-screenshots-to-merge-request-grouped', 'prompt.txt')));
  hasInOrder(ids('v2-document'), [...DOCUMENT, 'done', 'blocked']);
  sameShared(engine, engines['grouped-document']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-document', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-115 AC2 (step 3): Add Screenshots to Merge Request — its turn done goes to done and the ticket to Review, whatever it attached (a no-visible-UI note too); the turn not done matches no exit; entering it a fourth time goes to Blocked instead', () => {
  const engine = engines['v2-document'], step = stepOf(engine, 'add-screenshots-to-merge-request'), details = stepOf(engine, 'update-merge-request-details');
  assert.deepEqual(nextState(step, engine, { turnComplete: true }), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: false }), null);
  assert.deepEqual(nextState(details, engine, { turnComplete: true }, thrice('check-merge-request-details', Array(3).fill('update-merge-request-details'))), { to: 'blocked', exit: details['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(documented({}), [...DOCUMENTING, 'v2-document/update-merge-request-details', 'v2-document/check-merge-request-details', 'v2-document/add-screenshots-to-merge-request', 'v2-document/done', `${TOP}/review`]);
});

test('ASS-115 AC4: the whole Document group, no gates, ends at the right done step for each of its exits — every turn done: each step once, then done and Review; any step entered a fourth time: Blocked, and the Document group step sends the ticket to the top level\'s Blocked, which hands it back to the start of Document', () => {
  const engine = engines['v2-document'], group = stepOf(engines[TOP], 'document');
  assert.deepEqual(documented({}), [`${TOP}/document`, ...DOCUMENT.map(s => `v2-document/${s}`), 'v2-document/done', `${TOP}/review`]);
  for (const [from, to] of [['update-documentation', 'update-merge-request-details'], ['update-merge-request-details', 'check-merge-request-details']]) {
    const step = stepOf(engine, from);
    assert.deepEqual(nextState(step, engine, { turnComplete: true }, thrice(to, Array(3).fill(from))), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' }, to);
  }
  assert.equal(stepOf(engine, 'blocked')['is-done'], true);
  assert.equal(nextState(group, engines[TOP], { subEngineDone: true, subEngineState: 'blocked' }).to, 'blocked');
  assert.equal(nextState(group, engines[TOP], { subEngineDone: true, subEngineState: 'done' }).to, 'review');
  assert.equal(group['return-to-state'], 'document');
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

// The Review part of a walk: from the Review group step to the top-level step after it.
const reviewed = given => { const trail = walk(TOP, given), at = trail.indexOf(`${TOP}/review`); return trail.slice(at, trail.findIndex((p, i) => i > at && p.startsWith(`${TOP}/`)) + 1); };
const EXPLAINED = 'explanation-{variation}.md';

test('ASS-116 AC1 (pair 1): v2-review\'s first steps are grouped-review\'s Explain the Change and Risk Assessment, field for field — the explain-the-change and risk-assessment-grouped prompts, max-visits 3 then Blocked, run in the VM, exits (Explain the Change on once it has written explanation-{variation}.md, else again) — Risk Assessment\'s finished turn on to Human Review (pair 2); validate.js accepts them', () => {
  const engine = engines['v2-review'], reference = id => stepOf(engines['grouped-review'], id);
  assert.equal(firstStepId(engine), 'explain-the-change');
  same(stepOf(engine, 'explain-the-change'), reference('explain-the-change'));
  same(stepOf(engine, 'risk-assessment'), toHumanReview(reference('risk-assessment')));   // ASS-314: grouped-review's goes on to the Token Expense Check, its Human Review gone
  for (const [id, prompt] of [['explain-the-change', 'explain-the-change'], ['risk-assessment', 'risk-assessment-grouped']]) {
    const step = stepOf(engine, id);
    assert.deepEqual([step.action.type, step.action.prompt, step['max-visits'], step['on-max-visits'], step['run-location']], ['prompt', prompt, 3, 'blocked', 'vm'], id);
    assert.ok(existsSync(join(ROOT, 'prompts', prompt, 'prompt.txt')), prompt);
  }
  assert.deepEqual(stepOf(engine, 'explain-the-change')['exit-events'].map(e => e['move-to-state']), ['risk-assessment', 'explain-the-change']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-review', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-116 AC2 (pair 1): Explain the Change — its turn done with explanation-{variation}.md written goes on to Risk Assessment; done without writing it, Explain the Change again (each pass is told to write it every run, so re-entered it cannot loop on an old file, ASS-136); the turn not done matches no exit; never written, its fourth entry goes to Blocked instead, and the Review group step sends the ticket to the top level\'s Blocked; entering Risk Assessment a fourth time goes to Blocked too', () => {
  const engine = engines['v2-review'], step = stepOf(engine, 'explain-the-change');
  const written = ok => ({ turnComplete: true, fileUpdated: file => (file === EXPLAINED ? ok : true) });
  assert.deepEqual(nextState(step, engine, written(true)), { to: 'risk-assessment', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, written(false)), { to: 'explain-the-change', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, { turnComplete: false, fileUpdated: () => true }), null);
  assert.deepEqual(nextState(step, engine, written(false), thrice('explain-the-change', Array(3).fill('explain-the-change'))), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  assert.deepEqual(nextState(step, engine, written(true), thrice('risk-assessment', Array(3).fill('explain-the-change'))), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' });
  const never = reviewed({ fileUpdated: file => file !== EXPLAINED });
  assert.deepEqual(never, [`${TOP}/review`, ...Array(3).fill('v2-review/explain-the-change'), 'v2-review/blocked', `${TOP}/blocked`]);
  assert.equal(stepOf(engines[TOP], 'review')['return-to-state'], 'review');
  // Unwritten on the first pass (asked twice: by the forward exit, then by the self-loop's not), written on the second.
  let asks = 0;
  const second = reviewed({ fileUpdated: file => file !== EXPLAINED || asks++ >= 2 });
  assert.deepEqual(second, [`${TOP}/review`, 'v2-review/explain-the-change', ...REVIEW.map(s => `v2-review/${s}`), 'v2-review/done', `${TOP}/release`]);
});

test('ASS-116 AC2 (pair 1): Risk Assessment — its turn done goes on to Human Review, whatever its verdict (flagged for human review or not: Human Review, every time, comes next); the turn not done matches no exit; the whole Review group, every fact the passing one, visits each step once', () => {
  const engine = engines['v2-review'], step = stepOf(engine, 'risk-assessment');
  for (const flagged of [true, false]) assert.deepEqual(nextState(step, engine, { turnComplete: true, structuredOutput: { 'flagged-for-human-review': flagged } }), { to: 'human-review', exit: step['exit-events'][0], reason: 'exit' }, String(flagged));
  assert.equal(nextState(step, engine, { turnComplete: false }), null);
  assert.deepEqual(reviewed({}), [`${TOP}/review`, ...REVIEW.map(s => `v2-review/${s}`), 'v2-review/done', `${TOP}/release`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-116 AC1 (pair 2): v2-review\'s next steps are its own Human Review (grouped-review has none since ASS-314) and grouped-review\'s AI Token Expense Check, field for field — Human Review a human step, Approved on to the Token Expense Check, Rejected to the Back to Plan done step; the Token Expense Check the check-if-ticket-will-spend-tokens-grouped prompt, run in the VM, its verdicts going on to the Payment Gate and Variation Selection (pair 3); both max-visits 3 then Blocked. Back to Plan is grouped\'s, and the Review group step takes grouped\'s exits: replan back into Plan at Write Execution Plan; validate.js accepts them', () => {
  const engine = engines['v2-review'], reference = id => stepOf(engines['grouped-review'], id);
  // ASS-314: grouped-review has no Human Review to compare with any more — v2-review's is asserted field by field here instead.
  assert.equal(reference('human-review'), undefined);
  assert.equal(stepOf(engine, 'human-review')['is-active'], false);   // ASS-192: switched off for harness, passed by its Approved exit
  assert.deepEqual(stepOf(engine, 'human-review')['exit-events'].map(e => [e.condition, e['move-to-state']]), [[{ 'human-review': 'Approved' }, 'token-expense-check'], [{ 'human-review': 'Rejected' }, 'replan'], [{ 'fast-tracked': true }, 'token-expense-check']]);   // ASS-151: a fast-tracked ticket passes it by itself
  same(stepOf(engine, 'token-expense-check'), reference('token-expense-check'));
  assert.deepEqual(stepOf(engine, 'token-expense-check')['exit-events'].map(e => e['move-to-state']), ['payment-gate', 'variation-selection']);
  const human = stepOf(engine, 'human-review'), tokens = stepOf(engine, 'token-expense-check');
  assert.deepEqual([human.action.type, human['max-visits'], human['on-max-visits']], ['human', 3, 'blocked']);
  assert.deepEqual([tokens.action.type, tokens.action.prompt, tokens['max-visits'], tokens['on-max-visits'], tokens['run-location']], ['prompt', 'check-if-ticket-will-spend-tokens-grouped', 3, 'blocked', 'vm']);
  assert.ok(existsSync(join(ROOT, 'prompts', 'check-if-ticket-will-spend-tokens-grouped', 'prompt.txt')));
  same(stepOf(engine, 'replan'), reference('replan'));
  assert.deepEqual(stepOf(engines[TOP], 'review')['exit-events'], stepOf(engines['harness-development-grouped'], 'review')['exit-events']);
  assert.deepEqual(stepOf(engines[TOP], 'review')['exit-events'][1], { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'replan' }] }, 'move-to-state': 'plan', 'start-sub-engine-at': 'write-execution-plan' });
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-review', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-116 AC2 (pair 2): Human Review — Approved goes on to the Token Expense Check, Rejected to Back to Plan; no choice, or a choice recorded at another step, matches no exit (it waits for the human); entering it a fourth time goes to Blocked', () => {
  const engine = engines['v2-review'], step = stepOf(engine, 'human-review');
  const chose = (decision, state = 'human-review') => ({ humanReview: { state, decision } });
  assert.deepEqual(nextState(step, engine, chose('Approved')), { to: 'token-expense-check', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, chose('Rejected')), { to: 'replan', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, {}), null);
  assert.equal(nextState(step, engine, chose('Approved', 'payment-gate')), null);
  // Visits count exits into a step within the run; a run that reaches Human Review a fourth time ends at Blocked, as each of grouped\'s.
  assert.deepEqual(nextState(stepOf(engine, 'risk-assessment'), engine, { turnComplete: true }, thrice('human-review', Array(3).fill('risk-assessment'))), { to: 'blocked', exit: stepOf(engine, 'risk-assessment')['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(nextState(step, engine, chose('Approved'), thrice('token-expense-check', Array(3).fill('human-review'))), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' });
});

test('ASS-116 AC2 (pair 2): Rejected at Human Review ends the run at Back to Plan, and the Review group step sends the ticket back into Plan at Write Execution Plan (not Enrich AC), on through Build, Test and Document to Review again, where the next pass explains it anew; the reason the human gave is the variation\'s rejection-reason, kept through the move (test/agent-cli/human-review.test.js, ASS-118). Rejected every time, the third rejection would be Plan\'s fourth entry (its max-visits 3), so the ticket goes to the top level\'s Blocked instead', () => {
  let rejections = 1;
  const once = at => ({ state: at, decision: at === 'human-review' && rejections-- > 0 ? 'Rejected' : 'Approved' });
  const trail = walk(TOP, { humanReview: once });
  const replanned = trail.indexOf('v2-review/replan');
  assert.deepEqual(trail.slice(replanned - 3, replanned + 4), ['v2-review/explain-the-change', 'v2-review/risk-assessment', 'v2-review/human-review', 'v2-review/replan', `${TOP}/plan`, 'v2-plan/write-execution-plan', 'v2-plan/write-test-plan']);
  const again = trail.slice(replanned + 1);
  assert.ok(!again.includes('v2-plan/enrich-ac') && !again.includes('v2-plan/root-cause-analysis'), 'Plan re-entered at Write Execution Plan');
  assert.deepEqual(again.filter(p => p.startsWith(`${TOP}/`)), [`${TOP}/plan`, `${TOP}/build`, `${TOP}/test`, `${TOP}/document`, `${TOP}/review`, `${TOP}/release`, `${TOP}/done`]);
  assert.equal(trail.filter(p => p === 'v2-review/explain-the-change').length, 2);
  assert.equal(trail.filter(p => p === 'v2-review/token-expense-check').length, 1);
  const top = stepOf(engines[TOP], 'review');
  assert.deepEqual(nextState(top, engines[TOP], { subEngineDone: true, subEngineState: 'replan' }), { to: 'plan', exit: top['exit-events'][1], reason: 'exit' });
  const always = walk(TOP, { humanReview: at => ({ state: at, decision: 'Rejected' }) });
  assert.equal(always.filter(p => p === `${TOP}/review`).length, 3);
  assert.equal(always.filter(p => p === `${TOP}/plan`).length, 3);
  assert.deepEqual(always.slice(-3), ['v2-review/human-review', 'v2-review/replan', `${TOP}/blocked`]);
});

test('ASS-116 AC2 (pair 2): the AI Token Expense Check — its turn done, will spend tokens goes on to the Payment Gate, will not to Variation Selection (pair 3); the turn not done, or done with no verdict, matches no exit; entering it a fourth time goes to Blocked; the whole Review group, every fact the passing one, visits each step once', () => {
  const engine = engines['v2-review'], step = stepOf(engine, 'token-expense-check');
  for (const [spends, i, to] of [[true, 0, 'payment-gate'], [false, 1, 'variation-selection']]) assert.deepEqual(nextState(step, engine, { turnComplete: true, structuredOutput: { 'will-spend-tokens': spends } }), { to, exit: step['exit-events'][i], reason: 'exit' }, String(spends));
  assert.equal(nextState(step, engine, { turnComplete: false, structuredOutput: { 'will-spend-tokens': false } }), null);
  assert.equal(nextState(step, engine, { turnComplete: true, structuredOutput: {} }), null);
  assert.deepEqual(nextState(stepOf(engine, 'human-review'), engine, { humanReview: { state: 'human-review', decision: 'Approved' } }, thrice('token-expense-check', Array(3).fill('human-review'))).to, 'blocked');
  assert.deepEqual(reviewed({}), [`${TOP}/review`, ...REVIEW.map(s => `v2-review/${s}`), 'v2-review/done', `${TOP}/release`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

// The steps of a walk's Review run (each "v2-review/<step>"), every fact the passing one but `given`.
const reviewRun = given => reviewed(given).filter(p => p.startsWith('v2-review/')).map(p => p.slice('v2-review/'.length));
// A human's choice at one step (`decision`), every other human step approved.
const decideAt = (step, decision) => at => ({ state: at, decision: at === step ? decision : 'Approved' });
// The facts of a will-spend-tokens verdict at the Token Expense Check.
const SPENDS = { structuredOutput: { 'is-approved': true, 'will-spend-tokens': true } };

test('ASS-116 AC1 (pair 3): v2-review\'s last steps are grouped-review\'s Payment Gate and Variation Selection, field for field — both human steps, max-visits 3 then Blocked; the Payment Gate Approved on to Variation Selection, Rejected to Back to Plan; Variation Selection on to done once a variation is chosen there, or at once when the ticket has only one — and, Review\'s last steps, Pass Through is gone: v2-review is grouped-review exactly, which validate.js accepts', () => {
  const engine = engines['v2-review'], reference = id => stepOf(engines['grouped-review'], id);
  for (const id of ['payment-gate', 'variation-selection']) {
    const step = stepOf(engine, id);
    same(switchedOn(step), reference(id), id);
    assert.deepEqual([step.action.type, step['max-visits'], step['on-max-visits']], ['human', 3, 'blocked'], id);
  }
  assert.equal(stepOf(engine, 'payment-gate')['is-active'], false);   // ASS-192: switched off for the v2 projects (operator, 2026-10-28), passed by its Approved exit
  assert.deepEqual(stepOf(engine, 'payment-gate')['exit-events'].map(e => [e.condition, e['move-to-state']]), [[{ 'human-review': 'Approved' }, 'variation-selection'], [{ 'human-review': 'Rejected' }, 'replan'], [{ 'fast-tracked': true }, 'variation-selection']]);   // ASS-151
  assert.deepEqual(stepOf(engine, 'variation-selection')['exit-events'].map(e => [e.condition, e['move-to-state']]), [[{ 'variation-selected': true }, 'done'], [{ 'has-variations': false }, 'done']]);
  hasInOrder(ids('v2-review'), ['explain-the-change', 'risk-assessment', 'human-review', 'token-expense-check', 'payment-gate', 'variation-selection', 'done', 'blocked', 'replan', 'write-test-plan', 'generate-solution']);   // ASS-228: Human Review's return steps
  sameShared(engine, engines['grouped-review'], { as: switchedOn, asReference: toHumanReview });   // but for Human Review and Payment Gate switched off (ASS-192), and grouped-review's Human Review gone (ASS-314)
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-review', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-116 AC2 (pair 3): the Payment Gate — Approved goes on to Variation Selection, Rejected to Back to Plan (the Review group step then sends the ticket back into Plan at Write Execution Plan); no choice, or a choice recorded at Human Review, matches no exit (it waits for the human); entering Variation Selection a fourth time goes to Blocked; reached only when the Token Expense Check says tokens will be spent', () => {
  const engine = engines['v2-review'], step = stepOf(engine, 'payment-gate');
  const chose = (decision, state = 'payment-gate') => ({ humanReview: { state, decision } });
  assert.deepEqual(nextState(step, engine, chose('Approved')), { to: 'variation-selection', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, chose('Rejected')), { to: 'replan', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, {}), null);
  assert.equal(nextState(step, engine, chose('Approved', 'human-review')), null, 'Human Review\'s approval is not the Payment Gate\'s');
  assert.deepEqual(nextState(step, engine, chose('Approved'), thrice('variation-selection', Array(3).fill('payment-gate'))), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(reviewRun(SPENDS), ['explain-the-change', 'risk-assessment', 'human-review', 'token-expense-check', 'payment-gate', 'variation-selection', 'done']);
  assert.ok(!reviewRun({}).includes('payment-gate'), 'no tokens spent: no Payment Gate');
  const trail = walk(TOP, { ...SPENDS, humanReview: decideAt('payment-gate', 'Rejected') });
  const replanned = trail.indexOf('v2-review/replan');
  assert.deepEqual(trail.slice(replanned - 1, replanned + 3), ['v2-review/payment-gate', 'v2-review/replan', `${TOP}/plan`, 'v2-plan/write-execution-plan']);
});

test('ASS-116 AC2 (pair 3): Variation Selection — a ticket with one variation (has-variations false) goes on to done by itself, no human asked, and the TUI shows no choice for it (humanGate null); with two or more it waits until a variation is chosen at it (ticket:select-variation at the detailed step), then goes to done; a choice made at another step matches no exit', () => {
  const engine = engines['v2-review'], step = stepOf(engine, 'variation-selection');
  assert.deepEqual(nextState(step, engine, { variationCount: 1 }), { to: 'done', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, engine, { variationCount: 2 }), null);
  assert.deepEqual(nextState(step, engine, { variationCount: 2, selectedVariation: { state: 'variation-selection' } }), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { variationCount: 2, selectedVariation: { state: 'human-review' } }), null);
  // The TUI's human gate, the ticket at Variation Selection inside its Review run.
  const variation = name => ({ name, 'harness-status': { state: 'review', 'state-engine': TOP, 'sub-status': { state: 'variation-selection', 'state-engine': 'v2-review' } }, 'merge-request': [{ url: `https://example.test/${name}` }] });
  const chain = [{ 'state-engine': TOP, state: 'review', step: stepOf(engines[TOP], 'review') }, { 'state-engine': 'v2-review', state: 'variation-selection', step }];
  const run = { id: 'run-1', 'state-engine': 'v2-review', state: 'variation-selection', parent: { 'work-item': 'ASS-125', variation: 'A', 'state-engine': TOP, state: 'review' }, 'state-changes': [] };
  const at = (...names) => humanGate({ key: 'ASS-125', step: stepOf(engines[TOP], 'review'), status: { chain }, variation: variation(names[0]), variations: names.map(variation) }, engines[TOP].steps, { engines, runs: [run] });
  assert.equal(at('A'), null);
  assert.deepEqual(at('A', 'B').choices.map(c => [c.decision, c.command, c.args]), [['Go with ASS-125.A', 'ticket:select-variation', ['A', '']], ['Go with ASS-125.B', 'ticket:select-variation', ['B', '']]]);
});

test('ASS-116 AC4: the whole Review group, no gates, ends at the right done step for each of its exits — every human approving: no tokens spent, Explain the Change, Risk Assessment, Human Review, the Token Expense Check, Variation Selection (one variation: on by itself), done and Release; tokens spent: the Payment Gate before Variation Selection; Rejected at Human Review or at the Payment Gate: Back to Plan, and the ticket into Plan at Write Execution Plan; any step entered a fourth time (Explain the Change never written): Blocked, and the ticket to the top level\'s Blocked, which hands it back to the start of Review', () => {
  const engine = engines['v2-review'], group = stepOf(engines[TOP], 'review');
  assert.deepEqual(reviewed({}), [`${TOP}/review`, ...REVIEW.map(s => `v2-review/${s}`), 'v2-review/done', `${TOP}/release`]);
  assert.deepEqual(reviewed(SPENDS), [`${TOP}/review`, ...['explain-the-change', 'risk-assessment', 'human-review', 'token-expense-check', 'payment-gate', 'variation-selection'].map(s => `v2-review/${s}`), 'v2-review/done', `${TOP}/release`]);
  for (const [at, given] of [['human-review', {}], ['payment-gate', SPENDS]]) {
    assert.deepEqual(reviewed({ ...given, humanReview: decideAt(at, 'Rejected') }).slice(-3), [`v2-review/${at}`, 'v2-review/replan', `${TOP}/plan`], at);
  }
  assert.deepEqual(reviewed({ fileUpdated: file => file !== EXPLAINED }).slice(-2), ['v2-review/blocked', `${TOP}/blocked`]);
  for (const [from, to, facts] of [['risk-assessment', 'human-review', { turnComplete: true }], ['human-review', 'token-expense-check', { humanReview: { state: 'human-review', decision: 'Approved' } }], ['token-expense-check', 'payment-gate', { turnComplete: true, structuredOutput: { 'will-spend-tokens': true } }], ['payment-gate', 'variation-selection', { humanReview: { state: 'payment-gate', decision: 'Approved' } }]]) {
    const step = stepOf(engine, from);
    assert.equal(nextState(step, engine, facts, thrice(to, Array(3).fill(from))).to, 'blocked', to);
  }
  for (const [end, to] of [['done', 'release'], ['blocked', 'blocked'], ['replan', 'plan']]) {
    assert.equal(stepOf(engine, end)['is-done'], true, end);
    assert.equal(nextState(group, engines[TOP], { subEngineDone: true, subEngineState: end }).to, to, end);
  }
  assert.equal(nextState(group, engines[TOP], { subEngineDone: true, subEngineState: 'replan' }).exit['start-sub-engine-at'], 'write-execution-plan');
  assert.equal(group['return-to-state'], 'review');
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

// The Release part of a walk: from the Release group step to the top-level step after it.
const released = given => { const trail = walk(TOP, given), at = trail.indexOf(`${TOP}/release`); return trail.slice(at, trail.findIndex((p, i) => i > at && p.startsWith(`${TOP}/`)) + 1); };

test('ASS-117 AC1 (pair 1): v2-release\'s first steps are grouped-release-harness\'s Merge Pull Request and Update the Harness, field for field — merge-request:merge and code:update-workspace on the host, max-visits 3 then Blocked, exit 0 on, any other to Blocked — Update the Harness\'s exit 0 going on to Request a Restart (pair 2); the Release group step is harness-development-grouped\'s but for its engine and description; validate.js accepts them', () => {
  const engine = beforeQueue(engines['v2-release']), reference = id => stepOf(engines['grouped-release-harness'], id);
  assert.equal(firstStepId(engine), 'merge-pull-request');
  same(stepOf(engine, 'merge-pull-request'), reference('merge-pull-request'));
  same(stepOf(engine, 'update-workspace'), reference('update-workspace'));
  for (const [id, command] of [['merge-pull-request', './agent.sh merge-request:merge {project} {ticket} {variation}'], ['update-workspace', './agent.sh code:update-workspace {project}']]) {
    const step = stepOf(engine, id);
    assert.deepEqual([step.action, step['max-visits'], step['on-max-visits'], step['run-location']], [{ type: 'script', command }, 3, 'blocked', undefined], id);
  }
  assert.deepEqual(stepOf(engine, 'merge-pull-request')['exit-events'].map(e => e['move-to-state']), ['update-workspace', 'blocked']);
  const { action, description, ...release } = stepOf(beforeQueue(engines[TOP]), 'release'), { action: a, description: d, ...grouped } = stepOf(engines['harness-development-grouped'], 'release');
  assert.deepEqual([working(release), action], [working(grouped), { type: 'state-engine', engine: 'v2-release' }]);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-release', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-117 AC2 (pair 1): Merge Pull Request — exit 0 (every Open one merged) goes on to Update the Harness; any other exit (one could not merge, or is not merged after) goes to Blocked, and the Release group step sends the ticket to the top level\'s Blocked, which returns it to Release; entering Update the Harness a fourth time goes to Blocked too', () => {
  const engine = beforeQueue(engines['v2-release']), step = stepOf(engine, 'merge-pull-request');
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }), { to: 'update-workspace', exit: step['exit-events'][0], reason: 'exit' });
  for (const code of [1, 2]) assert.deepEqual(nextState(step, engine, { exitCode: code }), { to: 'blocked', exit: step['exit-events'][1], reason: 'exit' }, String(code));
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }, thrice('update-workspace', Array(3).fill('merge-pull-request'))), { to: 'blocked', exit: step['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(released({ exitCode: at => at === 'merge-pull-request' ? 1 : 0 }), [`${TOP}/release`, 'v2-release/merge-pull-request', 'v2-release/blocked', `${TOP}/blocked`]);
  assert.equal(stepOf(engines[TOP], 'release')['return-to-state'], 'release');
});

test('ASS-117 AC2 (pair 1): Update the Harness — exit 0 (fast-forwarded) goes on to Request a Restart (pair 2); any other exit (it would overwrite a local change, is not on the default branch, or cannot fast-forward) goes to Blocked and the ticket to the top level\'s; the whole Release group, every fact the passing one, visits each step once', () => {
  const engine = engines['v2-release'], step = stepOf(engine, 'update-workspace');
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }), { to: 'request-restart', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, { exitCode: 1 }), { to: 'blocked', exit: step['exit-events'][1], reason: 'exit' });
  assert.deepEqual(released({ exitCode: at => at === 'update-workspace' ? 1 : 0 }), [`${TOP}/release`, 'v2-release/merge-pull-request', 'v2-release/update-workspace', 'v2-release/blocked', `${TOP}/blocked`]);
  assert.deepEqual(released({}), [`${TOP}/release`, ...RELEASE.map(s => `v2-release/${s}`), 'v2-release/done', `${TOP}/done`]);
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-117 AC1 (pair 2): v2-release\'s last steps are grouped-release-harness\'s Request a Restart and Await the Restart, field for field — on the host, harness:request-restart (max-visits 3 then Blocked; exit 0 on, any other to Blocked) and harness:restarted on a one-minute timer (exit 0 to done) — and, Release\'s last steps, Pass Through is gone: v2-release is grouped-release-harness exactly, which validate.js accepts', () => {
  const engine = beforeQueue(engines['v2-release']), reference = id => stepOf(engines['grouped-release-harness'], id);
  for (const id of ['request-restart', 'await-restart']) same(stepOf(engine, id), reference(id), id);
  const request = stepOf(engine, 'request-restart'), wait = stepOf(engine, 'await-restart');
  assert.deepEqual([request.action, request['max-visits'], request['on-max-visits'], request['run-location']], [{ type: 'script', command: './agent.sh harness:request-restart {ticket}' }, 3, 'blocked', undefined]);
  assert.deepEqual(request['exit-events'].map(e => e['move-to-state']), ['await-restart', 'blocked']);
  assert.deepEqual([wait.action, wait['run-location']], [{ type: 'script', command: './agent.sh harness:restarted {ticket}', mode: 'timer', 'timer-minutes': 1, 'waiting-exit-code': 1 }, undefined]);
  assert.deepEqual(wait['exit-events'], [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }]);
  hasInOrder(engine.steps.map(s => s.id), [...RELEASE, 'done', 'blocked']);
  sameShared(engine, engines['grouped-release-harness']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-release', EXAMPLE_ENGINES), []);
  assert.deepEqual(validateStateEngine(engines[TOP], ROOT, TOP, EXAMPLE_ENGINES), []);
});

test('ASS-117 AC2 (pair 2): Request a Restart — exit 0 (the request written, naming every control running) goes on to Await the Restart; any other exit goes to Blocked and the ticket to the top level\'s; entering it a fourth time goes to Blocked instead', () => {
  const engine = engines['v2-release'], step = stepOf(engine, 'request-restart'), update = stepOf(engine, 'update-workspace');
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }), { to: 'await-restart', exit: step['exit-events'][0], reason: 'exit' });
  assert.deepEqual(nextState(step, engine, { exitCode: 1 }), { to: 'blocked', exit: step['exit-events'][1], reason: 'exit' });
  assert.deepEqual(nextState(update, engine, { exitCode: 0 }, thrice('request-restart', Array(3).fill('update-workspace'))), { to: 'blocked', exit: update['exit-events'][0], reason: 'max-visits' });
  assert.deepEqual(released({ exitCode: at => at === 'request-restart' ? 1 : 0 }), [`${TOP}/release`, 'v2-release/merge-pull-request', 'v2-release/update-workspace', 'v2-release/request-restart', 'v2-release/blocked', `${TOP}/blocked`]);
});

test('ASS-117 AC2 (pair 2): Await the Restart — exit 0 (every control the request named gone, a new one running) goes to done and the ticket to Done; any other exit (not yet) matches no exit, so it waits, asked again on its timer; no visit limit (it never re-enters itself)', () => {
  const engine = engines['v2-release'], step = stepOf(engine, 'await-restart');
  assert.deepEqual(nextState(step, engine, { exitCode: 0 }), { to: 'done', exit: step['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step, engine, { exitCode: 1 }), null);
  assert.equal(step['max-visits'], undefined);
  assert.deepEqual(released({}), [`${TOP}/release`, ...RELEASE.map(s => `v2-release/${s}`), 'v2-release/done', `${TOP}/done`]);
});

test('ASS-117 AC4: the whole Release group, no gates, ends at the right done step for each of its exits — every script exiting 0: Merge Pull Request, Update the Harness, Request a Restart, Await the Restart, done and the ticket to Done; any of the first three failing: Blocked, and the ticket to the top level\'s Blocked, which hands it back to the start of Release; Await the Restart not yet: it waits; a step entered a fourth time: Blocked', () => {
  const engine = engines['v2-release'], group = stepOf(engines[TOP], 'release');
  assert.deepEqual(released({}), [`${TOP}/release`, ...RELEASE.map(s => `v2-release/${s}`), 'v2-release/done', `${TOP}/done`]);
  for (const [i, failing] of ['merge-pull-request', 'update-workspace', 'request-restart'].entries()) {
    assert.deepEqual(released({ exitCode: at => at === failing ? 1 : 0 }), [`${TOP}/release`, ...RELEASE.slice(0, i + 1).map(s => `v2-release/${s}`), 'v2-release/blocked', `${TOP}/blocked`], failing);
  }
  assert.equal(nextState(stepOf(engine, 'await-restart'), engine, { exitCode: 1 }), null);
  for (const [from, to] of [['merge-pull-request', 'update-workspace'], ['update-workspace', 'request-restart'], ['request-restart', 'await-restart']]) {
    const step = stepOf(engine, from);
    assert.equal(nextState(step, engine, { exitCode: 0 }, thrice(to, Array(3).fill(from))).to, to === 'await-restart' ? 'await-restart' : 'blocked', to);
  }
  assert.equal(stepOf(engine, 'blocked')['is-done'], true);
  assert.equal(nextState(group, engines[TOP], { subEngineDone: true, subEngineState: 'blocked' }).to, 'blocked');
  assert.equal(nextState(group, engines[TOP], { subEngineDone: true, subEngineState: 'done' }).to, 'done');
  assert.equal(group['return-to-state'], 'release');
  assert.deepEqual(walk(TOP), trailThrough(['check-setup-complete']));
});

test('ASS-197: Merge Pull Request merges in its turn — merge-request:merge-in-turn with the full tests (npm test), on the host, asked every minute: exit 0 merged on to Update the Harness; exit 0 waiting (behind another ticket, or its own gate running) stays; exit 2 (red) to Back to Build, which sends the ticket into Build at Generate Solution; any other exit to Blocked — v2 alone, the grouped engines unchanged', () => {
  const engine = engines['v2-release'], step = stepOf(engine, 'merge-pull-request');
  assert.deepEqual([step.action, step['max-visits'], step['on-max-visits'], step['run-location']],
    [{ type: 'script', command: './agent.sh merge-request:merge-in-turn {project} {ticket} {variation} npm test', mode: 'timer', 'timer-minutes': 1 }, 3, 'blocked', undefined]);
  assert.equal(nextState(step, engine, { exitCode: 0, scriptOutput: { merged: true } }).to, 'update-workspace');
  assert.equal(nextState(step, engine, { exitCode: 0, scriptOutput: { waiting: true, behind: 'ASS-1' } }), null);
  assert.equal(nextState(step, engine, { exitCode: 2 }).to, 'rebuild');
  assert.equal(nextState(step, engine, { exitCode: 1 }).to, 'blocked');
  assert.equal(stepOf(engine, 'rebuild')['is-done'], true);
  const release = stepOf(engines[TOP], 'release');
  // ASS-315: the exit names its own cause, so the move it makes restarts Build, Test, Document and Review's visit windows.
  assert.deepEqual(nextState(release, engines[TOP], { subEngineDone: true, subEngineState: 'rebuild' }).exit, { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'rebuild' }] }, 'move-to-state': 'build', 'start-sub-engine-at': 'generate-solution', cause: 'merge-gate-red' });
  const trail = walk(TOP, { exitCode: at => (at === 'merge-pull-request' ? 2 : 0) }), at = trail.indexOf(`${TOP}/release`);
  assert.deepEqual(trail.slice(at, at + 5), [`${TOP}/release`, 'v2-release/merge-pull-request', 'v2-release/rebuild', `${TOP}/build`, 'v2-build/generate-solution']);
  assert.equal(trail.at(-1), `${TOP}/blocked`);                                                  // red every time: Build's visits run out
  for (const name of ['v2-release', TOP]) assert.deepEqual(validateStateEngine(engines[name], ROOT, name, EXAMPLE_ENGINES), [], name);
  assert.equal(stepOf(engines['grouped-release-harness'], 'merge-pull-request').action.command, './agent.sh merge-request:merge {project} {ticket} {variation}');
});

// Every engine a top-level engine runs, itself included.
const reach = (name, seen = new Set()) => { if (seen.has(name)) return seen; seen.add(name); for (const s of engines[name].steps) if (s.action.type === 'state-engine') reach(s.action.engine, seen); return seen; };

test('AC4: example is untouched — example-development and example-development-grouped run no v2 engine, and the v2 stubs are harness-development-v2\'s and its example GitHub copy\'s alone', () => {
  const stubs = GROUPS.map(g => `v2-${g}`);
  for (const name of ['example-development', 'example-development-grouped']) assert.deepEqual([...reach(name)].filter(n => n.includes('v2')), [], name);
  const users = Object.keys(engines).filter(n => engines[n].steps.some(s => stubs.includes(s.action.engine)));
  assert.deepEqual(users, ['example-github-development', TOP]);
});

test('AC1: project:set-execution-engine switches a harness project onto harness-development-v2 and back to harness-development — on a copy, never projects/harness', async () => {
  const f = fixture();
  for (const name of reach(TOP).union(new Set(['harness-development']))) cpSync(engineDir(name), join(f.dir, 'engines', name), { recursive: true });
  const file = join(f.dir, 'projects', 'p', 'project.json'), project = () => JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...project(), 'execution-state-engine': 'harness-development' }));
  // The sprint's variations at steps both engines have (Backlog, Committed, Done): the command refuses any other.
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s = JSON.parse(readFileSync(sprint, 'utf8'));
  s.features[0].variations.slice(0, 3).forEach((v, i) => { v['harness-status'] = { state: ['committed', 'done', 'backlog'][i], 'state-engine': 'harness-development' }; });
  writeFileSync(sprint, JSON.stringify(s));
  const engineOfEach = () => f.sprint().features[0].variations.slice(0, 3).map(v => v['harness-status']['state-engine']);
  assert.match((await f.agent('project:set-execution-engine', 'p', TOP)).stdout, /p: harness-development → harness-development-v2/);
  assert.equal(project()['execution-state-engine'], TOP);
  assert.deepEqual(engineOfEach(), [TOP, TOP, TOP]);
  assert.match((await f.agent('project:set-execution-engine', 'p', 'harness-development')).stdout, /p: harness-development-v2 → harness-development/);
  assert.equal(project()['execution-state-engine'], 'harness-development');
  assert.deepEqual(engineOfEach(), ['harness-development', 'harness-development', 'harness-development']);
});

test('AC5: engines/grouped-engines.md says how to switch to harness-development-v2 and back to harness-development, and what a test run between added steps is', () => {
  const doc = readFileSync(engineDir('grouped-engines.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## The restructure: harness-development-v2'));
  assert.ok(section.length < doc.length, 'its own section');
  assert.match(section, /\.\/agent\.sh project:set-execution-engine harness harness-development-v2/);
  assert.match(section, /\.\/agent\.sh project:set-execution-engine harness harness-development\s/);
  assert.match(section, /### A test run/);
  assert.match(section, /ticket:set-gate-when-leaving-state/);
});

// ASS-81 on the live engine: the steps that make and use the planned merge requests are the grouped
// ones test/workflow/grouped-development.test.js checks cover every MR (their -grouped prompts and scripts).
test('ASS-81: in harness-development-v2, Generate Solution and every step after it that handles merge requests runs the grouped prompt that covers every one; Merge Pull Request merges the whole variation, any failure to Blocked', () => {
  const stepIn = (group, id, sub) => stepOf(engines[sub ?? stepOf(engines[TOP], group).action.engine], id);
  for (const [group, id, name, sub] of [['build', 'generate-solution', 'generate-solution-grouped'], ['build', 'code-review', 'code-review-grouped'],
    ['build', 'security-review', 'security-review-grouped'], ['test', 'take-screenshots', 'take-screenshots-grouped', 'v2-local-testing'],
    ['document', 'update-merge-request-details', 'update-merge-request-details-grouped'], ['document', 'add-screenshots-to-merge-request', 'add-screenshots-to-merge-request-grouped'],
    ['review', 'risk-assessment', 'risk-assessment-grouped'], ['review', 'token-expense-check', 'check-if-ticket-will-spend-tokens-grouped']]) {
    assert.equal(stepIn(group, id, sub).action.prompt, name, id);
    assert.ok(readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8').includes('{agent-sh} ticket:merge-request-plan {project} {ticket} {variation}'), name);
  }
  const merge = stepIn('release', 'merge-pull-request');
  assert.equal(merge.action.command, './agent.sh merge-request:merge-in-turn {project} {ticket} {variation} npm test');   // merge-request:merge, in its turn (ASS-197)
  assert.deepEqual(merge['exit-events'].map(e => e['move-to-state']), ['update-workspace', 'rebuild', 'blocked']);
});

// ASS-149 AC1: the health check v2 runs is check-health plus the golden-image check, first; the flat engines keep check-health.
test('ASS-149 AC1: check-health-v2 is check-health with Check Golden Images first — vm:raise-golden-rebuilds on the host, either exit going on to Check Harness — and only harness-development-v2 and its example GitHub copy run it', () => {
  const v2 = engines['check-health-v2'], flat = engines['check-health'];
  assert.equal(firstStepId(v2), 'check-golden-images');
  assert.deepEqual(working(stepOf(v2, 'check-golden-images')), { id: 'check-golden-images',
    action: { type: 'script', command: './agent.sh vm:raise-golden-rebuilds' },
    'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'check-disk-space' }, { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'check-disk-space' }] });   // ASS-288: Check Disk Space, then Check Harness
  sameShared(v2, flat, { as: s => (s.id === 'assess' ? { ...s, action: { ...s.action, prompt: 'assess-health' } } : s) });   // ASS-288: its own Assess Health prompt
  assert.ok(inOrder(v2.steps.toSorted((a, b) => a.sequence - b.sequence).map(s => s.id), ['check-golden-images', 'check-harness']));
  assert.deepEqual(validateStateEngine(v2, ROOT, 'check-health-v2', EXAMPLE_ENGINES), []);
  const runs = name => JSON.stringify(engines[name]).includes('"engine":"check-health-v2"');
  assert.deepEqual(Object.keys(engines).filter(runs), ['example-github-development', TOP]);
  for (const name of ['harness-development', 'harness-development-grouped']) assert.equal(engines[name]['check-health-steps'][0].action.engine, 'check-health', name);
});

// ASS-288 AC2: the health check reports low disk — a script step writing disk.md beside the reports, read by assess-health-v2.
test('ASS-288 AC2: check-health-v2 checks the disk after the golden images — harness:check-disk-space --report on the host, either exit going on to Check Harness — and Assess Health reads disk.md with assess-health-v2, assess-health with that one line more; the flat check-health is unchanged', () => {
  const v2 = engines['check-health-v2'], flat = engines['check-health'];
  assert.deepEqual(working(stepOf(v2, 'check-disk-space')), { id: 'check-disk-space',
    action: { type: 'script', command: './agent.sh harness:check-disk-space --report {project} {run}' },
    'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'check-harness' }, { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'check-harness' }] });
  assert.deepEqual(stepOf(v2, 'check-golden-images')['exit-events'].map(e => e['move-to-state']), ['check-disk-space', 'check-disk-space']);
  assert.equal(stepOf(v2, 'assess').action.prompt, 'assess-health-v2');
  assert.equal(stepOf(flat, 'assess').action.prompt, 'assess-health');
  assert.ok(!JSON.stringify(flat).includes('check-disk-space'));
  const text = name => readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8');
  assert.match(text('assess-health-v2'), /disk\.md when it is there/);
  assert.equal(text('assess-health-v2').split('\n').filter(l => !text('assess-health').split('\n').includes(l)).length, 1);
  const json = name => JSON.parse(readFileSync(join(ROOT, 'prompts', name, 'prompt.json'), 'utf8'));
  assert.deepEqual({ ...json('assess-health-v2'), description: null }, { ...json('assess-health'), description: null });
});

test('ASS-151 AC1: a fast-tracked ticket passes the Review group\'s human steps by itself, each to its approving exit — Human Review to the Token Expense Check, the Payment Gate to Variation Selection; a human\'s choice still comes first, and any other ticket waits for one; Blocked for Human never passes by itself; grouped-review has the same exits, and validate.js accepts them', () => {
  const engine = engines['v2-review'];
  for (const [id, to] of [['human-review', 'token-expense-check'], ['payment-gate', 'variation-selection']]) {
    const step = stepOf(engine, id);
    assert.deepEqual(step['exit-events'].at(-1), { condition: { 'fast-tracked': true }, 'move-to-state': to }, id);
    assert.equal(nextState(step, engine, { fastTracked: true }).to, to, id);
    assert.equal(nextState(step, engine, { fastTracked: false }), null, id);
    assert.equal(nextState(step, engine, {}), null, id);
    assert.equal(nextState(step, engine, { fastTracked: true, humanReview: { state: id, decision: 'Rejected' } }).to, 'replan', id);
  }
  sameShared(engine, engines['grouped-review'], { as: switchedOn, asReference: toHumanReview });   // but for Human Review and Payment Gate switched off (ASS-192), and grouped-review's Human Review gone (ASS-314)
  const stuck = stepOf(engines[TOP], 'blocked-for-human');
  assert.equal(nextState(stuck, engines[TOP], { fastTracked: true }), null);
  assert.deepEqual(reviewRun({ ...SPENDS, fastTracked: true, humanReview: () => undefined }), ['explain-the-change', 'risk-assessment', 'human-review', 'token-expense-check', 'payment-gate', 'variation-selection', 'done']);
  assert.deepEqual(validateStateEngine(engine, ROOT, 'v2-review', EXAMPLE_ENGINES), []);
});
