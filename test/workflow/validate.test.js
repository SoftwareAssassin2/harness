import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateStateEngine, switchedOffStepErrors, promptWriteErrors } from '../../src/workflow/validate.js';
import { engineDir, engineNames, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');

// A minimal valid two-step engine; each test breaks one thing.
const engine = (steps, extra = {}) => ({ steps, ...extra });
const step = (id, sequence, fields = {}) => ({ id, sequence, name: id, action: { type: 'none' }, ...fields });
const errorsFor = e => validateStateEngine(e, ROOT, undefined, EXAMPLE_ENGINES);
const assertError = (e, pattern) =>
  assert.ok(errorsFor(e).some(m => pattern.test(m)), `expected an error matching ${pattern}, got ${JSON.stringify(errorsFor(e))}`);

test('a minimal engine is valid', () => {
  assert.deepEqual(errorsFor(engine([
    step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'b' }] }),
    step('b', 2, { 'is-done': true }),
  ])), []);
});

test('every step needs a unique id', () => {
  assertError(engine([{ sequence: 1, name: 'No Id', action: { type: 'none' } }]), /no id/);
  assertError(engine([step('a', 1), step('a', 2)]), /duplicate id "a"/);
});

test('exits must point at a known step id', () => {
  assertError(engine([step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'Nope' }] })]), /unknown step "Nope"/);
});

test('conditions are structured: one known leaf, or all/not', () => {
  const withCondition = condition => engine([step('a', 1, { 'exit-events': [{ condition, 'move-to-state': 'a' }], 'max-visits': 3, 'on-max-visits': 'a' })]);
  assertError(withCondition('stop-reason:end-turn'), /condition must be an object/);
  assertError(withCondition({ 'stop-reason': 'end-turn' }), /unknown condition "stop-reason"/);
  assertError(withCondition({ always: true, 'turn-complete': true }), /exactly one key/);
  assertError(withCondition({ all: [] }), /"all" needs a non-empty array/);
  assertError(withCondition({ not: { bogus: 1 } }), /unknown condition "bogus"/);
});

test('every step has exactly one action of a known type', () => {
  assertError(engine([{ id: 'a', sequence: 1, name: 'a' }]), /step "a" has no action/);
  assertError(engine([step('a', 1, { action: { type: 'magic' } })]), /unknown action type "magic"/);
  assertError(engine([step('a', 1, { 'prompt-to-execute': 'x' })]), /legacy field "prompt-to-execute"/);
  assertError(engine([step('a', 1, { action: { type: 'prompt', prompt: 'x', mode: 'timer' } })]), /timer-minutes/);
});

// ASS-253: a timer script's "not yet" exit code, polled again with no failure counted (steps.js).
test('waiting-exit-code goes only on a timer script step, is a non-zero code, and no exit may take it', () => {
  const timer = (extra, exits = [{ condition: { 'exit-code': 0 }, 'move-to-state': 'b' }]) => engine([
    step('a', 1, { action: { type: 'script', command: './agent.sh ticket:fix-landed {project} {work-item} {variation}', mode: 'timer', 'timer-minutes': 5, ...extra }, 'exit-events': exits }),
    step('b', 2, { 'is-done': true }),
  ]);
  assert.deepEqual(errorsFor(timer({ 'waiting-exit-code': 1 })), []);
  assertError(timer({ 'waiting-exit-code': 1, mode: undefined }), /waiting-exit-code needs a timer script action/);
  assertError(timer({ 'waiting-exit-code': 0 }), /waiting-exit-code must be a non-zero exit code/);
  assertError(timer({ 'waiting-exit-code': '1' }), /waiting-exit-code must be a non-zero exit code/);
  assertError(timer({ 'waiting-exit-code': 1 }, [{ condition: { 'exit-code': 1 }, 'move-to-state': 'b' }]), /an exit takes its waiting-exit-code 1/);
  assertError(timer({ 'waiting-exit-code': 1 }, [{ condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'b' }]), /an exit takes its waiting-exit-code 1/);
});

test('script commands must resolve to an existing CLI script and known placeholders', () => {
  assertError(engine([step('a', 1, { action: { type: 'script', command: './agent.sh take-out-of-draft-mode {ticket}' } })]), /no script for "\.\/agent\.sh take-out-of-draft-mode"/);
  assertError(engine([step('a', 1, { action: { type: 'script', command: './agent.sh code:create-branch {merge-request}' } })]), /unknown placeholder \{merge-request\}/);
  // What control fills from a transient run's structured output, besides the ticket.
  assert.deepEqual(errorsFor(engine([step('a', 1, { action: { type: 'script', command: './agent.sh self-healing:start {ticket} {summary} {ticket-url}' } })])).filter(e => /placeholder/.test(e)), []);
});

