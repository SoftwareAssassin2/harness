// Pure reading of a state engine: steps, conditions, exits, max-visits, the return-to-state walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inOrder, engineDir } from '../support/engine-walk.js';
import { join } from 'node:path';
import {
  stepOf, evaluateCondition, firstExit, resolveTarget, visitsInto, nextState, sinceResolution,
  isDoneStep, pairedStatus, isPlanning, isBlockedState, isHumanStep, waitsOnHuman, engineSteps, statusOf, inPlanning, isOpenQuestion, blocksTicket, answersGap,
} from '../../src/control/engine.js';
import * as control from '../../src/control/engine.js';
import { levelChanges } from '../../src/control/moves.js';

const updated = { 'file-updated': { file: 'plan.md', since: 'turn-start' } };
const engine = {
  'check-health-steps': [
    { id: 'check-health', sequence: 1, action: { type: 'state-engine', engine: 'check-health' }, 'exit-events': [{ condition: { 'is-done': true } }] },
  ],
  steps: [
    { id: 'blocked-for-human', sequence: 0, area: 'quarantine', 'follow-return-to-state': true, 'is-blocked-state': true, 'paired-ticket-system-status': 'Blocked',
      action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }] },
    { id: 'blocked', sequence: 0, area: 'quarantine', 'max-visits': 3, 'on-max-visits': 'blocked-for-human', 'follow-return-to-state': true, 'paired-ticket-system-status': 'Blocked',
      action: { type: 'state-engine', engine: 'blocked' }, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }] },
    { id: 'committed', sequence: 1, 'is-planning-stage': true, 'paired-ticket-system-status': 'To Do', action: { type: 'none' },
      'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'plan' }] },
    { id: 'plan', sequence: 2, 'is-planning-stage': true, 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'plan', action: { type: 'prompt', prompt: 'plan' },
      'exit-events': [
        { condition: { all: [{ 'turn-complete': true }, updated] }, 'move-to-state': 'build' },
        { condition: { all: [{ 'turn-complete': true }, { not: updated }] }, 'move-to-state': 'plan' },
      ] },
    { id: 'build', sequence: 3, 'max-visits': 2, 'on-max-visits': 'blocked', 'return-to-state': 'build', 'paired-ticket-system-status': 'In Progress',
      action: { type: 'prompt', prompt: 'build', 'agent-count': 2 }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'review' }] },
    { id: 'review', sequence: 4, 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'review', action: { type: 'prompt', prompt: 'review' },
      'exit-events': [
        { condition: { all: [{ 'turn-complete': true }, { 'structured-output': { 'is-approved': true } }] }, 'move-to-state': 'test' },
        { condition: { all: [{ 'turn-complete': true }, { 'structured-output': { 'is-approved': false } }] }, 'move-to-state': 'build' },
      ] },
    { id: 'pick', sequence: 4.5, action: { type: 'prompt', prompt: 'pick' },
      'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state-from-structured-output': 'next' }] },
    { id: 'test', sequence: 5, 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'test', action: { type: 'state-engine', engine: 'test' },
      'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'gate' }] },
    { id: 'gate', sequence: 6, action: { type: 'human' },
      'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'done' }, { condition: { 'human-review': 'Rejected' }, 'move-to-state': 'build' }] },
    { id: 'done', sequence: 7, 'is-done': true, 'paired-ticket-system-status': 'Done', action: { type: 'none' } },
  ],
};
const step = id => stepOf(engine, id);
const change = (from, to, extra = {}) => ({ 'state-engine': 'e', 'from-state': from, 'to-state': to, timestamp: '2026-10-10T00:00:00Z', 'work-is-done': false, 'agent-dispatch-log': [], ...extra });

test('stepOf finds a step in steps or in any *-steps / *-trigger list, else undefined', () => {
  assert.equal(step('build').sequence, 3);
  assert.equal(step('check-health').action.engine, 'check-health');
  assert.equal(stepOf({ 'self-healing-trigger': [{ id: 'heal' }] }, 'heal').id, 'heal');
  assert.equal(step('nope'), undefined);
  assert.equal(stepOf({ 'other-list': [{ id: 'x' }] }, 'x'), undefined);
});

test('the smoke test against the real example-development engine', () => {
  const real = JSON.parse(readFileSync(join(engineDir('example-development'), 'state-engine.json'), 'utf8'));
  assert.equal(stepOf(real, 'generate-solution').action.type, 'prompt');
  assert.equal(pairedStatus(real, 'generate-solution'), 'In Progress');
});

test('evaluateCondition: the simple leaves read their fact', () => {
  assert.equal(evaluateCondition({ always: true }, {}), true);
  assert.equal(evaluateCondition({ 'agent-needs-work': true }, { agentNeedsWork: true }), true);
  assert.equal(evaluateCondition({ 'agent-needs-work': true }, {}), false);
  assert.equal(evaluateCondition({ 'turn-complete': true }, { turnComplete: true }), true);
  assert.equal(evaluateCondition({ 'turn-complete': true }, { turnComplete: false }), false);
  assert.equal(evaluateCondition({ 'exit-code': 0 }, { exitCode: 0 }), true);
  assert.equal(evaluateCondition({ 'exit-code': 0 }, { exitCode: 1 }), false);
  assert.equal(evaluateCondition({ 'exit-code': 0 }, {}), false);
  assert.equal(evaluateCondition({ 'ticket-system-status': 'Done' }, { ticketSystemStatus: 'Done' }), true);
  assert.equal(evaluateCondition({ 'ticket-system-status': 'Done' }, { ticketSystemStatus: 'In Testing' }), false);
});

test('ASS-151 AC1: fast-tracked holds for a fast-tracked ticket (fastTracked), and fast-tracked false for any other', () => {
  assert.equal(evaluateCondition({ 'fast-tracked': true }, { fastTracked: true }), true);
  assert.equal(evaluateCondition({ 'fast-tracked': true }, { fastTracked: false }), false);
  assert.equal(evaluateCondition({ 'fast-tracked': true }, {}), false);
  assert.equal(evaluateCondition({ 'fast-tracked': false }, {}), true);
});

test('evaluateCondition: file-updated and script-succeeds ask the facts, passing the leaf through', () => {
  const asked = [];
  const facts = { fileUpdated: (file, since) => { asked.push([file, since]); return file === 'plan.md'; }, scriptSucceeds: cmd => { asked.push(cmd); return cmd.endsWith('ok'); } };
  assert.equal(evaluateCondition(updated, facts), true);
  assert.equal(evaluateCondition({ 'file-updated': { file: 'other.md', since: 'turn-start' } }, facts), false);
  assert.equal(evaluateCondition({ 'script-succeeds': './agent.sh x:ok' }, facts), true);
  assert.equal(evaluateCondition({ 'script-succeeds': './agent.sh x:fail' }, facts), false);
  assert.deepEqual(asked, [['plan.md', 'turn-start'], ['other.md', 'turn-start'], './agent.sh x:ok', './agent.sh x:fail']);
});

test('evaluateCondition: structured-output and script-output match every key, and fail without output', () => {
  assert.equal(evaluateCondition({ 'structured-output': { 'is-approved': true } }, { structuredOutput: { 'is-approved': true, note: 'x' } }), true);
  assert.equal(evaluateCondition({ 'structured-output': { 'is-approved': true } }, { structuredOutput: { 'is-approved': false } }), false);
  assert.equal(evaluateCondition({ 'structured-output': { a: 1, b: 2 } }, { structuredOutput: { a: 1, b: 3 } }), false);
  assert.equal(evaluateCondition({ 'structured-output': { 'is-approved': true } }, {}), false);
  assert.equal(evaluateCondition({ 'structured-output': { 'is-approved': true } }, { structuredOutput: null }), false);
  assert.equal(evaluateCondition({ 'script-output': { 'needs-attention': false, 'auto-merge': false } }, { scriptOutput: { 'needs-attention': false, 'auto-merge': false, reasons: [] } }), true);
  assert.equal(evaluateCondition({ 'script-output': { 'needs-attention': true } }, { scriptOutput: { 'needs-attention': false } }), false);
  assert.equal(evaluateCondition({ 'script-output': { 'needs-attention': true } }, {}), false);
});

