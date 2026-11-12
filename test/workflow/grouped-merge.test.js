// ASS-365: grouped-merge, the shared merge loop — Release's loop over a set of
// a variation's merge requests (--only {merge-request-ids}), each reviewed at
// its head commit first — and grouped-build's way into it, Merge the Awaited,
// only from Await Sequential Merge's exit 5, which the command gives only
// where a step of the variation's status chain says merges-awaited (control's
// MERGES_AWAITED). Walked with control's own reading of an engine
// (src/control/engine.js nextState); the commands' tests are in
// test/agent-cli/merge-requests.test.js, control's in test/control/tick-merge-awaited.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepOf, nextState, mergesAwaited, statusOf } from '../../src/control/engine.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { loadEngines, walk, inOrder, engineNames, ROOT, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const engines = loadEngines();
const merge = engines['grouped-merge'], build = engines['grouped-build'];
const into = (engine, id) => engine.steps.filter(s => s.id !== id && (s['exit-events'] ?? []).some(e => e['move-to-state'] === id)).map(s => s.id);
const errorsFor = e => validateStateEngine(e, ROOT, undefined, EXAMPLE_ENGINES);
const WAITS = { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: false };

test('ASS-365 AC1: grouped-merge is Release\'s loop — out of draft, check, address feedback, auto-merge, check again — over the set (--only {merge-request-ids}), generic: agent.sh commands and the grouped prompts, no project named; every looping step capped, then Blocked', () => {
  assert.deepEqual(validateStateEngine(merge, ROOT, 'grouped-merge', EXAMPLE_ENGINES), []);
  const scripts = merge.steps.filter(s => s.action.type === 'script');
  assert.deepEqual(scripts.map(s => s.action.command.split(' ')[1]), ['merge-request:reviewed-at-head', 'merge-request:reviewed-at-head', 'code:take-out-of-draft-mode', 'merge-request:check', 'merge-request:feedback-round', 'merge-request:ensure-auto-merge']);
  for (const s of scripts) assert.match(s.action.command, /^\.\/agent\.sh \S+ \{project\} \{ticket\} \{variation\} --only \{merge-request-ids\}( --mark)?$/, s.id);
  assert.deepEqual(merge.steps.filter(s => s.action.type === 'prompt').map(s => [s.id, s.action.prompt]),
    [['code-review', 'code-review-grouped'], ['security-review', 'security-review-grouped'], ['address-merge-request-feedback', 'check-on-merge-request-build-grouped']]);
  for (const s of merge.steps.filter(s => !s['is-done'])) assert.deepEqual([s['max-visits'] > 0, s['on-max-visits']], [true, 'blocked'], s.id);
  assert.deepEqual(merge.steps.filter(s => s['is-done']).map(s => s.id), ['done', 'blocked', 'blocked-for-human', 'rebuild']);
  // The check: Release's Team Code Review's exits but the ticket system's, which are Release's own.
  const check = stepOf(merge, 'check');
  assert.equal(check.action.mode, 'timer');
  assert.equal(check['record-script-output'], true);
  const at = output => nextState(check, merge, { exitCode: 0, scriptOutput: output }, [])?.to ?? null;
  assert.equal(at({ ...WAITS, 'needs-attention': true }), 'address-merge-request-feedback');
  assert.equal(at({ ...WAITS, merged: true }), 'done');
  assert.equal(at({ ...WAITS, 'approval-wait-expired': true }), 'blocked-for-human');
  assert.equal(at({ ...WAITS, 'auto-merge': false }), 'ensure-auto-merge');
  assert.equal(at(WAITS), null, 'only waiting: polled where it is, no visit spent');
});