test('state-engine actions must name an existing engines/ folder', () => {
  assert.deepEqual(errorsFor(engine([step('a', 1, { action: { type: 'state-engine', engine: 'test' } })])), []);
  assertError(engine([step('a', 1, { action: { type: 'state-engine', engine: 'nope' } })]), /unknown state engine "nope"/);
  assertError(engine([step('a', 1, { action: { type: 'state-engine' } })]), /step "a" state-engine action has no engine/);
  assertError(engine([step('a', 1, { action: { type: 'state-engine', state: 'test' } })]), /step "a" state-engine action has no engine/);
});

// An engine whose a moves, by `exit`, into b, a state-engine step running engines/test (test → take-screenshots → done).
const entering = (exit, b = { action: { type: 'state-engine', engine: 'test' } }) => engine([
  step('a', 1, { 'exit-events': [{ condition: { always: true }, ...exit }] }),
  step('b', 2, { ...b, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'c' }] }),
  step('c', 3, { 'is-done': true }),
]);

test('start-sub-engine-at names a step of the sub-engine its move-to-state runs', () => {
  assert.deepEqual(errorsFor(entering({ 'move-to-state': 'b', 'start-sub-engine-at': 'take-screenshots' })), []);
  assertError(entering({ 'move-to-state': 'b', 'start-sub-engine-at': 'nope' }), /step "a" starts sub-engine "test" at unknown step "nope"/);
});

test('sub-engine-ended-at names a done step of the sub-engine its own state-engine step runs (ASS-68)', () => {
  const ending = (leaf, action = { type: 'state-engine', engine: 'test' }) => engine([
    step('a', 1, { action, 'exit-events': [{ condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': leaf }] }, 'move-to-state': 'b' }] }),
    step('b', 2, { 'is-done': true }),
  ]);
  assert.deepEqual(errorsFor(ending('done')), []);
  assertError(ending('nope'), /step "a" reads sub-engine-ended-at "nope", which is not a done step of "test"/);
  assertError(ending('test'), /step "a" reads sub-engine-ended-at "test", which is not a done step of "test"/);
  assertError(ending('done', { type: 'none' }), /step "a" reads sub-engine-ended-at but its action is "none"/);
});

test('start-sub-engine-at goes only with a move-to-state into a state-engine step', () => {
  assertError(entering({ 'move-to-state': 'b', 'start-sub-engine-at': 'test' }, {}), /step "a" start-sub-engine-at needs "b" to be a state-engine step/);
  assertError(entering({ 'move-to-state-from-structured-output': 'next', 'start-sub-engine-at': 'test' }), /step "a" start-sub-engine-at needs a move-to-state/);
  assertError(entering({ 'follow-return-to-state': true, 'start-sub-engine-at': 'test' }), /step "a" start-sub-engine-at needs a move-to-state/);
});

test('is-done and structured-ticket-variation-array-check are conditions', () => {
  const check = value => engine([
    step('a', 1, { 'exit-events': [{ condition: { 'structured-ticket-variation-array-check': value }, 'move-to-state': 'b' }] }),
    step('b', 2, { 'is-done': true }),
  ]);
  assert.deepEqual(errorsFor(engine([
    step('a', 1, { action: { type: 'state-engine', engine: 'test' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'b' }] }),
    step('b', 2, { 'is-done': true }),
  ])), []);
  assert.deepEqual(errorsFor(check({ 'member-name': 'acceptance-criteria', 'min-length': 1 })), []);
  assert.deepEqual(errorsFor(check({ 'member-name': 'acceptance-criteria', 'min-length': 0 })), []);
  assertError(check(true), /structured-ticket-variation-array-check must be an object/);
  assertError(check({ 'min-length': 1 }), /structured-ticket-variation-array-check needs a string member-name/);
  assertError(check({ 'member-name': 'acceptance-criteria' }), /structured-ticket-variation-array-check needs an integer min-length of 0 or more/);
  assertError(check({ 'member-name': 'acceptance-criteria', 'min-length': -1 }), /structured-ticket-variation-array-check needs an integer min-length of 0 or more/);
  assertError(check({ 'member-name': 'acceptance-criteria', 'min-length': 1.5 }), /structured-ticket-variation-array-check needs an integer min-length of 0 or more/);
});

test('workflow actions are replaced by state-engine', () => {
  assertError(engine([step('a', 1, { action: { type: 'workflow', workflow: 'test' } })]), /unknown action type "workflow"/);
});

test('steps in every top-level -steps and -trigger array are validated, and can move to steps', () => {
  const side = fields => step('side', 1, fields);
  assertError(engine([], { 'check-x-steps': [side({ action: { type: 'bogus' } })] }), /step "side" has unknown action type "bogus"/);
  assertError(engine([], { 'gap-trigger': [side({ action: { type: 'bogus' } })] }), /step "side" has unknown action type "bogus"/);
  assertError(engine([step('side', 1)], { 'check-x-steps': [side()] }), /duplicate id "side"/);
  assert.deepEqual(errorsFor(engine([step('done', 9, { 'is-done': true })], {
    'check-x-steps': [side({ 'exit-events': [{ condition: { always: true }, 'move-to-state': 'done' }] })],
  })), []);
});

test('a checked success needs a matching failure exit', () => {
  const s = step('a', 1, {
    action: { type: 'script', command: './agent.sh code:create-branch {ticket}' },
    'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'b' }],
  });
  assertError(engine([s, step('b', 2)]), /step "a" has no exit for when exit-code fails/);
});

test('one negated exit-code exit catches every other code, so a step may route particular codes before it', () => {
  const s = step('a', 1, {
    action: { type: 'script', command: './agent.sh code:create-branch {ticket}' },
    'exit-events': [
      { condition: { 'exit-code': 0 }, 'move-to-state': 'b' },
      { condition: { 'exit-code': 3 }, 'move-to-state': 'c' },
      { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'c' },
    ],
  });
  assert.deepEqual(errorsFor(engine([s, step('b', 2), step('c', 3)])), []);
});

test('timer steps rerun on the next tick, so they need no failure exit', () => {
  const s = step('a', 1, {
    action: { type: 'script', command: './agent.sh code:create-branch {ticket}', mode: 'timer', 'timer-minutes': 5 },
    'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'b' }],
  });
  assert.deepEqual(errorsFor(engine([s, step('b', 2)])), []);
});

test('a step that is looped back to needs a visit cap', () => {
  const back = step('b', 2, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'a' }] });
  assertError(engine([step('a', 1), back]), /loops back to "a", which has no max-visits/);
  assertError(engine([step('a', 1, { 'max-visits': 3 }), back]), /max-visits without on-max-visits/);
  assertError(engine([step('a', 1, { 'max-visits': 3, 'on-max-visits': 'zzz' }), back]), /on-max-visits points at unknown step "zzz"/);
});