test('evaluateCondition: human-review and variation-selected hold only at the step they were recorded at', () => {
  assert.equal(evaluateCondition({ 'human-review': 'Approved' }, { stepId: 'gate', humanReview: { state: 'gate', decision: 'Approved' } }), true);
  assert.equal(evaluateCondition({ 'human-review': 'Approved' }, { stepId: 'gate', humanReview: { state: 'gate', decision: 'Rejected' } }), false);
  assert.equal(evaluateCondition({ 'human-review': 'Approved' }, { stepId: 'gate', humanReview: { state: 'other', decision: 'Approved' } }), false);
  assert.equal(evaluateCondition({ 'human-review': 'Approved' }, { stepId: 'gate' }), false);
  assert.equal(evaluateCondition({ 'variation-selected': true }, { stepId: 'pick', selectedVariation: { state: 'pick', variation: 'A' } }), true);
  assert.equal(evaluateCondition({ 'variation-selected': true }, { stepId: 'pick', selectedVariation: { state: 'gate', variation: 'A' } }), false);
  assert.equal(evaluateCondition({ 'variation-selected': true }, { stepId: 'pick' }), false);
});

test('evaluateCondition: has-variations compares "more than one" with the leaf', () => {
  assert.equal(evaluateCondition({ 'has-variations': true }, { variationCount: 2 }), true);
  assert.equal(evaluateCondition({ 'has-variations': false }, { variationCount: 2 }), false);
  assert.equal(evaluateCondition({ 'has-variations': false }, { variationCount: 1 }), true);
  assert.equal(evaluateCondition({ 'has-variations': true }, { variationCount: 1 }), false);
  assert.equal(evaluateCondition({ 'has-variations': false }, {}), true);
});

test('evaluateCondition: is-done and workflow-ended read whether the sub-engine reached a done step', () => {
  assert.equal(evaluateCondition({ 'is-done': true }, { subEngineDone: true }), true);
  assert.equal(evaluateCondition({ 'is-done': true }, { subEngineDone: false }), false);
  assert.equal(evaluateCondition({ 'is-done': true }, {}), false);
  assert.equal(evaluateCondition({ 'is-done': false }, { subEngineDone: false }), true);
  assert.equal(evaluateCondition({ 'workflow-ended': true }, { subEngineDone: true }), true);
  assert.equal(evaluateCondition({ 'workflow-ended': true }, {}), false);
});

test('evaluateCondition: sub-engine-ended-at reads the done step the sub-engine run ended at (ASS-68)', () => {
  assert.equal(evaluateCondition({ 'sub-engine-ended-at': 'blocked' }, { subEngineDone: true, subEngineState: 'blocked' }), true);
  assert.equal(evaluateCondition({ 'sub-engine-ended-at': 'blocked' }, { subEngineDone: true, subEngineState: 'done' }), false);
  assert.equal(evaluateCondition({ 'sub-engine-ended-at': 'blocked' }, {}), false);
});

test('evaluateCondition: structured-ticket-variation-array-check counts the variation member', () => {
  const leaf = { 'structured-ticket-variation-array-check': { 'member-name': 'acceptance-criteria', 'min-length': 1 } };
  assert.equal(evaluateCondition(leaf, { variation: { 'acceptance-criteria': [{}] } }), true);
  assert.equal(evaluateCondition(leaf, { variation: { 'acceptance-criteria': [] } }), false);
  assert.equal(evaluateCondition(leaf, { variation: {} }), false);
  assert.equal(evaluateCondition(leaf, {}), false);
  assert.equal(evaluateCondition({ 'structured-ticket-variation-array-check': { 'member-name': 'x', 'min-length': 0 } }, {}), true);
});

test('evaluateCondition: all and not combine, nested', () => {
  const facts = { turnComplete: true, fileUpdated: () => false };
  assert.equal(evaluateCondition({ all: [{ 'turn-complete': true }, { not: updated }] }, facts), true);
  assert.equal(evaluateCondition({ all: [{ 'turn-complete': true }, updated] }, facts), false);
  assert.equal(evaluateCondition({ all: [] }, {}), true);
  assert.equal(evaluateCondition({ not: { all: [{ always: true }, { not: { always: true } }] } }, {}), true);
});

// ASS-282: ticket-system-status null is "not known" — none synced (null) or none on the facts at all (undefined) — so a
// condition can wait for a known status: { not: { ticket-system-status: null } }.
test('ASS-282: ticket-system-status null matches an unknown status, null or missing, and nothing known', () => {
  const known = { not: { 'ticket-system-status': null } };
  for (const facts of [{}, { ticketSystemStatus: null }, { ticketSystemStatus: undefined }]) {
    assert.equal(evaluateCondition({ 'ticket-system-status': null }, facts), true, JSON.stringify(facts));
    assert.equal(evaluateCondition(known, facts), false, JSON.stringify(facts));
  }
  assert.equal(evaluateCondition(known, { ticketSystemStatus: 'On Hold' }), true);
  assert.equal(evaluateCondition({ 'ticket-system-status': null }, { ticketSystemStatus: 'Done' }), false);
});

// ASS-282: a sub-engine step's exit on the status built with all / not (any status but Done and In Testing) answers the gap
// as a plain one does; an exit that reads anything but the status (a script, a sub-engine) never does, whatever the status.
test('ASS-282: answersGap reads an exit on the ticket system status built with all and not; an exit on other facts answers no gap', () => {
  const parent = { steps: [{ id: 'qa', 'paired-ticket-system-status': 'In Testing', action: { type: 'state-engine', engine: 'qa' } }] };
  const sub = conditions => ({ qa: { steps: [{ id: 'testing', action: { type: 'none' }, 'exit-events': conditions.map(condition => ({ condition, 'move-to-state': 'done' })) }, { id: 'done', 'is-done': true }] } });
  const at = { 'harness-status': { 'state-engine': 'top', state: 'qa', 'sub-status': { 'state-engine': 'qa', state: 'testing' } } };
  const parked = { all: [{ not: { 'ticket-system-status': 'Done' } }, { not: { 'ticket-system-status': 'In Testing' } }, { not: { 'ticket-system-status': null } }] };
  for (const [status, answered] of [['On Hold', true], ['In Progress', true], ['Done', false], ['In Testing', false]]) assert.equal(answersGap(parent, at, status, sub([parked])), answered, status);
  assert.equal(answersGap(parent, at, 'Done', sub([{ 'ticket-system-status': 'Done' }, parked])), true);
  for (const other of [{ not: { 'exit-code': 0 } }, { 'is-done': false }, { all: [{ not: { 'ticket-system-status': 'Done' } }, { 'exit-code': 0 }] }, { always: true }]) {
    assert.equal(answersGap(parent, at, 'On Hold', sub([other])), false, JSON.stringify(other));
  }
});

test('evaluateCondition throws on an unknown leaf', () => {
  assert.throws(() => evaluateCondition({ 'no-such-leaf': true }, {}), /no-such-leaf/);
});

test('firstExit returns the first exit whose condition holds, with the step id in the facts, else null', () => {
  const facts = { turnComplete: true, fileUpdated: () => false };
  assert.equal(firstExit(step('plan'), facts)['move-to-state'], 'plan');
  assert.equal(firstExit(step('plan'), { ...facts, fileUpdated: () => true })['move-to-state'], 'build');
  assert.equal(firstExit(step('plan'), { turnComplete: false, fileUpdated: () => true }), null);
  assert.equal(firstExit(step('gate'), { humanReview: { state: 'gate', decision: 'Rejected' } })['move-to-state'], 'build');
  assert.equal(firstExit(step('gate'), { humanReview: { state: 'build', decision: 'Rejected' } }), null);
  assert.equal(firstExit(step('done'), { turnComplete: true }), null);
});

test('resolveTarget: move-to-state wins; move-to-state-from-structured-output reads the output field', () => {
  assert.equal(resolveTarget({ 'move-to-state': 'review', 'follow-return-to-state': true }, step('build'), engine, []), 'review');
  const pick = step('pick')['exit-events'][0];
  assert.equal(resolveTarget(pick, step('pick'), engine, [], { structuredOutput: { next: 'test' } }), 'test');
  assert.equal(resolveTarget(pick, step('pick'), engine, [], { structuredOutput: {} }), null);
  assert.equal(resolveTarget(pick, step('pick'), engine, []), null);
});