test('ASS-365 AC3: nothing leaves draft or is set to auto-merge before Code Review and Security Review pass at the head commit — the only way out of draft is through the gate, the only way to auto-merge through the check after it — and Address Merge Request Feedback\'s new commit goes back through the gate', () => {
  assert.deepEqual(into(merge, 'take-out-of-draft-mode'), ['check-review']);
  assert.deepEqual(into(merge, 'ensure-auto-merge'), ['check']);
  assert.deepEqual(into(merge, 'check').toSorted(), ['check-feedback-round', 'ensure-auto-merge', 'take-out-of-draft-mode']);   // ASS-388: a no-op round's return
  assert.deepEqual(stepOf(merge, 'address-merge-request-feedback')['exit-events'].map(e => e['move-to-state']), ['check-feedback-round']);
  assert.deepEqual(stepOf(merge, 'check-feedback-round')['exit-events'].map(e => e['move-to-state']), ['check', 'check-review', 'check-review']);
  assert.equal(merge.steps.toSorted((a, b) => a.sequence - b.sequence)[0].id, 'check-review', 'the run starts at the gate');
  const gate = stepOf(merge, 'check-review');
  assert.equal(nextState(gate, merge, { exitCode: 0 }, []).to, 'take-out-of-draft-mode');
  assert.equal(nextState(gate, merge, { exitCode: 2 }, []).to, 'code-review');
  assert.equal(nextState(gate, merge, { exitCode: 1 }, []).to, 'check-review', 'a failure tries the gate again, never past it');
  // Walked: unreviewed, reviewed, readied, a thread acted on, its new commit reviewed again, then auto-merge, merged.
  const { trail, end } = walk(engines, 'grouped-merge', { answers: {
    'grouped-merge/check-review': [{ exitCode: 2 }, { exitCode: 0 }, { exitCode: 2 }, { exitCode: 0 }],
    'grouped-merge/check': [{ scriptOutput: { ...WAITS, 'needs-attention': true } }, { scriptOutput: { ...WAITS, 'auto-merge': false } }, { scriptOutput: { ...WAITS, merged: true } }],
  } });
  assert.equal(end, 'done');
  const steps = trail.map(p => p.split('/')[1]);
  assert.deepEqual(steps, ['check-review', 'code-review', 'security-review', 'mark-reviewed', 'check-review', 'take-out-of-draft-mode', 'check', 'address-merge-request-feedback', 'check-feedback-round',
    'check-review', 'code-review', 'security-review', 'mark-reviewed', 'check-review', 'take-out-of-draft-mode', 'check', 'ensure-auto-merge', 'check', 'done']);
  assert.ok(inOrder(steps, ['address-merge-request-feedback', 'code-review', 'security-review', 'mark-reviewed', 'ensure-auto-merge']));
  // A review that rejects ends the run at rebuild, back to Generate Solution in grouped-build.
  for (const review of ['code-review', 'security-review'])
    assert.equal(walk(engines, 'grouped-merge', { answers: { 'grouped-merge/check-review': { exitCode: 2 }, [`grouped-merge/${review}`]: { structuredOutput: { 'is-approved': false } } } }).end, 'rebuild', review);
});