// ASS-252: a human's choice moves the ticket (the TUI, ticket:human-review), so
// a loop back out of a human step waits on a person and runs away no more than one into it.
test('a step a human step\'s exit loops back to needs no visit cap', () => {
  const gate = step('gate', 2, { action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Reject' }, 'move-to-state': 'a' }] });
  assert.deepEqual(errorsFor(engine([step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'gate' }] }), gate])).filter(e => /loops back/.test(e)), []);
});

// ASS-107 AC6: Blocked caps itself by its failed fix attempts (engines/blocked), not by its visits.
test('a move into a quarantine step is off the conveyor, not a loop back: it needs no visit cap', () => {
  const blocked = step('blocked', 0, { area: 'quarantine', 'exit-events': [{ condition: { always: true }, 'move-to-state': 'a' }] });
  const into = step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'blocked' }] });
  assert.deepEqual(errorsFor(engine([blocked, into])).filter(e => /loops back/.test(e)), []);
});

test('approval moves forward and rejection moves back', () => {
  const review = step('review', 2, {
    action: { type: 'prompt', prompt: 'review-plan' },
    'exit-events': [
      { condition: { 'structured-output': { 'is-approved': true } }, 'move-to-state': 'work' },
      { condition: { 'structured-output': { 'is-approved': false } }, 'move-to-state': 'ship' },
    ],
  });
  const e = engine([step('work', 1, { 'max-visits': 3, 'on-max-visits': 'ship' }), review, step('ship', 3)]);
  assertError(e, /approval moves back/);
  assertError(e, /rejection moves forward/);
  // A rejection may end the engine: a sub-engine's verdict goes to its parent step, which decides.
  const ends = engine([review, step('work', 1, { 'max-visits': 3, 'on-max-visits': 'ship' }), step('ship', 3, { 'is-done': true })]);
  assert.deepEqual(errorsFor(ends).filter(x => /rejection/.test(x)), []);
});

test('structured-output fields must be declared in the prompt output schema', () => {
  const s = step('a', 1, {
    action: { type: 'prompt', prompt: 'review-plan' },
    'exit-events': [{ condition: { 'structured-output': { 'not-in-schema': true } }, 'move-to-state': 'b' }],
  });
  assertError(engine([s, step('b', 2)]), /"not-in-schema" is not in the output schema of prompt "review-plan"/);
  const missing = step('a', 1, {
    action: { type: 'prompt', prompt: 'no-such-prompt' },
    'exit-events': [{ condition: { 'structured-output': { x: true } }, 'move-to-state': 'b' }],
  });
  assertError(engine([missing, step('b', 2)]), /prompt "no-such-prompt" has no output schema/);
});

test('script-output can only be read from a script step', () => {
  const s = step('a', 1, {
    action: { type: 'prompt', prompt: 'review-plan' },
    'exit-events': [{ condition: { 'script-output': { 'needs-attention': true } }, 'move-to-state': 'b' }],
  });
  assertError(engine([s, step('b', 2)]), /step "a" reads script-output but its action is "prompt"/);
});