test('ASS-231: move-to-state-from-structured-output names no step of the engine (missing or unknown) — the exit\'s move-to-state, its fallback; none, unresolved', () => {
  const exit = { 'move-to-state-from-structured-output': 'next', 'move-to-state': 'build' };
  assert.equal(resolveTarget(exit, step('pick'), engine, [], { structuredOutput: { next: 'plan' } }), 'plan');
  assert.equal(resolveTarget(exit, step('pick'), engine, [], { structuredOutput: { next: 'nowhere' } }), 'build');
  assert.equal(resolveTarget(exit, step('pick'), engine, [], { structuredOutput: {} }), 'build');
  assert.equal(resolveTarget(exit, step('pick'), engine, []), 'build');
  assert.equal(resolveTarget({ 'move-to-state-from-structured-output': 'next' }, step('pick'), engine, [], { structuredOutput: { next: 'nowhere' } }), null);
});

test('ASS-228: move-to-state-from-human-review reads the named field of the human\'s choice (a Human Review rejection\'s return-to) — a step of the engine, else the exit\'s move-to-state, its fallback', () => {
  const exit = { 'move-to-state-from-human-review': 'return-to', 'move-to-state': 'build' };
  assert.equal(resolveTarget(exit, step('gate'), engine, [], { humanReview: { decision: 'Rejected', 'return-to': 'plan' } }), 'plan');
  assert.equal(resolveTarget(exit, step('gate'), engine, [], { humanReview: { decision: 'Rejected', 'return-to': 'write-execution-plan' } }), 'build');
  assert.equal(resolveTarget(exit, step('gate'), engine, [], { humanReview: { decision: 'Rejected' } }), 'build');
  assert.equal(resolveTarget(exit, step('gate'), engine, [], { structuredOutput: { 'return-to': 'plan' } }), 'build', 'the human\'s choice, not an agent\'s output');
});

test('resolveTarget: follow-return-to-state walks the history back, through blocked, to the return-to-state', () => {
  const exit = { 'follow-return-to-state': true };
  // build sent it to blocked: build's return-to-state.
  assert.equal(resolveTarget(exit, step('blocked'), engine, [change('plan', 'build'), change('build', 'blocked')]), 'build');
  // blocked sent it on to blocked-for-human: blocked follows the return itself, so the walk goes on to build.
  const viaBlocked = [change('plan', 'build'), change('build', 'blocked'), change('blocked', 'blocked-for-human')];
  assert.equal(resolveTarget(exit, step('blocked-for-human'), engine, viaBlocked), 'build');
  // the latest arrival counts, not an earlier one.
  assert.equal(resolveTarget(exit, step('blocked'), engine, [change('plan', 'blocked'), change('blocked', 'plan'), change('plan', 'build'), change('build', 'blocked')]), 'build');
  // a step with neither return-to-state nor follow-return-to-state is itself the target.
  assert.equal(resolveTarget(exit, step('blocked'), engine, [change('committed', 'blocked')]), 'committed');
  // history that does not say.
  assert.equal(resolveTarget(exit, step('blocked'), engine, []), null);
  assert.equal(resolveTarget(exit, step('blocked'), engine, [change('plan', 'build')]), null);
  assert.equal(resolveTarget({ 'follow-return-to': true }, step('blocked'), engine, [change('build', 'blocked')]), 'build');   // the older spelling
});

test('visitsInto counts arrivals at the top level, plus the state the history starts in', () => {
  const changes = [change('plan', 'build'), change('build', 'review'), change('review', 'build')];
  assert.equal(visitsInto(changes, 'build'), 2);
  assert.equal(visitsInto(changes, 'plan'), 1);
  assert.equal(visitsInto(changes, 'review'), 1);
  assert.equal(visitsInto(changes, 'done'), 0);
  assert.equal(visitsInto([], 'plan'), 0);
  assert.equal(visitsInto([], 'plan', 'plan'), 1);
  assert.equal(visitsInto([], 'plan', 'build'), 0);
  assert.equal(visitsInto(undefined, 'plan'), 0);
});