test('ASS-365 AC2/AC6: grouped-build enters Merge the Awaited only from Await Sequential Merge\'s exit 5, hands it the ids it waits on, shows the merge train there, and reads its ends — merged back to the wait, rejected to Generate Solution, Blocked, Blocked for Human; walked without exit 5 nothing changes', () => {
  assert.deepEqual(validateStateEngine(build, ROOT, 'grouped-build', EXAMPLE_ENGINES), []);
  const step = stepOf(build, 'merge-awaited'), wait = stepOf(build, 'await-dependencies');
  assert.deepEqual([step.action, step['pass-output'], step['shows-merge-train'], step['max-visits'], step['on-max-visits']], [{ type: 'state-engine', engine: 'grouped-merge' }, ['merge-request-ids'], true, 5, 'blocked']);
  assert.deepEqual(into(build, 'merge-awaited'), ['await-dependencies']);
  assert.equal(nextState(wait, build, { exitCode: 5 }, []).to, 'merge-awaited');
  const ended = at => nextState(step, build, { subEngineDone: true, subEngineState: at }, []).to;
  assert.deepEqual(['done', 'rebuild', 'blocked', 'blocked-for-human'].map(ended), ['await-dependencies', 'generate-solution', 'blocked', 'blocked-for-human']);
  assert.deepEqual(into(build, 'blocked-for-human'), ['merge-awaited'], 'grouped-build ends at Blocked for Human only from the merge loop');
  // Grouped-build's order is as it was: Merge the Awaited sits between Address Merge Request Feedback and the wait it returns to.
  const order = build.steps.toSorted((a, b) => a.sequence - b.sequence).map(s => s.id);
  assert.ok(inOrder(order, ['refresh-repositories', 'generate-automated-tests', 'generate-solution', 'address-merge-request-feedback', 'merge-awaited', 'await-dependencies', 'refresh-before-testing', 'automated-testing', 'ci-checks', 'code-review', 'security-review']), order.join(' '));
  // Without exit 5 (no merges-awaited, as every engine here): the walk never enters it.
  for (const top of ['harness-development-grouped', 'example-development-grouped']) {
    const { trail } = walk(engines, top, { stop: ['test'] });
    assert.ok(!trail.some(p => p.startsWith('grouped-merge/') || p === 'grouped-build/merge-awaited'), top);
  }
  // With it, the awaited one merges, then the tests: Merge the Awaited comes before Automated Testing and every later group.
  const { trail } = walk(engines, 'example-development-grouped', { from: 'build', answers: { 'grouped-build/await-dependencies': [{ exitCode: 5 }, { exitCode: 0 }], 'grouped-merge/check': { scriptOutput: { ...WAITS, merged: true } } }, stop: ['test'] });
  assert.ok(inOrder(trail, ['grouped-build/await-dependencies', 'grouped-build/merge-awaited', 'grouped-merge/take-out-of-draft-mode', 'grouped-merge/check', 'grouped-merge/done', 'grouped-build/await-dependencies', 'grouped-build/automated-testing']), trail.join(' '));
});