test('looping back to a human step needs no visit cap', () => {
  const human = step('gate', 1, { action: { type: 'human' } });
  const back = step('b', 2, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'gate' }] });
  assert.deepEqual(errorsFor(engine([human, back])), []);
});

test('return-to-state must name a known step', () => {
  assertError(engine([step('a', 1, { 'return-to-state': 'zzz' })]), /return-to-state points at unknown step "zzz"/);
});

test('a step that can move to a follow-return-to-state step needs a return-to-state', () => {
  const blocked = step('blocked', 0, { action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }] });
  const viaCap = step('a', 1, { 'max-visits': 3, 'on-max-visits': 'blocked' });
  const viaExit = step('b', 2, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'blocked' }] });
  assertError(engine([blocked, viaCap]), /step "a" can move to "blocked" but has no return-to-state/);
  assertError(engine([blocked, viaExit]), /step "b" can move to "blocked" but has no return-to-state/);
  assert.deepEqual(errorsFor(engine([blocked, { ...viaCap, 'return-to-state': 'a' }])), []);
  // A blocked step forwarding to another passes the sender's return-to-state on; it needs none of its own.
  const forwarding = step('blocked-for-human', 0, { action: { type: 'human' }, 'follow-return-to-state': true, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'blocked' }] });
  assert.deepEqual(errorsFor(engine([blocked, forwarding])), []);
});

// ASS-44: ready-tickets-join-sprint-at names a step a ready ticket joins at; must be a string naming a known step id.
test('ready-tickets-join-sprint-at must be a string naming an existing step id, when given', () => {
  const base = () => engine([
    step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'b' }] }),
    step('b', 2, { 'is-done': true }),
  ]);
  assert.deepEqual(errorsFor(base()), []);                                                          // absent
  assert.deepEqual(errorsFor({ ...base(), 'ready-tickets-join-sprint-at': 'b' }), []);              // a known step
  assertError({ ...base(), 'ready-tickets-join-sprint-at': 'nope' }, /ready-tickets-join-sprint-at points at unknown step "nope"/);
  assertError({ ...base(), 'ready-tickets-join-sprint-at': true }, /ready-tickets-join-sprint-at/);
  assertError({ ...base(), 'ready-tickets-join-sprint-at': '' }, /ready-tickets-join-sprint-at/);
});

test('ready-tickets-join-sprint-at is only on engines/harness-development, its grouped copy (ASS-68), harness-development-v2 (ASS-110) and its example GitHub copy, naming "committed" (ASS-44)', () => {
  const carriers = {};
  for (const name of engineNames().filter(d => existsSync(join(engineDir(d), 'state-engine.json')))) {
    const value = JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'))['ready-tickets-join-sprint-at'];
    if (value !== undefined) carriers[name] = value;
  }
  assert.deepEqual(carriers, { 'harness-development': 'committed', 'harness-development-grouped': 'committed', 'harness-development-v2': 'committed', 'example-github-development': 'committed' });
});

// Every real engine passing: test/workflow/engines-work.test.js (ASS-258).

test('a step area, when given, is "quarantine"', () => {
  const done = fields => step('b', 1, { 'is-done': true, ...fields });
  assert.deepEqual(errorsFor(engine([done({ area: 'quarantine' })])), []);
  assertError(engine([done({ area: 'warehouse' })]), /area "warehouse" is not "quarantine"/);
});

test('a step color must be #rrggbb', () => {
  const done = fields => step('a', 1, { 'is-done': true, ...fields });
  assert.deepEqual(errorsFor(engine([done({ color: '#ffd700' })])), []);
  assertError(engine([done({ color: 'yellow' })]), /color "yellow" is not #rrggbb/);
});

test('variation-selected and has-variations are conditions', () => {
  assert.deepEqual(errorsFor(engine([
    step('pick', 1, { action: { type: 'human' }, 'exit-events': [{ condition: { 'variation-selected': true }, 'move-to-state': 'b' }, { condition: { 'has-variations': false }, 'move-to-state': 'b' }] }),
    step('b', 2, { 'is-done': true }),
  ])), []);
});

test('a script step\'s command must resolve to a script with something in it: an empty file is a stub, not a command', () => {
  const root = mkdtempSync(join(tmpdir(), 'vs-'));
  mkdirSync(join(root, 'src', 'agent-cli', 'code'), { recursive: true });
  writeFileSync(join(root, 'src', 'agent-cli', 'code', 'empty.sh'), '');
  writeFileSync(join(root, 'src', 'agent-cli', 'code', 'real.sh'), '#!/usr/bin/env bash\necho hi\n');
  const scripted = command => validateStateEngine(engine([step('a', 1, { action: { type: 'script', command }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'b' }, { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'b' }] }), step('b', 2, { 'is-done': true })]), root);
  assert.deepEqual(scripted('./agent.sh code:empty {ticket}'), ['step "a" has an empty script for "./agent.sh code:empty"']);
  assert.deepEqual(scripted('./agent.sh code:real {ticket}'), []);
});