test('nextState moves by the first matching exit', () => {
  assert.deepEqual(nextState(step('build'), engine, { turnComplete: true }, []), { to: 'review', exit: step('build')['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step('build'), engine, { turnComplete: false }, []), null);
  assert.equal(nextState(step('done'), engine, { turnComplete: true }, []), null);
  assert.equal(nextState(step('committed'), engine, { agentNeedsWork: true }, []).to, 'plan');
  assert.equal(nextState(step('committed'), engine, { agentNeedsWork: false }, []), null);
});

test('nextState redirects to on-max-visits once the target has been visited max-visits times', () => {
  const rejected = { turnComplete: true, structuredOutput: { 'is-approved': false } };
  const once = [change('plan', 'build'), change('build', 'review')];
  assert.deepEqual(nextState(step('review'), engine, rejected, once), { to: 'build', exit: step('review')['exit-events'][1], reason: 'exit' });
  const twice = [...once, change('review', 'build'), change('build', 'review')];
  assert.deepEqual(nextState(step('review'), engine, rejected, twice), { to: 'blocked', exit: step('review')['exit-events'][1], reason: 'max-visits' });
  // a history that starts in the target counts that stay as a visit.
  assert.equal(nextState(step('review'), engine, rejected, [change('build', 'review'), change('review', 'build'), change('build', 'review')]).reason, 'max-visits');
  // the redirect itself is capped: blocked three times already → blocked-for-human.
  const blockedThrice = [...twice, change('review', 'blocked'), change('blocked', 'build'), change('build', 'blocked'), change('blocked', 'build'), change('build', 'blocked'), change('blocked', 'review')];
  assert.deepEqual(nextState(step('review'), engine, rejected, blockedThrice), { to: 'blocked-for-human', exit: step('review')['exit-events'][1], reason: 'max-visits' });
});

// The engine with blocked-for-human's second exit: Have AI Try Again, back to blocked.
const retrying = { steps: engine.steps.map(s => s.id !== 'blocked-for-human' ? s
  : { ...s, 'exit-events': [...s['exit-events'], { condition: { 'human-review': 'Have AI Try Again' }, 'move-to-state': 'blocked' }] }) };

test('sinceResolution: the changes from the last time a human resolved Blocked for Human, else all of them', () => {
  const before = [change('plan', 'build'), change('build', 'blocked'), change('blocked', 'blocked-for-human')];
  const resolved = change('blocked-for-human', 'build');
  assert.deepEqual(sinceResolution(retrying, [...before, resolved, change('build', 'review')]), [resolved, change('build', 'review')]);
  assert.deepEqual(sinceResolution(retrying, before), before);                                             // never resolved: the whole history
  assert.deepEqual(sinceResolution(retrying, [...before, change('blocked-for-human', 'blocked')]).length, 4);   // Have AI Try Again is no resolution
  assert.deepEqual(sinceResolution(retrying), []);
});

test('nextState: after a human resolves Blocked for Human, every step\'s visits count afresh — the return walk still reads the whole history', () => {
  const rejected = { turnComplete: true, structuredOutput: { 'is-approved': false } };
  const capped = [change('plan', 'build'), change('build', 'review'), change('review', 'build'), change('build', 'review'),
    change('review', 'blocked'), change('blocked', 'review'), change('review', 'blocked'), change('blocked', 'review'), change('review', 'blocked'), change('blocked', 'blocked-for-human')];
  assert.equal(nextState(step('review'), retrying, rejected, [...capped, change('blocked-for-human', 'review')]).to, 'build');   // build and blocked were at their caps
  assert.equal(nextState(step('review'), retrying, rejected, [...capped, change('blocked-for-human', 'blocked'), change('blocked', 'review')]).to, 'blocked-for-human');   // a retry keeps the count
  const out = nextState(stepOf(retrying, 'blocked-for-human'), retrying, { humanReview: { state: 'blocked-for-human', decision: 'Resolved' } }, capped);
  assert.equal(out.to, 'review');   // where it came from, through blocked, by the whole history
});

// A pass through a group step: into it, then moves within its run (sub-state-change), then on.
const within = (state, from, to) => change(state, state, { 'sub-state-change': { 'state-engine': `sub-${state}`, 'from-state': from, 'to-state': to } });
const pass = (from, state, to) => [change(from, state), within(state, null, 'a'), within(state, 'a', 'b'), within(state, 'b', 'done'), change(state, to)];

test('visitsInto: a change made within a state (sub-state-change) is no visit — one pass through a group counts once (ASS-130)', () => {
  assert.equal(visitsInto(pass('committed', 'test', 'gate'), 'test'), 1);
  assert.equal(visitsInto([...pass('committed', 'test', 'gate'), ...pass('gate', 'test', 'gate')], 'test'), 2);
});

test('sinceResolution: the changes from the last move out of a done step — a ticket reopened from Done counts afresh (ASS-130)', () => {
  const run = [change('committed', 'plan'), change('plan', 'build'), change('build', 'done')];
  const reopened = change('done', 'committed');
  assert.deepEqual(sinceResolution(engine, [...run, reopened, change('committed', 'plan')]), [reopened, change('committed', 'plan')]);
  assert.deepEqual(sinceResolution(engine, run), run);   // never reopened: the whole history
  // the later of a reopening and a resolution counts.
  const resolved = change('blocked-for-human', 'plan');
  assert.deepEqual(sinceResolution(engine, [...run, reopened, change('plan', 'blocked-for-human'), resolved]), [resolved]);
});

// ASS-264: a step with restarts-visit-count (example GitHub project's Too Large) — a move out of it counts afresh, as one out of Done does.
test('sinceResolution: the changes from the last move out of a step with restarts-visit-count (ASS-264)', () => {
  const restarting = { steps: [...engine.steps, { id: 'too-large', sequence: 9, action: { type: 'human' }, 'restarts-visit-count': true }] };
  const run = [change('committed', 'plan'), change('plan', 'build'), change('build', 'too-large')];
  const returned = change('too-large', 'plan');
  assert.deepEqual(sinceResolution(restarting, [...run, returned, change('plan', 'build')]), [returned, change('plan', 'build')]);
  assert.deepEqual(sinceResolution(restarting, run), run);
  assert.deepEqual(sinceResolution(engine, [...run, returned]), [...run, returned]);   // without the flag: no restart
});

// ASS-309 AC2: a block cleared by a landed fix (grouped-blocked's await-fix, whose
// ticket:fix-landed output says landed) restarts the step-visit window, as a human's
// resolution of Blocked for Human does — else the counts it was blocked with send it
// straight back to Blocked (ASS-303: build 5/5, test 3/3). The clear is marked on the
// change it makes (cause "fix-landed"), so the moves after it count afresh too.
const v2 = () => JSON.parse(readFileSync(join(engineDir('harness-development-v2'), 'state-engine.json'), 'utf8'));
// ASS-303's shape: Build entered 5 times and Test 3 times, both at their max-visits, then Blocked.
const exhausted = [change('plan', 'build'), change('build', 'test'), change('test', 'build'), change('build', 'test'),
  change('test', 'build'), change('build', 'test'), change('test', 'build'), change('build', 'blocked'),
  change('blocked', 'build'), change('build', 'blocked')];
const landed = { subEngineDone: true, subEngineState: 'done', structuredOutput: { landed: true } };
const retried = { subEngineDone: true, subEngineState: 'done' };

test('sinceResolution: the changes from the last block cleared by a landed fix — its change\'s cause (ASS-309)', () => {
  const cleared = change('blocked', 'build', { cause: 'fix-landed' });
  assert.deepEqual(sinceResolution(v2(), [...exhausted, cleared, change('build', 'test')]), [cleared, change('build', 'test')]);
  assert.deepEqual(sinceResolution(v2(), [...exhausted, change('blocked', 'build')]).length, exhausted.length + 1);   // no cause: no restart
  assert.deepEqual(sinceResolution(v2(), exhausted), exhausted);
});

test('nextState (ASS-309 AC2): a landed fix clears Blocked back to Build though Build and Test are at their max-visits; a retry keeps the count', () => {
  const v2Engine = v2(), blocked = stepOf(v2Engine, 'blocked');
  assert.deepEqual(nextState(blocked, v2Engine, landed, exhausted), { to: 'build', exit: blocked['exit-events'].at(-1), reason: 'exit' });
  // No landed fix: the counts stand, so the return to Build redirects back to Blocked (the ASS-303 loop).
  assert.deepEqual(nextState(blocked, v2Engine, retried, exhausted), { to: 'blocked', exit: blocked['exit-events'].at(-1), reason: 'max-visits' });
  assert.equal(nextState(blocked, v2Engine, { ...landed, structuredOutput: { landed: false } }, exhausted).reason, 'max-visits');
});

test('nextState (ASS-309 AC2): after the clearing change\'s cause is recorded, the next exit counts afresh too — Build moves on to Test', () => {
  const v2Engine = v2(), build = stepOf(v2Engine, 'build');
  const changes = [...exhausted, change('blocked', 'build', { cause: 'fix-landed' })];
  assert.deepEqual(nextState(build, v2Engine, retried, changes), { to: 'test', exit: build['exit-events'].at(-1), reason: 'exit' });
  assert.equal(nextState(build, v2Engine, retried, exhausted).to, 'blocked');   // without the clear: Test is at its cap
});

// ASS-315: a merge-gate red — v2-release's merge-pull-request failing the gate (npm test red on
// the rebased branch, or no clean rebase) ends its run at rebuild, and release's exit for it sends
// the ticket back to Build. That return trip is no fault of Build, Test, Document or Review, so the
// exit marks the move it makes (its own "cause": merge-gate-red, in the engine JSON) and the visit
// window restarts there for them — never for release itself, whose max-visits (3) still bounds a
// gate that never goes green (ASS-311: a green, cleanly rebased change sent to Blocked at Build's
// exit because two reds had left Test at 3/3). ASS-311's shape is reconstructed here with change():
// its real state-changes are not reachable from a ticket VM.
const GATE_RED = 'merge-gate-red';
const gateRed = () => change('release', 'build', { cause: GATE_RED });
const rebuilt = { subEngineDone: true, subEngineState: 'rebuild' };
const lastExit = step => step['exit-events'].at(-1);
const rebuildExit = step => step['exit-events'].find(e => (e.condition.all ?? []).some(c => c['sub-engine-ended-at'] === 'rebuild'));
// ASS-311's shape: a pass through Build and Test with `fails` Test→Build rebuilds (so Test is at
// its max-visits with fails 2), then on through Document and Review to Release.
const toRelease = (fails = 2) => [change('plan', 'build'),
  ...Array.from({ length: fails }, () => [change('build', 'test'), change('test', 'build')]).flat(),
  change('build', 'test'), change('test', 'document'), change('document', 'review'), change('review', 'release')];
// A ticket at Review, having taken `reds` gate reds on the way (each red its own return to Build).
const lap = [change('build', 'test'), change('test', 'document'), change('document', 'review')];
const atReview = reds => [change('plan', 'build'), ...Array.from({ length: reds }, () => [...lap, change('review', 'release'), gateRed()]).flat(), ...lap];

test('ASS-315 AC1: the real harness-development-v2 marks release\'s rebuild exit merge-gate-red; test\'s own rebuild exit is unmarked', () => {
  const real = v2();
  assert.equal(rebuildExit(stepOf(real, 'release')).cause, GATE_RED);
  assert.equal(control.MERGE_GATE_RED?.cause, GATE_RED);                 // the JSON flag and the JS constant are the one string
  assert.equal(rebuildExit(stepOf(real, 'test')).cause, undefined);      // a real test failure still spends a Test visit (AC3)
});

test('ASS-315 AC1: sinceResolution restarts the window at a merge-gate-red change for every step but the one it left (release)', () => {
  const red = gateRed(), after = change('build', 'test');
  const changes = [...toRelease(), red, after];
  for (const target of ['build', 'test', 'document', 'review']) assert.deepEqual(sinceResolution(v2(), changes, target), [red, after], target);
  assert.deepEqual(sinceResolution(v2(), changes, 'release'), changes);   // release's own visits keep accumulating across reds (AC2)
  assert.deepEqual(sinceResolution(v2(), changes), [red, after]);         // no target named (the TUI's caller): restarts, as its counts always have
  const resolved = change('blocked-for-human', 'test');                   // the latest boundary wins: a human's resolution after the red
  assert.deepEqual(sinceResolution(v2(), [...changes, change('test', 'blocked-for-human'), resolved], 'test'), [resolved]);
});

test('ASS-315 AC1: ASS-311\'s shape — the gate red\'s return to Build moves Build\'s done exit on to Test, not to Blocked', () => {
  const real = v2(), build = stepOf(real, 'build');
  const changes = [...toRelease(), gateRed()];                            // Test stood at 3/3 when the gate went red
  assert.equal(visitsInto(changes, 'test'), 3);
  assert.deepEqual(nextState(build, real, retried, changes), { to: 'test', exit: lastExit(build), reason: 'exit' });
  const unmarked = [...toRelease(), change('release', 'build')];          // the same history with no cause on the red: the bug ASS-311 hit
  assert.deepEqual(nextState(build, real, retried, unmarked), { to: 'blocked', exit: lastExit(build), reason: 'max-visits' });
});

test('ASS-315 AC1: the gate-red move itself counts from none — the first red returns to Build though Build is at its max-visits', () => {
  const real = v2(), release = stepOf(real, 'release');
  const changes = toRelease(4);                                           // Build entered 5 times: its max-visits, and no gate-red change yet
  assert.equal(visitsInto(changes, 'build'), 5);
  assert.deepEqual(nextState(release, real, rebuilt, changes), { to: 'build', exit: rebuildExit(release), reason: 'exit' });
});

test('ASS-315 AC1: after a gate red the steps downstream of Build count afresh too — Test moves on to Document, Document on to Review', () => {
  const real = v2(), laps = Array.from({ length: 3 }, () => [...lap, change('review', 'build')]).flat();
  const before = [change('plan', 'build'), ...laps, ...lap, change('review', 'release')];
  assert.equal(visitsInto(before, 'document'), 4);                        // both past their max-visits (3) when the gate went red
  assert.equal(visitsInto(before, 'review'), 4);
  const changes = [...before, gateRed(), change('build', 'test')];
  assert.deepEqual(nextState(stepOf(real, 'test'), real, retried, changes), { to: 'document', exit: lastExit(stepOf(real, 'test')), reason: 'exit' });
  const onward = [...changes, change('test', 'document')];
  assert.deepEqual(nextState(stepOf(real, 'document'), real, retried, onward), { to: 'review', exit: lastExit(stepOf(real, 'document')), reason: 'exit' });
});

test('ASS-315 AC2: release\'s own visits count across gate reds — a third red still sends the ticket to Blocked, a second does not', () => {
  const real = v2(), review = stepOf(real, 'review'), thrice = atReview(3);
  assert.deepEqual(nextState(review, real, retried, atReview(2)), { to: 'release', exit: lastExit(review), reason: 'exit' });
  assert.deepEqual(nextState(review, real, retried, thrice), { to: 'blocked', exit: lastExit(review), reason: 'max-visits' });
  assert.equal(visitsInto(sinceResolution(real, thrice, 'release'), 'release'), 3);   // every red counted for release
  assert.equal(visitsInto(sinceResolution(real, thrice, 'test'), 'test'), 1);         // for Test, only the pass since the last red
});

test('ASS-315 AC2: a human\'s resolution of Blocked for Human still counts release\'s visits afresh', () => {
  const real = v2(), review = stepOf(real, 'review');
  const resolved = [...atReview(3), change('review', 'blocked-for-human'), change('blocked-for-human', 'review')];
  assert.deepEqual(nextState(review, real, retried, resolved), { to: 'release', exit: lastExit(review), reason: 'exit' });
});

test('ASS-315 AC3: a rebuild that is no gate red still spends its step\'s visit — Test\'s and Review\'s own returns to Build count as before', () => {
  const real = v2(), build = stepOf(real, 'build');
  const testFails = [change('plan', 'build'), ...Array.from({ length: 3 }, () => [change('build', 'test'), change('test', 'build')]).flat()];
  assert.equal(visitsInto(testFails, 'test'), 3);
  assert.deepEqual(nextState(build, real, retried, testFails), { to: 'blocked', exit: lastExit(build), reason: 'max-visits' });
  const reviewFails = [change('plan', 'build'), ...Array.from({ length: 3 }, () => [...lap, change('review', 'build')]).flat()];
  assert.equal(visitsInto(reviewFails, 'test'), 3);
  assert.deepEqual(nextState(build, real, retried, reviewFails), { to: 'blocked', exit: lastExit(build), reason: 'max-visits' });
});

test('nextState: a ticket reopened from Done moves on without hitting max-visits; real repeated visits since still hit it (ASS-130)', () => {
  const run = [...pass('committed', 'test', 'gate'), change('gate', 'done')];
  const thrice = [...run, change('done', 'committed'), ...run, change('done', 'committed'), ...run, change('done', 'committed'), change('committed', 'build'), change('build', 'review')];
  assert.deepEqual(nextState(step('review'), engine, { turnComplete: true, structuredOutput: { 'is-approved': true } }, thrice), { to: 'test', exit: step('review')['exit-events'][0], reason: 'exit' });
  const again = [...thrice, ...pass('review', 'test', 'build'), change('build', 'review'), ...pass('review', 'test', 'build'), change('build', 'review')];
  assert.equal(nextState(step('review'), engine, { turnComplete: true, structuredOutput: { 'is-approved': true } }, again).to, 'test');   // 2 since: under 3
  const capped = [...again, ...pass('review', 'test', 'build'), change('build', 'review')];
  assert.deepEqual(nextState(step('review'), engine, { turnComplete: true, structuredOutput: { 'is-approved': true } }, capped), { to: 'blocked', exit: step('review')['exit-events'][0], reason: 'max-visits' });
});

test('ASS-125\'s real history (harness-development-v2, its third run): Setup\'s run done moves it on to Plan, not to Blocked (ASS-130)', () => {
  const v2 = JSON.parse(readFileSync(join(import.meta.dirname, '../../engines/harness-development-v2/state-engine.json'), 'utf8'));
  const history = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/ass-125-state-changes.json'), 'utf8')).slice(0, -1);   // before its move to Blocked for Human
  assert.equal(visitsInto(history, 'plan'), 2);   // two real passes, six changes into it
  const done = { subEngineDone: true, subEngineState: 'done' };
  assert.deepEqual(nextState(stepOf(v2, 'setup'), v2, done, history), { to: 'plan', exit: stepOf(v2, 'setup')['exit-events'].at(-1), reason: 'exit' });
  assert.equal(nextState(stepOf(v2, 'setup'), v2, done, levelChanges({ 'state-changes': history })).to, 'plan');   // as control reads it (steps.js)
  // reopened once more: its fourth Setup counts afresh (three before it).
  const reopened = [...history, change('setup', 'plan'), change('plan', 'done'), change('done', 'committed')];
  assert.equal(nextState(stepOf(v2, 'committed'), v2, { agentNeedsWork: true }, reopened).to, 'setup');
});

test('nextState follows the return-to-state out of blocked when its sub-engine is done', () => {
  const changes = [change('plan', 'build'), change('build', 'blocked')];
  assert.deepEqual(nextState(step('blocked'), engine, { subEngineDone: true }, changes), { to: 'build', exit: step('blocked')['exit-events'][0], reason: 'exit' });
  assert.equal(nextState(step('blocked'), engine, { subEngineDone: false }, changes), null);
  assert.deepEqual(nextState(step('blocked'), engine, { subEngineDone: true }, []), { to: null, exit: step('blocked')['exit-events'][0], reason: 'unresolved' });
});

test('nextState takes the target from structured output when the exit says so', () => {
  assert.equal(nextState(step('pick'), engine, { turnComplete: true, structuredOutput: { next: 'review' } }, []).to, 'review');
  assert.equal(nextState(step('pick'), engine, { turnComplete: true, structuredOutput: {} }, []).reason, 'unresolved');
});

test('isDoneStep, pairedStatus, isPlanning, isBlockedState, isHumanStep read the step flags', () => {
  assert.equal(isDoneStep(engine, 'done'), true);
  assert.equal(isDoneStep(engine, 'build'), false);
  assert.equal(isDoneStep(engine, 'nope'), false);
  assert.equal(pairedStatus(engine, 'build'), 'In Progress');
  assert.equal(pairedStatus(engine, 'plan'), undefined);
  assert.equal(pairedStatus(engine, 'nope'), undefined);
  assert.equal(isPlanning(engine, 'plan'), true);
  assert.equal(isPlanning(engine, 'build'), false);
  assert.equal(isBlockedState(engine, 'blocked-for-human'), true);
  assert.equal(isBlockedState(engine, 'blocked'), false);
  assert.equal(isHumanStep(engine, 'gate'), true);
  assert.equal(isHumanStep(engine, 'blocked-for-human'), true);
  assert.equal(isHumanStep(engine, 'build'), false);
  assert.equal(isHumanStep(engine, 'nope'), false);
});

test('waitsOnHuman: at a human step, or gated on leaving its state with the work done', () => {
  const at = (state, extra = {}) => ({ 'harness-status': { state, 'state-engine': 'e' }, ...extra });
  assert.equal(waitsOnHuman(engine, at('gate')), true);
  assert.equal(waitsOnHuman(engine, at('blocked-for-human')), true);
  assert.equal(waitsOnHuman(engine, at('build')), false);
  const gated = { 'gate-when-leaving-state': ['e/build'] };
  assert.equal(waitsOnHuman(engine, at('build', { 'gate-when-leaving-state': ['build'], 'state-changes': [change('plan', 'build', { 'work-is-done': true })] })), false);   // a gate names its engine
  assert.equal(waitsOnHuman(engine, at('build', { ...gated, 'state-changes': [change('plan', 'build', { 'work-is-done': true })] })), true);
  assert.equal(waitsOnHuman(engine, at('build', { ...gated, 'state-changes': [change('plan', 'build', { 'work-is-done': false })] })), false);
  assert.equal(waitsOnHuman(engine, at('build', { ...gated, 'state-changes': [] })), false);
  assert.equal(waitsOnHuman(engine, at('build', { ...gated })), false);
  assert.equal(waitsOnHuman(engine, at('review', { ...gated, 'state-changes': [change('build', 'review', { 'work-is-done': true })] })), false);
  // the latest change must be the one into this state.
  assert.equal(waitsOnHuman(engine, at('build', { ...gated, 'state-changes': [change('plan', 'build', { 'work-is-done': true }), change('build', 'review')] })), false);
  assert.equal(waitsOnHuman(engine, { 'harness-status': { state: 'nope' } }), false);
  assert.equal(waitsOnHuman(engine, {}), false);
});

test('ASS-192 AC1: waitsOnHuman — a switched-off step ("is-active": false) waits on no one, human step or gated', () => {
  const off = { steps: engine.steps.map(s => (['gate', 'build'].includes(s.id) ? { ...s, 'is-active': false } : s)) };
  const at = (state, extra = {}) => ({ 'harness-status': { state, 'state-engine': 'e' }, ...extra });
  assert.equal(waitsOnHuman(off, at('gate')), false);
  assert.equal(waitsOnHuman(off, at('build', { 'gate-when-leaving-state': ['e/build'], 'state-changes': [change('plan', 'build', { 'work-is-done': true })] })), false);
});

test('engineSteps picks an engine\'s steps, or one of its *-steps / *-trigger lists, as an engine', () => {
  const engines = { e: engine, harness: { 'self-healing-trigger': [{ id: 'heal' }] } };
  assert.deepEqual(engineSteps(engines, 'e'), { steps: engine.steps });
  assert.deepEqual(engineSteps(engines, 'e/check-health-steps'), { steps: engine['check-health-steps'] });
  assert.deepEqual(engineSteps(engines, 'harness/self-healing-trigger'), { steps: [{ id: 'heal' }] });
  assert.equal(stepOf(engineSteps(engines, 'e/check-health-steps'), 'check-health').id, 'check-health');
  assert.equal(engineSteps(engines, 'nope'), undefined);
  assert.equal(engineSteps(engines, 'e/nope-steps'), undefined);
  assert.equal(engineSteps(engines, 'harness'), undefined);
});

test('the real self-healing engine: its analysis checked independently and classified before a ticket; a fix that needs the operator, or an environment issue, goes to them; any other makes its ticket sprint work at Self Healing, pauses its tickets, and runs on the ticket (self-healing-fix), the harness restarting only on a fix made; the On Hold pairing for the blocked states', () => {
  const real = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
  const healing = real('self-healing');
  // analyze, then an independent check of it, before any ticket is written
  const after = (id, output) => nextState(stepOf(healing, id), healing, { turnComplete: true, structuredOutput: { 'needs-fix': true, 'can-continue-without-fix': false, ...output } })?.to;
  assert.equal(after('analyze', { 'needs-fix': false }), 'done');
  assert.equal(after('analyze', {}), 'verify');
  assert.equal(after('verify', { 'needs-fix': false }), 'done');
  assert.equal(after('verify', { 'can-continue-without-fix': true }), 'done');
  assert.equal(after('verify', {}), 'classify');
  assert.equal(stepOf(healing, 'verify').action.prompt, 'self-healing-verify');
  // ASS-107 AC4: classified as Blocked classifies — each issue its own exit to its ticket, raised where problemOf (fixTicketIn) says; an environment issue's goes to the operator
  assert.equal(stepOf(healing, 'classify').action.prompt, 'classify-issue');
  for (const issue of ['harness', 'project', 'environment']) assert.equal(after('classify', { issue }), 'create-ticket', issue);
  assert.equal(after('classify', {}), undefined, 'an unclassified problem raises no ticket');
  const created = output => nextState(stepOf(healing, 'create-ticket'), healing, { subEngineDone: true, structuredOutput: { 'needs-fix': true, key: 'HD-1', ...output } })?.to;
  assert.equal(created({}), 'file-reports');
  assert.equal(created({ key: '' }), 'done');                                          // no ticket written: nothing to file or fix
  assert.match(stepOf(healing, 'file-reports').action.command, /ticket:adopt-run-folder \{project\} \{ticket\} \{run\}/);
  const filed = (output, exitCode = 0) => nextState(stepOf(healing, 'file-reports'), healing, { exitCode, structuredOutput: { key: 'HD-1', ...output } })?.to;
  assert.equal(filed({ 'needs-human': true }), 'hand-to-human');
  assert.equal(filed({ 'needs-human': false }), 'take-on');
  assert.equal(filed({ 'needs-human': true }, 1), 'hand-to-human');                    // reports left in the run's folder don't stop the fix
  assert.equal(filed({ 'needs-human': false }, 1), 'take-on');
  for (const exitCode of [0, 1]) assert.equal(filed({ 'needs-human': false, issue: 'environment' }, exitCode), 'hand-to-human', `an environment issue is the operator's (${exitCode})`);
  for (const issue of ['harness', 'project']) assert.equal(filed({ 'needs-human': false, issue }), 'take-on', issue);
  assert.equal(nextState(stepOf(healing, 'hand-to-human'), healing, { exitCode: 0 })?.to, 'done');
  // An agent's fix: the ticket becomes sprint work at Self Healing, its tickets paused; the triggered run is over
  assert.match(stepOf(healing, 'take-on').action.command, /self-healing:take-on \{project\} \{ticket\} \{summary\} \{ticket-url\} \{pause-tickets\}/);
  assert.equal(nextState(stepOf(healing, 'take-on'), healing, { exitCode: 0 })?.to, 'done');
  assert.equal(nextState(stepOf(healing, 'take-on'), healing, { exitCode: 1 })?.to, 'done');
  assert.equal(stepOf(healing, 'pause-work'), undefined);
  assert.equal(stepOf(healing, 'apply-fix'), undefined);
  // The fix runs on the ticket, under example-development's Self Healing step, like any ticket's sub-engine
  const dev = real('example-development');
  const step = stepOf(dev, 'self-healing');
  assert.deepEqual([step.action, step['paired-ticket-system-status'], step.area, step['return-to-state']], [{ type: 'state-engine', engine: 'self-healing-fix' }, 'In Progress', 'quarantine', 'self-healing']);
  const ended = output => nextState(step, dev, { subEngineDone: true, structuredOutput: output })?.to;
  assert.equal(ended({ 'is-fixed': true }), 'done');
  assert.equal(ended({ 'is-fixed': false }), 'blocked-for-human');                 // not fixed: a human looks
  const fix = real('self-healing-fix');
  assert.equal(fix.steps.toSorted((a, b) => a.sequence - b.sequence)[0].id, 'pause-work');   // every attempt pauses its tickets first
  assert.match(stepOf(fix, 'pause-work').action.command, /self-healing:start \{project\} \{ticket\}$/);
  assert.equal(nextState(stepOf(fix, 'pause-work'), fix, { exitCode: 0 })?.to, 'apply-fix');
  assert.equal(nextState(stepOf(fix, 'pause-work'), fix, { exitCode: 1 })?.to, 'apply-fix');
  const fixed = output => nextState(stepOf(fix, 'apply-fix'), fix, { turnComplete: true, structuredOutput: output })?.to;
  assert.equal(fixed({ 'is-fixed': true }), 'request-restart');
  assert.equal(fixed({ 'is-fixed': false }), 'hand-to-human');                  // not fixed — it needs the operator: blocked for them, SELF HEALING still held
  assert.match(stepOf(fix, 'hand-to-human').action.command, /self-healing:hand-to-human \{project\} \{ticket\} \{summary\} \{summary\}/);
  assert.equal(nextState(stepOf(fix, 'hand-to-human'), fix, { exitCode: 0 })?.to, 'done');
  assert.equal(nextState(stepOf(fix, 'hand-to-human'), fix, { exitCode: 1 })?.to, 'done');
  assert.ok(!(stepOf(fix, 'hand-to-human')['exit-events'] ?? []).some(e => e['move-to-state'] === 'resume-work'));
  assert.match(stepOf(fix, 'resume-work').action.command, /self-healing:stop \{project\} \{ticket\}/);
  assert.equal(nextState(stepOf(fix, 'resume-work'), fix, { exitCode: 0 })?.to, 'done');
  assert.ok(stepOf(fix, 'done')['is-done']);
  assert.deepEqual(['blocked', 'blocked-for-human'].map(id => pairedStatus(dev, id)), ['On Hold', 'On Hold']);
  assert.ok(real('blocked').steps.every(s => s['paired-ticket-system-status'] == null || s['paired-ticket-system-status'] === 'On Hold'));
});

// ASS-144 Q2: a backlog ticket sits in its refinement engine. The waiting
// points are human steps it rests at, Ready its done step; Estimate's
// fallback goes back to Groom; nothing marks, requests or ends a run.
const realEngine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
const inSequence = engine => engine.steps.toSorted((a, b) => a.sequence - b.sequence).map(s => s.id);
// hasInOrder(engine, ids) — its steps, by sequence, hold `ids` in that order, others between them allowed (ASS-258: an engine may gain a step).
const hasInOrder = (engine, ids) => assert.ok(inOrder(inSequence(engine), ids), inSequence(engine).join(' '));
const asked = (...statuses) => ({ questions: () => statuses.map(status => ({ status })) });

test('evaluateCondition (ASS-144): open-questions — a question Asked or Answer Rejected; all-questions-accepted — none but Answer Accepted, none at all counting', () => {
  assert.equal(evaluateCondition({ 'open-questions': true }, asked('Answered', 'Asked')), true);
  assert.equal(evaluateCondition({ 'open-questions': true }, asked('Answer Rejected')), true);
  assert.equal(evaluateCondition({ 'open-questions': false }, asked('Answered', 'Answer Accepted')), true);
  assert.equal(evaluateCondition({ 'open-questions': false }, {}), true);
  assert.equal(evaluateCondition({ 'all-questions-accepted': true }, asked('Answer Accepted')), true);
  assert.equal(evaluateCondition({ 'all-questions-accepted': true }, asked()), true);
  assert.equal(evaluateCondition({ 'all-questions-accepted': false }, asked('Answer Accepted', 'Answered')), true);
});

test('evaluateCondition (ASS-170): a question whose status is none of the known ones is open, so it holds Awaiting Answers', () => {
  for (const status of ['Unanswered', 'Open', '', undefined]) assert.equal(evaluateCondition({ 'open-questions': true }, asked('Answer Accepted', status)), true, String(status));
  const e = realEngine('harness-backlog-refinement');
  assert.equal(nextState(stepOf(e, 'awaiting-answers'), e, asked('Unanswered'))?.to, undefined);
  assert.equal(nextState(stepOf(e, 'awaiting-answers'), e, asked('Answer Accepted'))?.to, 'groom');
});

test('the harness\'s refinement engine (ASS-144 Q2, ASS-196, ASS-252): groom → awaiting-answers (human) → check-answers → find-dependencies → estimate → ready (done), a ticket too large through Split first; no approval step (ASS-51)', () => {
  const e = realEngine('harness-backlog-refinement');
  const to = (id, facts) => nextState(stepOf(e, id), e, facts)?.to;
  hasInOrder(e, ['groom', 'awaiting-answers', 'check-answers', 'find-dependencies', 'estimate', 'check-kept-whole', 'split', 'awaiting-split-decision', 'create-split-tickets', 'keep-whole', 'ready', 'superseded']);
  assert.equal(to('groom', { turnComplete: true, structuredOutput: { 'is-ready': true } }), 'check-answers');
  assert.equal(to('groom', { turnComplete: true, structuredOutput: { 'is-ready': false } }), 'awaiting-answers');
  assert.ok(isHumanStep(e, 'awaiting-answers'));
  assert.equal(to('awaiting-answers', asked('Asked')), undefined);                   // rests while a question waits on the operator
  assert.equal(to('awaiting-answers', asked('Answered')), 'groom');
  assert.match(stepOf(e, 'check-answers').action.command, /^\.\/agent\.sh ticket:questions-answered \{project\} \{ticket\}$/);
  assert.equal(to('check-answers', { exitCode: 0 }), 'find-dependencies');            // ASS-196: into Find Dependencies, not straight to Estimate
  assert.equal(to('check-answers', { exitCode: 1 }), 'awaiting-answers');
  // ASS-196: the Find Dependencies step — a claude prompt agent, run outside the dev container — moves on when its turn completes.
  const fd = stepOf(e, 'find-dependencies');
  assert.deepEqual([fd.action.type, fd.action.prompt, fd.action['agent-count'], fd.action['run-in-dev-container']], ['prompt', 'find-dependencies', 1, false]);
  assert.equal(to('find-dependencies', { turnComplete: true }), 'estimate');
  assert.deepEqual([stepOf(e, 'estimate').action.type, stepOf(e, 'estimate').action.prompt], ['prompt', 'estimate-with-split']);   // ASS-252
  for (const points of [1, 2, 3, 5, null]) assert.equal(to('estimate', { turnComplete: true, structuredOutput: { points, 'too-large': false, summary: 's' } }), 'ready', String(points));
  for (const output of [{ points: 4 }, {}, undefined]) assert.equal(to('estimate', { turnComplete: true, structuredOutput: output }), 'groom', JSON.stringify(output));
  assert.ok(isDoneStep(e, 'ready'));
  assert.equal(to('ready', asked('Answer Accepted')), undefined);
  assert.equal(to('ready', asked('Answer Accepted', 'Asked')), 'groom');             // a question not accepted sends it back
  for (const gone of ['mark-ready', 'request-answers', 'request-approval', 'done', 'awaiting-approval']) assert.equal(stepOf(e, gone), undefined, gone);
  const prompt = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'prompts', 'estimate', 'prompt.json'), 'utf8'));
  assert.deepEqual([prompt.persona, prompt.output.required], ['developer', ['points', 'summary']]);
});