// ASS-388: a round of Address Merge Request Feedback that changed nothing goes back to the check with cause
// no-op-round, which control records on the move and counts no visit for — in the merge loop and in a project's
// own Release (the example's, as a project's would read: no --only, both exits back to Team Code Review).
test('ASS-388 AC2/AC4: grouped-merge and a project Release check the round after Address Merge Request Feedback; three (or ten) no-op rounds on a clean merge request leave the check polling, never Blocked, while three that changed something still end at Blocked', () => {
  const release = engines['grouped-release-example'];
  for (const [engine, back, on, command] of [[merge, 'check', 'check-review', './agent.sh merge-request:feedback-round {project} {ticket} {variation} --only {merge-request-ids}'],
    [release, 'team-code-review', 'team-code-review', './agent.sh merge-request:feedback-round {project} {ticket} {variation}']]) {
    assert.deepEqual(validateStateEngine(engine, ROOT, undefined, EXAMPLE_ENGINES), []);
    const round = stepOf(engine, 'check-feedback-round');
    assert.deepEqual(stepOf(engine, 'address-merge-request-feedback')['exit-events'].map(e => e['move-to-state']), ['check-feedback-round']);
    assert.equal(round.action.command, command);
    assert.deepEqual(round['exit-events'].map(e => [e['move-to-state'], e.cause]), [[back, 'no-op-round'], [on, undefined], [on, undefined]]);
    // Driven as control drives it: each move recorded with its exit's cause, as steps.js and change-state record it.
    const check = stepOf(engine, back), needs = { exitCode: 0, ticketSystemStatus: 'In Review', scriptOutput: { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': false, merged: false } };
    const drive = (rounds, changed) => {
      const changes = [{ 'from-state': 'take-out-of-draft-mode', 'to-state': back }];
      const go = (step, facts) => { const next = nextState(step, engine, facts, changes); changes.push({ 'from-state': step.id, 'to-state': next.to, ...(next.exit.cause ? { cause: next.exit.cause } : {}) }); return next.to; };
      for (let i = 0; i < rounds; i++) {
        if (go(check, needs) !== 'address-merge-request-feedback') return changes.at(-1)['to-state'];
        go(stepOf(engine, 'address-merge-request-feedback'), { turnComplete: true });
        const to = go(round, { exitCode: 0, scriptOutput: { changed } });
        // A changed round in the merge loop passes the gate and out of draft again, back to the check.
        if (to === 'check-review') changes.push({ 'from-state': 'check-review', 'to-state': 'take-out-of-draft-mode' }, { 'from-state': 'take-out-of-draft-mode', 'to-state': 'check' });
      }
      return nextState(check, engine, needs, changes).to;
    };
    assert.equal(drive(3, false), 'address-merge-request-feedback', `${back}: after three no-op rounds the check still sends it on, no visit spent`);
    assert.equal(drive(10, false), 'address-merge-request-feedback', `${back}: after ten too`);
    // Polling the clean merge request after them: the check's own exits, as ever (only waiting: no move).
    assert.equal(nextState(check, engine, { exitCode: 0, ticketSystemStatus: 'In Review', scriptOutput: WAITS }, []), null);
    assert.equal(drive(3, true), 'blocked', `${back}: three rounds that changed something spend Address Merge Request Feedback's max-visits`);
  }
});

test('ASS-365 AC2: merges-awaited is read anywhere in the status chain, never a step id or name; no engine in this repository sets it', () => {
  const top = flag => ({ steps: [{ id: 'build', action: { type: 'state-engine', engine: 'grouped-build' }, ...(flag ? { 'merges-awaited': true } : {}) }] });
  const level = (engine, state, sub) => ({ 'state-engine': engine, state, ...(sub ? { 'sub-status': sub } : {}) });
  const at = (flag, status) => mergesAwaited(statusOf({ top: top(flag), 'grouped-build': build, 'grouped-merge': merge }, 'top', { 'harness-status': status }));
  assert.equal(at(true, level('top', 'build', level('grouped-build', 'await-dependencies'))), true);
  assert.equal(at(true, level('top', 'build', level('grouped-build', 'merge-awaited', level('grouped-merge', 'check')))), true);
  assert.equal(at(false, level('top', 'build', level('grouped-build', 'await-dependencies'))), false);
  const steps = engine => Object.entries(engine).filter(([key, list]) => Array.isArray(list) && (key === 'steps' || /-(steps|trigger)$/.test(key))).flatMap(([, list]) => list);
  for (const name of engineNames()) assert.ok(!steps(engines[name] ?? {}).some(s => Object.hasOwn(s, 'merges-awaited')), name);
});

test('ASS-365: the validator keeps merges-awaited true or false, and on a step running grouped-build it must read the run\'s blocked-for-human end; pass-output is a list of field names on a state-engine step', () => {
  const top = (fields, exits = []) => ({ steps: [
    { id: 'build', sequence: 1, name: 'Build', action: { type: 'state-engine', engine: 'grouped-build' }, ...fields, 'exit-events': [...exits, { condition: { 'is-done': true }, 'move-to-state': 'done' }] },
    { id: 'blocked-for-human', sequence: 2, name: 'BfH', 'is-done': true, action: { type: 'none' } },
    { id: 'done', sequence: 3, name: 'Done', 'is-done': true, action: { type: 'none' } }] });
  const bfh = { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked-for-human' }] }, 'move-to-state': 'blocked-for-human' };
  assert.deepEqual(errorsFor(top({ 'merges-awaited': true }, [bfh])), []);
  assert.deepEqual(errorsFor(top({ 'merges-awaited': false })), []);
  assert.ok(errorsFor(top({ 'merges-awaited': true })).some(e => /has merges-awaited but no exit for sub-engine-ended-at "blocked-for-human"/.test(e)));
  assert.ok(errorsFor(top({ 'merges-awaited': 'yes' }, [bfh])).some(e => /merges-awaited "yes" is not true or false/.test(e)));
  assert.deepEqual(errorsFor(top({ 'pass-output': ['merge-request-ids'] })), []);
  assert.ok(errorsFor(top({ 'pass-output': 'merge-request-ids' })).some(e => /pass-output is not a list of field names/.test(e)));
  const plain = { steps: [{ id: 'a', sequence: 1, name: 'a', action: { type: 'none' }, 'pass-output': ['x'], 'exit-events': [{ condition: { always: true }, 'move-to-state': 'b' }] }, { id: 'b', sequence: 2, name: 'b', 'is-done': true, action: { type: 'none' } }] };
  assert.ok(errorsFor(plain).some(e => /has pass-output but is no state-engine step/.test(e)));
});