// run-location (ASS-74): where a step runs — on the host (the default) or in the variation's VM.
test('a step\'s run-location, when given, is host or vm', () => {
  const done = fields => step('a', 1, { 'is-done': true, ...fields });
  assert.deepEqual(errorsFor(engine([done({ 'run-location': 'host' })])), []);
  assert.deepEqual(errorsFor(engine([done({ 'run-location': 'vm' })])), []);
  assertError(engine([done({ 'run-location': 'cloud' })]), /run-location "cloud" is not host or vm/);
});

// vm (ASS-75): whether the variation's VM runs at a step (running) or is kept there, stopped (stopped); missing, it is not needed.
// released (ASS-325): it is deleted there at once, its disk back to the project's VM disk budget.
test('a step\'s vm, when given, is running, stopped or released', () => {
  const done = fields => step('a', 1, { 'is-done': true, ...fields });
  assert.deepEqual(errorsFor(engine([done({ vm: 'running' })])), []);
  assert.deepEqual(errorsFor(engine([done({ vm: 'stopped' })])), []);
  assert.deepEqual(errorsFor(engine([done({ vm: 'released' })])), []);
  assertError(engine([done({ vm: 'paused' })]), /step "a" vm "paused" is not running, stopped or released/);
});

// A vm step's agent.sh calls reach the Mac only through the forwarder, which refuses a command not on its allowlist (src/control/forwarder-allowlist.json).
test('a vm step may call only the forwarder\'s allowlisted commands, from its script or its prompt', () => {
  const root = mkdtempSync(join(tmpdir(), 'vs-'));
  for (const name of ['questions-answered', 'adopt-run-folder']) { mkdirSync(join(root, 'src', 'agent-cli', 'ticket'), { recursive: true }); writeFileSync(join(root, 'src', 'agent-cli', 'ticket', `${name}.sh`), '#!/bin/bash\n'); }
  mkdirSync(join(root, 'src', 'control'), { recursive: true });
  writeFileSync(join(root, 'src', 'control', 'forwarder-allowlist.json'), JSON.stringify({ 'ticket:questions-answered': { project: 0, ticket: 1 } }));
  const prompt = (name, text, persona) => { mkdirSync(join(root, 'prompts', name), { recursive: true }); writeFileSync(join(root, 'prompts', name, 'prompt.txt'), text); writeFileSync(join(root, 'prompts', name, 'prompt.json'), JSON.stringify(persona ? { persona } : {})); };
  mkdirSync(join(root, 'personas'), { recursive: true });
  writeFileSync(join(root, 'personas', 'meddler.md'), 'You may run {agent-sh} ticket:adopt-run-folder {project} {ticket} x.\n');
  prompt('fine', 'Check: {agent-sh} ticket:questions-answered {project} {ticket}; report with {status-update-command}.\n');
  prompt('reaches', 'Then {agent-sh} ticket:adopt-run-folder {project} {ticket} x.\n');
  prompt('persona', 'Plain.\n', 'meddler');
  const at = (action, where = 'vm') => validateStateEngine(engine([step('a', 1, { 'is-done': true, 'run-location': where, action })]), root);
  assert.deepEqual(at({ type: 'script', command: './agent.sh ticket:questions-answered {project} {ticket}' }), []);
  assert.deepEqual(at({ type: 'prompt', prompt: 'fine' }), []);
  assert.ok(at({ type: 'script', command: './agent.sh ticket:adopt-run-folder {project} {ticket} {run}' }).some(e => /step "a" runs in the VM but calls ticket:adopt-run-folder, which the forwarder does not allow/.test(e)));
  assert.ok(at({ type: 'prompt', prompt: 'reaches' }).some(e => /step "a" runs in the VM but its prompt calls ticket:adopt-run-folder, which the forwarder does not allow/.test(e)));
  assert.ok(at({ type: 'prompt', prompt: 'persona' }).some(e => /its prompt calls ticket:adopt-run-folder/.test(e)), 'the persona is part of the prompt');
  assert.deepEqual(at({ type: 'prompt', prompt: 'reaches' }, 'host'), [], 'a host step calls what it likes');
});