test('example\'s refinement engine (ASS-144 Q2): groom → awaiting-answers → check-answers → check-points (a script) → estimate only without points → awaiting-approval (human) → ready (done)', () => {
  const e = realEngine('example-backlog-refinement');
  const to = (id, facts) => nextState(stepOf(e, id), e, facts)?.to;
  hasInOrder(e, ['groom', 'awaiting-answers', 'check-answers', 'check-points', 'estimate', 'awaiting-approval', 'ready']);
  assert.equal(to('groom', { turnComplete: true, structuredOutput: { 'is-ready': true } }), 'check-answers');
  assert.equal(to('groom', { turnComplete: true, structuredOutput: { 'is-ready': false } }), 'awaiting-answers');
  assert.equal(to('awaiting-answers', asked('Answer Rejected')), undefined);
  assert.equal(to('awaiting-answers', asked('Answered')), 'groom');
  assert.equal(to('check-answers', { exitCode: 0 }), 'check-points');
  assert.equal(to('check-answers', { exitCode: 1 }), 'awaiting-answers');
  assert.deepEqual([stepOf(e, 'check-points').action.type, stepOf(e, 'check-points').action.command], ['script', './agent.sh ticket:has-points {project} {ticket}']);
  assert.equal(to('check-points', { exitCode: 0 }), 'awaiting-approval');          // it has points: no estimate
  assert.equal(to('check-points', { exitCode: 1 }), 'estimate');
  for (const points of [1, 2, 3, 5, 8, 13, null]) assert.equal(to('estimate', { turnComplete: true, structuredOutput: { points } }), 'awaiting-approval', String(points));   // example's Fibonacci scale (ASS-152)
  assert.equal(to('estimate', { turnComplete: true, structuredOutput: {} }), 'groom');
  assert.ok(isHumanStep(e, 'awaiting-approval'));
  const decided = decision => ({ ...asked('Answer Accepted'), humanReview: { state: 'awaiting-approval', decision } });
  assert.equal(to('awaiting-approval', asked('Answer Accepted')), undefined);         // rests for the operator
  assert.equal(to('awaiting-approval', decided('Accept')), 'ready');
  assert.equal(to('awaiting-approval', decided('Reject')), 'groom');
  assert.ok(stepOf(e, 'awaiting-approval')['exit-events'].find(x => x.condition['human-review'] === 'Reject')['asks-for-reason']);
  assert.equal(to('awaiting-approval', asked('Asked')), 'groom');
  assert.ok(isDoneStep(e, 'ready'));
  assert.equal(to('ready', asked('Answered')), 'groom');
  for (const gone of ['mark-ready', 'request-answers', 'request-approval', 'done']) assert.equal(stepOf(e, gone), undefined, gone);
});

