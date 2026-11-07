// The grouped engines' ticket health check (ASS-124): an environment issue it
// finds is repaired as Blocked repairs one (ASS-97) — the sampled ticket
// handed to its own Blocked at the repair step (ticket:repair-environment),
// so the same step, in the same place, under the same limits, does it — and
// comes to the operator, at Blocked for Human, only when that repair fails or
// may not be made. No fix ticket is raised for it. The current engines'
// check (check-ticket-health, harness-development's) stays as it was. Walked
// with control's own reading of an engine (src/control/engine.js nextState).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState } from '../../src/control/engine.js';
import { problemOf } from '../../src/control/facts.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { engineDir, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
const health = read('check-ticket-health-grouped');
const after = (engine, id, facts) => nextState(stepOf(engine, id), engine, { turnComplete: true, ...facts }, [])?.to;

test('the grouped engines\' ticket health check is valid, and the one harness-development-grouped samples with; harness-development keeps the current check', () => {
  assert.deepEqual(validateStateEngine(health, ROOT, undefined, EXAMPLE_ENGINES), []);
  assert.equal(read('harness-development-grouped')['check-ticket-health-steps'][0].action.engine, 'check-ticket-health-grouped');
  assert.equal(read('harness-development')['check-ticket-health-steps'][0].action.engine, 'check-ticket-health');
});

test('AC1/AC3: an environment issue goes to the repair, handed to the sampled ticket\'s own Blocked; a harness or project issue still raises its fix ticket; a healthy ticket nothing', () => {
  assert.equal(after(health, 'inspect-ticket', { structuredOutput: { 'is-healthy': true } }), 'done');
  assert.equal(after(health, 'inspect-ticket', { structuredOutput: { 'is-healthy': false } }), 'classify');
  assert.equal(stepOf(health, 'classify').action.prompt, 'classify-issue');
  for (const issue of ['harness', 'project']) assert.equal(after(health, 'classify', { structuredOutput: { issue } }), 'create-ticket', issue);
  assert.equal(after(health, 'classify', { structuredOutput: { issue: 'environment' } }), 'repair-environment', 'no fix ticket for an environment issue');
  const repair = stepOf(health, 'repair-environment');
  assert.equal(repair.action.command, './agent.sh ticket:repair-environment {run}');
  assert.equal(after(health, 'repair-environment', { exitCode: 0 }), 'done', 'handed over: the health check is done, the log its line');
  assert.equal(after(health, 'repair-environment', { exitCode: 1 }), 'done', 'a failure is logged, the check done');
  assert.equal(after(health, 'repair-environment', { exitCode: 2 }), undefined, 'an agent at work on the ticket: it waits, the script tried again on its timer');
  assert.deepEqual([repair.action.mode, repair.action['timer-minutes']], ['timer', 1]);
  // Nothing after the repair raises a ticket: create-ticket is reached from Classify's harness and project exits alone.
  const into = health.steps.flatMap(s => (s['exit-events'] ?? []).filter(e => e['move-to-state'] === 'create-ticket').map(e => [s.id, e.condition.all?.[1]?.['structured-output']?.issue]));
  assert.deepEqual(into, [['classify', 'harness'], ['classify', 'project']]);
});

// The sampled ticket's own Blocked from the step ticket:repair-environment enters it at, its run seeded with
// what the check found: { end, output } once done, and where the ticket goes then (from build: build, its return-to-state).
const FOUND = { summary: 'node_modules predates the lockfile', issue: 'environment', reasoning: 'stale install', 'human-action': 'Reinstall dependencies' };
function blocked(start, repair) {
  const engine = read('grouped-blocked');
  let at = start, output = { ...FOUND };
  for (let i = 0; !stepOf(engine, at)['is-done']; i++) {
    assert.ok(i < 10, at);
    output = { ...output, ...repair };
    at = after(engine, at, { structuredOutput: output });
  }
  const goes = top => nextState(stepOf(read(top), 'blocked'), read(top), { subEngineDone: true, subEngineState: at, structuredOutput: output }, [{ 'from-state': 'build', 'to-state': 'blocked' }]).to;
  return { end: at, output, goes: ['harness-development-grouped', 'example-development-grouped'].map(goes) };
}

test('AC4: repaired — Blocked\'s own repair step (in the VM, or on the host while there is none), given what the check found; the ticket resumes where it was, and nothing else happens', () => {
  for (const start of ['repair-environment', 'repair-environment-on-host']) {
    const run = blocked(start, { remediated: true, 'ai-feedback-short': 'Reinstalled', 'ai-feedback-long': 'L' });
    assert.deepEqual([run.end, run.goes], ['done', ['build', 'build']], start);
  }
  const problem = problemOf({ id: 'b', project: 'example', parent: { 'work-item': 'X-1', variation: 'A' }, 'structured-output': FOUND }, [], { harness: { 'harness-project': 'harness' } });
  assert.match(problem, /^Summary: node_modules predates the lockfile$/m, 'the repair prompt\'s {problem}: what the check found');
  assert.match(problem, /^Classified: .*stale install$/m);
  assert.equal(stepOf(read('grouped-blocked'), 'repair-environment').action.prompt, 'repair-environment-grouped');
  assert.equal(stepOf(read('grouped-blocked'), 'repair-environment-on-host').action.prompt, 'repair-environment-on-host-grouped');
});

test('AC4: repair failed, or not allowed by the repair step (a credential, the shared checkout) — the ticket goes to Blocked for Human with what was found and what to do', () => {
  for (const start of ['repair-environment', 'repair-environment-on-host']) {
    const run = blocked(start, { remediated: false, 'ai-feedback-short': 'Re-login to the registry', 'ai-feedback-long': 'Token expired: a credential' });
    assert.deepEqual([run.end, run.goes], ['blocked-for-human', ['blocked-for-human', 'blocked-for-human']], start);
    assert.equal(run.output['ai-feedback-short'], 'Re-login to the registry', 'what to do: the variation\'s ai-feedback, as Blocked for Human shows it');
  }
  // Not allowed by the ticket's engine (its Blocked makes no repair: the current engines'): straight to Blocked for Human — test/agent-cli/repair-environment.test.js.
  assert.ok(!read('blocked').steps.some(s => s.id.startsWith('repair-environment')), 'the current engines\' Blocked makes no repair');
});

// ASS-240 AC1: EX-1074's and EX-2493's checks said "healthy", missing a seat overflow and a failed create-vm. The grouped
// check has its own prompt, given the ticket project's limits and seat holders ({seats}, control's dispatch) and
// pointed at the variation's last-script-failure; the current engines' prompt stays as it was.
test('ASS-240 AC1: the grouped check\'s own prompt is given the seats and reads the last script failure; the current prompt is unchanged', () => {
  assert.equal(stepOf(health, 'inspect-ticket').action.prompt, 'check-ticket-health-grouped');
  assert.equal(stepOf(read('check-ticket-health'), 'inspect-ticket').action.prompt, 'check-ticket-health');
  const text = p => readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8');
  const grouped = text('check-ticket-health-grouped'), flat = text('check-ticket-health');
  assert.match(grouped, /\{seats\}/);
  assert.match(grouped, /over-the-limits/);
  assert.match(grouped, /last-script-failure/);
  assert.match(grouped, /ticket\.json is a snapshot/);
  assert.doesNotMatch(flat, /seats|last-script-failure/);
  const args = JSON.parse(readFileSync(join(ROOT, 'prompts', 'check-ticket-health-grouped', 'prompt.json'), 'utf8'))['input-arguments'].map(a => a.name);
  assert.ok(args.includes('seats'), args.join());
});