// Neither the harness repo nor the project's host data is mounted in a VM (ASS-74 Q10).
test('a vm step\'s prompt never uses {harness-folder} or {project-folder}', () => {
  const root = mkdtempSync(join(tmpdir(), 'vs-'));
  mkdirSync(join(root, 'prompts', 'p'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'p', 'prompt.txt'), 'Read {harness-folder}/x and {project-folder}/y; write to {ticket-folder}.\n');
  const at = where => validateStateEngine(engine([step('a', 1, { 'is-done': true, 'run-location': where, action: { type: 'prompt', prompt: 'p' } })]), root);
  assert.deepEqual(at('host'), []);
  assert.deepEqual(at('vm').filter(e => /folder/.test(e)), ['step "a" runs in the VM but its prompt uses {harness-folder}, which is not mounted there', 'step "a" runs in the VM but its prompt uses {project-folder}, which is not mounted there']);
});

// run-in-repository (ASS-119): a prompt step runs in one repository its project declares (project.json repositories[],
// named as the url's last segment), or "each": once in each repository the ticket's planned merge requests touch.
test('a step\'s run-in-repository names a repository a project running the engine declares, or is "each"; only on a prompt step', () => {
  const root = mkdtempSync(join(tmpdir(), 'vr-'));
  const json = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  json(join(root, 'data', 'projects', 'p', 'project.json'), { 'execution-state-engine': 'top', repositories: [{ url: 'https://gitlab.com/g/example-corpus.git' }, { url: 'https://github.com/o/harness' }] });
  json(join(root, 'data', 'projects', 'q', 'project.json'), { 'execution-state-engine': 'other', repositories: [{ url: 'https://gitlab.com/g/elsewhere' }] });
  json(join(root, 'engines', 'top', 'state-engine.json'), { steps: [step('s', 1, { action: { type: 'state-engine', engine: 'sub' } })] });
  json(join(root, 'engines', 'sub', 'state-engine.json'), { steps: [] });
  const at = (where, action = { type: 'prompt', prompt: 'x' }, name = 'sub') => validateStateEngine(engine([step('a', 1, { 'is-done': true, 'run-in-repository': where, action })]), root, name);
  assert.deepEqual(at('example-corpus'), [], 'a repository of p, whose engine reaches sub');
  assert.deepEqual(at('harness', undefined, 'top'), []);
  assert.deepEqual(at('each'), []);
  assert.deepEqual(at('elsewhere'), ['step "a" runs in repository "elsewhere", which no project running engine "sub" declares (p: example-corpus, harness)']);
  assert.deepEqual(at('elsewhere', undefined, 'other'), []);
  assert.deepEqual(at(''), ['step "a" run-in-repository must name a repository or be "each"']);
  assert.deepEqual(at(['harness']), ['step "a" run-in-repository must name a repository or be "each"']);
  assert.deepEqual(at('each', { type: 'none' }), ['step "a" has run-in-repository, but only a prompt step runs in a repository']);
  // An engine no project runs (or one given without its name) is checked against every project's repositories.
  assert.deepEqual(at('elsewhere', undefined, 'unused'), []);
  assert.deepEqual(validateStateEngine(engine([step('a', 1, { 'is-done': true, 'run-in-repository': 'nowhere', action: { type: 'prompt', prompt: 'x' } })]), root), ['step "a" runs in repository "nowhere", which no project declares (p: example-corpus, harness; q: elsewhere)']);
});

test('ASS-144: a backlog refinement engine may loop back into its first step — groomed there only once due — and its question conditions are known; the same loop in an engine no backlog-refinement-steps runs needs a cap', () => {
  const e = JSON.parse(readFileSync(join(engineDir('example-backlog-refinement'), 'state-engine.json'), 'utf8'));
  assert.deepEqual(validateStateEngine(e, ROOT, 'example-backlog-refinement', EXAMPLE_ENGINES), []);
  assert.ok(validateStateEngine(e, ROOT, 'not-a-refinement-engine', EXAMPLE_ENGINES).includes('step "estimate" loops back to "groom", which has no max-visits'));
});

test('ASS-192 AC2: a step may be switched off ("is-active": false) when it has an exit to pass it by and is neither its list\'s first step nor a done step; is-active is a boolean', () => {
  const pass = { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'c' }] };
  const three = b => engine([step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'b' }] }), step('b', 2, b), step('c', 3, { 'is-done': true })]);
  assert.deepEqual(errorsFor(three({ ...pass, 'is-active': false })), []);
  assert.deepEqual(errorsFor(three({ ...pass, 'is-active': true })), []);
  assertError(three({ 'is-active': false }), /step "b" is switched off but has no exit event/);
  assertError(three({ ...pass, 'is-active': 'no' }), /step "b" is-active "no" is not true or false/);
  assertError(engine([step('a', 1, { ...pass, 'is-active': false }), step('c', 2, { 'is-done': true })]), /step "a" is switched off but is the first step/);
  assertError(engine([step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'c' }] }), step('c', 2, { 'is-done': true, 'is-active': false })]), /step "c" is switched off but is a done step/);
  // Each *-steps / *-trigger list's run starts at its own first step.
  assertError(engine([step('a', 1, { 'is-done': true })], { 'x-steps': [step('x', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'a' }], 'is-active': false })] }), /step "x" is switched off but is the first step/);
});