test('no refinement engine step runs a command naming a refinement state (ASS-144 Q4)', () => {
  for (const name of ['harness-backlog-refinement', 'example-backlog-refinement']) {
    const commands = realEngine(name).steps.map(s => s.action?.command ?? '').join('\n');
    assert.doesNotMatch(commands, /set-refinement|request-answers|refinement-is|decide-approval/, name);
  }
});

// Sub-engines (ASS-67): the test step runs `test`, whose check step runs `inner`.
const engines = {
  e: engine,
  test: { steps: [
    { id: 'check', sequence: 1, 'is-planning-stage': true, action: { type: 'state-engine', engine: 'inner' } },
    { id: 'ask', sequence: 2, action: { type: 'human' } },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] },
  inner: { steps: [{ id: 'inspect', sequence: 1, action: { type: 'prompt', prompt: 'inspect' } }, { id: 'settle', sequence: 2, 'is-planning-stage': false, action: { type: 'prompt', prompt: 'settle' } }] },
};
const nested = (...levels) => levels.reduceRight((sub, [engineName, state]) => ({ state, 'state-engine': engineName, ...(sub ? { 'sub-status': sub } : {}) }), undefined);
const nest = ([[engineName, from, to], ...rest]) => ({ 'state-engine': engineName, 'from-state': from, 'to-state': to, ...(rest.length ? { 'sub-state-change': nest(rest) } : {}) });
// A state change whose path, top first, is [engine, from, to] per level.
const sub = ([top, ...rest], extra = {}) => ({ ...change(top[1], top[2]), ...extra, 'sub-state-change': nest(rest) });

