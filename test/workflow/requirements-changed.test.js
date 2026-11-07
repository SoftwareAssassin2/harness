// The requirements-changed workflow (ASS-79): a transient detour off the
// grouped and v2 development engines, structured like Blocked — a top-level
// requirements-changed step running grouped-requirements-changed, entered by
// ticket:requirements-changed (ticket:take-new's seam, ASS-78) from a step
// flagged recheck-on-requirements-change. It revises the variation's
// acceptance criteria from the new description, judges the work (as built, or
// the plan when nothing is built yet) against every one in the variation's VM,
// and hands the variation back to the step it was in when all pass, else to
// Root Cause Analysis with the reason written first. Walked with control's own
// reading of an engine (src/control/engine.js nextState), each step's facts
// faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { working, engineDir, engineNames, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engines = Object.fromEntries(engineNames().filter(d => existsSync(join(engineDir(d), 'state-engine.json')))
  .map(d => [d, JSON.parse(readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8'))]));
const WORKFLOW = 'grouped-requirements-changed';
const TOPS = ['harness-development-v2', 'harness-development-grouped', 'example-development-grouped'];
const flagged = top => engines[top].steps.filter(s => s['recheck-on-requirements-change'] === true).map(s => s.id);

// walk(answers) — a run walked from its first step to a done step: each
// step's facts these defaults (a turn done, its file written, criteria
// recorded, the verdict all passing), overridden by answers[<step>] — an
// object, or a list by visit. Returns { trail, end }.
function walk(answers = {}) {
  const engine = engines[WORKFLOW], trail = [], changes = [], visits = new Map();
  for (let at = firstStepId(engine), i = 0; i < 100; i++) {
    trail.push(at);
    const step = stepOf(engine, at);
    if (step['is-done']) return { trail, end: at };
    const n = visits.get(at) ?? 0;
    visits.set(at, n + 1);
    const answer = Array.isArray(answers[at]) ? answers[at][Math.min(n, answers[at].length - 1)] : answers[at];
    const f = { turnComplete: true, exitCode: 0, fileUpdated: () => true, variation: { 'acceptance-criteria': [{ 'criteria-number': 1 }] }, ...answer };
    const next = nextState(step, engine, f, changes);
    assert.ok(next?.to, `${at}: no exit`);
    changes.push({ 'from-state': at, 'to-state': next.to });
    at = next.to;
  }
  throw new Error(`ran away: ${trail.slice(-10).join(' ')}`);
}
// Where the variation goes when its run ends at `end`, having come from `from`.
const parent = (top, from, end) => nextState(stepOf(engines[top], 'requirements-changed'), engines[top], { subEngineDone: true, subEngineState: end }, [{ 'from-state': from, 'to-state': 'requirements-changed' }]);

test('the workflow and the development engines entering it are valid; each runs it from a requirements-changed step, a detour like Blocked: off the conveyor, handing back where the variation came from, its VM running, the ticket system left as it was', () => {
  for (const name of [WORKFLOW, ...TOPS]) assert.deepEqual(validateStateEngine(engines[name], ROOT, name, EXAMPLE_ENGINES), [], name);
  for (const top of TOPS) {
    const step = stepOf(engines[top], 'requirements-changed');
    assert.deepEqual(step.action, { type: 'state-engine', engine: WORKFLOW }, top);
    assert.deepEqual([step.area, step['follow-return-to-state'], step['return-to-state'], step.vm, step['paired-ticket-system-status']], ['quarantine', true, undefined, 'running', undefined], top);
  }
  assert.deepEqual(working(stepOf(engines['harness-development-v2'], 'requirements-changed')), working(stepOf(engines['harness-development-grouped'], 'requirements-changed')));   // what it does, its wording aside (ASS-258)
});

test('AC1: Revise Acceptance Criteria first, in the VM — it goes on once requirements-change.md is written this turn and the variation has criteria; else it runs again, at most 3 times, then Blocked', () => {
  assert.equal(firstStepId(engines[WORKFLOW]), 'revise-acceptance-criteria');
  const revise = stepOf(engines[WORKFLOW], 'revise-acceptance-criteria');
  assert.deepEqual([revise.action.prompt, revise['run-location'], revise['max-visits'], revise['on-max-visits']], ['revise-acceptance-criteria', 'vm', 3, 'blocked']);
  assert.deepEqual(walk().trail, ['revise-acceptance-criteria', 'judge', 'verdict', 'done']);
  const unwritten = walk({ 'revise-acceptance-criteria': { fileUpdated: file => file !== 'requirements-change.md' } });
  assert.deepEqual(unwritten.trail, ['revise-acceptance-criteria', 'revise-acceptance-criteria', 'revise-acceptance-criteria', 'blocked']);
  const none = walk({ 'revise-acceptance-criteria': { variation: { 'acceptance-criteria': [] } } });
  assert.equal(none.end, 'blocked');
});

test('AC2: Judge, in the VM — its structured output a verdict per revised criterion (criteria-number, passes, reason); Verdict, on the host, decides from them (ticket:requirements-change-verdict)', () => {
  const judge = stepOf(engines[WORKFLOW], 'judge');
  assert.deepEqual([judge.action.prompt, judge['run-location'], judge['max-visits']], ['judge-requirements-change', 'vm', 3]);
  const schema = JSON.parse(readFileSync(join(ROOT, 'prompts', 'judge-requirements-change', 'prompt.json'), 'utf8')).output;
  assert.deepEqual(schema.required, ['criteria']);
  assert.deepEqual(schema.properties.criteria.items.required, ['criteria-number', 'passes', 'reason']);
  const verdict = stepOf(engines[WORKFLOW], 'verdict');
  assert.deepEqual([verdict.action.command, verdict['run-location']], ['./agent.sh ticket:requirements-change-verdict {project} {work-item} {variation} {run}', undefined]);
});

test('AC3: every criterion passing, the variation returns to the step it was in (the start of that group); any failing (verdict exit 3), into Plan at Root Cause Analysis; a verdict that cannot be told, Blocked — which hands it back to that group too', () => {
  assert.equal(walk().end, 'done');
  assert.equal(walk({ verdict: { exitCode: 3 } }).end, 'rca');
  assert.equal(walk({ verdict: { exitCode: 1 } }).end, 'blocked');
  for (const top of TOPS) {
    assert.ok(flagged(top).length >= 6, top);
    for (const from of flagged(top)) {
      assert.equal(parent(top, from, 'done').to, stepOf(engines[top], from)['return-to-state'], `${top}: back to ${from}`);
      const rca = parent(top, from, 'rca');
      assert.deepEqual([rca.to, rca.exit['start-sub-engine-at']], ['plan', 'root-cause-analysis'], `${top} from ${from}`);
      assert.equal(parent(top, from, 'blocked').to, 'blocked', top);
      // Blocked, entered from the workflow, hands the variation back to the group it was in.
      const changes = [{ 'from-state': from, 'to-state': 'requirements-changed' }, { 'from-state': 'requirements-changed', 'to-state': 'blocked' }];
      assert.equal(nextState(stepOf(engines[top], 'blocked'), engines[top], { subEngineDone: true, subEngineState: 'done' }, changes).to, from, top);
    }
    assert.ok(stepOf(engines[stepOf(engines[top], 'plan').action.engine], 'root-cause-analysis'), top);
  }
});