test('ASS-264: restarts-visit-count is a boolean, on a human step alone — a person\'s choice, never an agent\'s, restarts the count', () => {
  const two = b => engine([step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'b' }] }), step('b', 2, { 'is-done': true, ...b })]);
  assert.deepEqual(errorsFor(two({ action: { type: 'human' }, 'restarts-visit-count': true })), []);
  assertError(two({ action: { type: 'human' }, 'restarts-visit-count': 'yes' }), /step "b" restarts-visit-count "yes" is not true or false/);
  assertError(two({ 'restarts-visit-count': true }), /step "b" has restarts-visit-count but is no human step/);
});

// ASS-315: an exit may say why the move it makes was made ("cause": merge-gate-red on
// harness-development-v2's release rebuild exit, which restarts the visit window — engine.js
// sinceResolution, steps.js). It is recorded as given, so it must be a string: a non-string would
// never match the cause control looks for, and nothing would say so.
test('ASS-315: an exit\'s cause is a string', () => {
  const withCause = cause => engine([step('a', 1, { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'b', cause }] }), step('b', 2, { 'is-done': true })]);
  assert.deepEqual(errorsFor(withCause('merge-gate-red')), []);
  assertError(withCause(5), /step "a".*cause/);
  assertError(withCause(true), /step "a".*cause/);
});

test('ASS-209 AC2: a project.json switched-off-steps entry names an existing engine and step, which may be switched off by ASS-192\'s rules', () => {
  const pass = { 'exit-events': [{ condition: { always: true }, 'move-to-state': 'c' }] };
  const engines = { e: engine([step('a', 1, pass), step('b', 2, pass), step('n', 3), step('c', 4, { 'is-done': true })], { 'x-steps': [step('x', 1, pass)] }) };
  const of = entry => switchedOffStepErrors(entry, engines);
  assert.deepEqual(of('e/b'), []);
  assert.deepEqual(of('nope/b'), ['switched-off step "nope/b" names no engine "nope"']);
  assert.deepEqual(of('e/zz'), ['switched-off step "e/zz": engine "e" has no step "zz"']);
  assert.deepEqual(of('b'), ['switched-off step "b" is not "<engine>/<step-id>"']);
  assert.deepEqual(of(7), ['switched-off step "7" is not "<engine>/<step-id>"']);
  assert.deepEqual(of('e/a'), ['switched-off step "e/a": step "a" is switched off but is the first step']);
  assert.deepEqual(of('e/x'), ['switched-off step "e/x": step "x" is switched off but is the first step']);
  assert.ok(of('e/c').includes('switched-off step "e/c": step "c" is switched off but is a done step'));
  assert.match(of('e/n')[0], /^switched-off step "e\/n": step "n" is switched off but has no exit event/);
});

// ASS-182 AC3: every prompt and persona writes the harness's data only through agent.sh — an instruction (a sentence) to
// write, append, save or create a file under {ticket-folder}, {project-folder} or data/ names an {agent-sh} command, or fails.
const promptRoot = files => {
  const root = mkdtempSync(join(tmpdir(), 'pw-'));
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
};