test('statusOf: a variation\'s high-level state and its detailed step, every level of its harness-status top first, steps from each level\'s engine', () => {
  const v = { 'harness-status': nested(['e', 'test'], ['test', 'check'], ['inner', 'inspect']) };
  const status = statusOf(engines, 'e', v);
  assert.deepEqual(status.chain.map(l => [l['state-engine'], l.state, l.step?.id]), [['e', 'test', 'test'], ['test', 'check', 'check'], ['inner', 'inspect', 'inspect']]);
  assert.deepEqual([status.state, status.step.id, status.detail, status.detailStep.id], ['test', 'test', 'inspect', 'inspect']);
  // A step with no sub-status is its own detailed step; the top level's engine is the one named, whatever the variation says.
  const flat = statusOf(engines, 'e', { 'harness-status': { state: 'build', 'state-engine': 'other' } });
  assert.deepEqual([flat.chain.length, flat.chain[0]['state-engine'], flat.state, flat.detail, flat.detailStep.id], [1, 'e', 'build', 'build', 'build']);
  // A step no engine knows is undefined; no harness-status, no chain.
  assert.equal(statusOf(engines, 'e', { 'harness-status': nested(['e', 'test'], ['nope', 'x']) }).detailStep, undefined);
  assert.deepEqual(statusOf(engines, 'e', {}), { chain: [], state: undefined, step: undefined, detail: undefined, detailStep: undefined });
});