test('ASS-182 AC3: an instruction to write, append, save or create a file under {ticket-folder}, {project-folder} or data/ without an {agent-sh} command is an error, in any prompt or persona', () => {
  const root = promptRoot({
    'prompts/a/prompt.txt': 'Plan it.\n\n1. Write the report to {ticket-folder}/report.md: each finding.\n2. Append a line to {project-folder}/notes.md.\n',
    'prompts/b/prompt.txt': 'Save them in {ticket-folder}/screenshots/. Then create data/projects/p/x.json.\n',
    'prompts/c/prompt.txt': 'Keep a copy aside (git stash, or save a copy in {ticket-folder}/).\n',
    'personas/tester.md': 'You write your findings to {ticket-folder}/findings.md.\n',
  });
  assert.deepEqual(promptWriteErrors(root).map(e => e.split(' ')[0]), [
    'personas/tester.md:1', 'prompts/a/prompt.txt:3', 'prompts/a/prompt.txt:4', 'prompts/b/prompt.txt:1', 'prompts/b/prompt.txt:1', 'prompts/c/prompt.txt:1',
  ]);
  assert.match(promptWriteErrors(root)[1], /prompts\/a\/prompt\.txt:3 writes the harness's data directly — name the \{agent-sh\} command that writes it: "Write the report to \{ticket-folder\}\/report\.md: each finding\."/);
});

test('ASS-182 AC3: the same instruction naming an {agent-sh} command, a read of the folder, or a write elsewhere is not an error', () => {
  const root = promptRoot({
    'prompts/a/prompt.txt': [
      'Write {ticket-folder}/plan-{variation}.md (through `{agent-sh} work:write {project} {ticket} {variation} plan.md`, the whole file on stdin).',
      'Write the tests for ticket {ticket}, following its test plan ({ticket-folder}/test-plan-{variation}.md).',
      "Don't write code yet. If {ticket-folder}/plan-review.md exists, address every point in it.",
      'Read {project-folder}/backlog.json and write your notes to a temp file.',
      'Create the branch in /repos/app/ and save the screenshot to /tmp/x.png.',
    ].join('\n'),
    'personas/developer.md': 'You write code. You read {ticket-folder}/ticket.json.\n',
  });
  assert.deepEqual(promptWriteErrors(root), []);
});

test('ASS-182 AC3: every real prompt and persona writes the harness\'s data only through agent.sh (the flat reference engines\' own prompts aside, which are never changed)', () => {
  assert.deepEqual(promptWriteErrors(ROOT), []);
});

test('ASS-303 AC1-AC3: the grouped create-ticket prompt states the bare-command-line rule for both create commands, with the report-and-retry-once-bare rule on a failed create; the flat prompt is untouched', () => {
  const grouped = readFileSync(join(ROOT, 'prompts', 'create-ticket-grouped', 'prompt.txt'), 'utf8');
  const flat = readFileSync(join(ROOT, 'prompts', 'create-ticket', 'prompt.txt'), 'utf8');

  // AC1: both create commands are named, and the raise-bug line keeps its f.json placeholder (pinned verbatim elsewhere, raise-bug.test.js:146)
  assert.match(grouped, /off-board\.sh ticket:create/);
  assert.match(grouped, /agent\.sh ticket:raise-bug <name> "<title>" f\.json \[Story\]/);

  // AC1: the bare-command-line rule, with the forbidden syntax named together in its own sentence (a stray && elsewhere must not satisfy it)
  const plain = grouped.replace(/`/g, '');
  const bareRuleSentence = (plain.match(/[^.]*bare command line[^.]*\./) ?? [''])[0];
  assert.notEqual(bareRuleSentence, '');
  assert.match(bareRuleSentence, /no pipe, redirect, heredoc, *&&, *;, *\$\(…\)/);
  assert.match(bareRuleSentence, /\bcd\b/);

  // AC1: the body is a file-path argument, never on stdin
  assert.match(grouped, /never on stdin/);

  // AC1: the reason is stated, so the rule doesn't read as style
  assert.match(grouped, /sandboxed/);

  // AC1 regression guard: the wording that caused the bug (ASS-301) is gone
  assert.doesNotMatch(grouped, /mktemp/);

  // AC2: a failed create is reported verbatim, retried once bare, and only then finishes with an empty key
  assert.match(grouped, /report/);
  assert.match(grouped, /as it printed it/);
  assert.match(grouped, /once more, bare/);
  assert.match(grouped, /only if that fails too/i);
  assert.match(grouped, /Finish with JSON: \{"key": "<ticket key>"/);

  // AC3: the flat prompt is untouched
  assert.doesNotMatch(flat, /bare command line/);
  assert.doesNotMatch(flat, /never on stdin/);
  assert.doesNotMatch(flat, /once more, bare/);
  assert.match(flat, /acli jira workitem create --project <key>/);
  assert.match(flat, /temp file made with mktemp/);
});

test('ASS-277: given a project\'s own engines folder, the validator finds the engines its steps run there before engines/ — a sub-engine, its start step and its done steps, and the refinement engine it runs — as control does for that project', () => {
  const own = mkdtempSync(join(tmpdir(), 'own-'));
  const put = (name, json) => { mkdirSync(join(own, name), { recursive: true }); writeFileSync(join(own, name, 'state-engine.json'), JSON.stringify(json)); };
  put('own-sub', { steps: [{ id: 'first', sequence: 1, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'end' }] }, { id: 'end', sequence: 2, 'is-done': true, action: { type: 'none' } }] });
  const top = { steps: [
    { id: 'run', sequence: 1, action: { type: 'state-engine', engine: 'own-sub' }, 'exit-events': [{ condition: { 'sub-engine-ended-at': 'end' }, 'move-to-state': 'done' }] },
    { id: 'again', sequence: 2, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'run', 'start-sub-engine-at': 'first' }] },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] };
  assert.deepEqual(validateStateEngine(top, ROOT, 'top', own).filter(e => !e.includes('loops back')), []);
  const without = validateStateEngine(top, ROOT, 'top');
  assert.ok(without.includes('step "run" has unknown state engine "own-sub"'), without.join('\n'));
  // The example project's own engines validate as its own.
  for (const name of readdirSync(EXAMPLE_ENGINES)) assert.deepEqual(validateStateEngine(JSON.parse(readFileSync(join(EXAMPLE_ENGINES, name, 'state-engine.json'), 'utf8')), ROOT, name, EXAMPLE_ENGINES), [], name);
});