test('inPlanning: the deepest step that sets is-planning-stage decides, falling back up the chain', () => {
  const of = (...levels) => inPlanning(statusOf(engines, 'e', { 'harness-status': nested(...levels) }));
  assert.equal(of(['e', 'plan']), true);
  assert.equal(of(['e', 'build']), false);
  assert.equal(of(['e', 'test'], ['test', 'check'], ['inner', 'inspect']), true);    // inspect sets none: check's
  assert.equal(of(['e', 'test'], ['test', 'check'], ['inner', 'settle']), false);    // settle's own false
  assert.equal(of(['e', 'test'], ['test', 'ask']), false);
  assert.equal(of(), false);
});

test('waitsOnHuman, given the engines: at a human step inside a sub-engine, or gated on leaving a sub-engine step (<engine>/<step>) once its work there is done', () => {
  const at = (levels, extra = {}) => ({ 'harness-status': nested(...levels), ...extra });
  assert.equal(waitsOnHuman(engine, at([['e', 'test'], ['test', 'ask']]), engines), true);
  assert.equal(waitsOnHuman(engine, at([['e', 'test'], ['test', 'check'], ['inner', 'inspect']]), engines), false);
  const into = done => sub([['e', 'test', 'test'], ['test', 'check', 'check'], ['inner', 'inspect', 'settle']], { 'work-is-done': done });
  const gated = levels => at(levels, { 'gate-when-leaving-state': ['inner/settle'], 'state-changes': [into(true)] });
  assert.equal(waitsOnHuman(engine, gated([['e', 'test'], ['test', 'check'], ['inner', 'settle']]), engines), true);
  assert.equal(waitsOnHuman(engine, { ...gated([['e', 'test'], ['test', 'check'], ['inner', 'settle']]), 'state-changes': [into(false)] }, engines), false);
  assert.equal(waitsOnHuman(engine, { ...gated([['e', 'test'], ['test', 'check'], ['inner', 'settle']]), 'gate-when-leaving-state': ['settle'] }, engines), false);
  // Without the engines it reads the top level alone, as before.
  assert.equal(waitsOnHuman(engine, at([['e', 'test'], ['test', 'ask']])), false);
});

// ASS-107 AC4 (operator, 2026-10-24): the ticket health check classifies and routes as Blocked and self-healing do.
test('the real check-ticket-health engine: an unhealthy ticket is classified, each issue its own exit to its ticket, raised where problemOf (fixTicketIn) says for the sampled ticket\'s project', () => {
  const health = JSON.parse(readFileSync(join(engineDir('check-ticket-health'), 'state-engine.json'), 'utf8'));
  const after = (id, output) => nextState(stepOf(health, id), health, { turnComplete: true, structuredOutput: output })?.to;
  assert.equal(after('inspect-ticket', { 'is-healthy': true }), 'done');
  assert.equal(after('inspect-ticket', { 'is-healthy': false }), 'classify');
  assert.equal(stepOf(health, 'classify').action.prompt, 'classify-issue');
  for (const issue of ['harness', 'project', 'environment']) assert.equal(after('classify', { issue }), 'create-ticket', issue);
  assert.equal(nextState(stepOf(health, 'create-ticket'), health, { subEngineDone: true })?.to, 'done');
});

test('evaluateCondition (ASS-248): open-questions counts the blocking ones alone — unflagged ones among them — and all-questions-accepted asks only them be accepted; Assumed is closed', () => {
  const flagged = (...qs) => ({ questions: () => qs.map(([status, blocking]) => ({ status, ...(blocking == null ? {} : { blocking }) })) });
  assert.equal(evaluateCondition({ 'open-questions': false }, flagged(['Asked', false], ['Answer Rejected', false])), true);   // non-blocking never holds
  assert.equal(evaluateCondition({ 'open-questions': true }, flagged(['Asked', true])), true);
  assert.equal(evaluateCondition({ 'open-questions': true }, flagged(['Asked'])), true);                                       // no flag: blocking
  assert.equal(evaluateCondition({ 'open-questions': false }, flagged(['Assumed', true], ['Assumed'])), true);
  assert.equal(evaluateCondition({ 'all-questions-accepted': true }, flagged(['Answer Accepted', true], ['Asked', false], ['Assumed', false])), true);
  assert.equal(evaluateCondition({ 'all-questions-accepted': false }, flagged(['Answer Accepted', true], ['Answered'])), true);
});

test('blocksTicket and isOpenQuestion (ASS-248): open is anything but Answered, Answer Accepted or Assumed; it blocks unless flagged blocking: false', () => {
  assert.deepEqual(['Asked', 'Answer Rejected', 'Answered', 'Answer Accepted', 'Assumed', 'Unanswered'].map(status => isOpenQuestion({ status })), [true, true, false, false, false, true]);
  assert.deepEqual([{ status: 'Asked' }, { status: 'Asked', blocking: true }, { status: 'Asked', blocking: false }, { status: 'Answered', blocking: true }].map(blocksTicket), [true, true, false, false]);
});
