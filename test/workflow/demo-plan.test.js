// ASS-76 AC1: planning writes each ticket variation's demo plan alongside its
// test plan, in both the current engines and the grouped Plan, and Review Plan
// shows it. The demo plan's shape is ticket:demo-plan's (test/agent-cli/demo-plan.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { engineDir, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const prompt = name => readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8');
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
const promptAt = (name, id) => engine(name).steps.find(s => s.id === id).action.prompt;
const PLANNING = ['harness-development', 'example-development', 'grouped-plan'];

test('Write Test Plan writes the variation\'s demo plan into the ticket\'s folder, in the current engines and the grouped Plan', () => {
  for (const name of PLANNING) {
    const text = prompt(promptAt(name, 'write-test-plan'));
    assert.match(text, /\{ticket-folder\}\/demo-plan-\{variation\}\.json/, name);
    for (const field of ['"setup"', '"ready-check"', '"view"', '"look-at"', '"demo": false']) assert.ok(text.includes(field), `${name}: ${field}`);
  }
});

test('Review Plan reads the demo plan through ticket:demo-plan, shows it in plan-review.md, and sends back a missing or malformed one', () => {
  // ASS-231: the grouped Plan's is its own copy, review-plan-grouped.
  for (const name of PLANNING) {
    const text = prompt(promptAt(name, 'review-plan'));
    assert.match(text, /\{agent-sh\} ticket:demo-plan \{project\} \{ticket\} \{variation\}/, name);
    assert.match(text, /## Demo plan/, name);
    assert.match(text, /fails.*"is-approved": false|"is-approved": false.*fails/s, name);
  }
});

test('the grouped Plan\'s Review Plan, run in the VM, may call ticket:demo-plan through the forwarder', () => {
  assert.equal(engine('grouped-plan').steps.find(s => s.id === 'review-plan')['run-location'], 'vm');
  assert.deepEqual(validateStateEngine(engine('grouped-plan'), ROOT, undefined, EXAMPLE_ENGINES).filter(e => e.includes('demo-plan')), []);
  const allowed = JSON.parse(readFileSync(join(ROOT, 'src', 'control', 'forwarder-allowlist.json'), 'utf8'));
  assert.deepEqual(allowed['ticket:demo-plan'], { project: 0, ticket: 1, variation: 2 });
});

// ASS-222: a rework that re-pins the upstream must carry the demo plan with it.
// Grouped prompts only; the flat prompts stay as they are.
test('ASS-222 AC1: the grouped Generate Solution re-checks the demo plan against the final change and re-records it through ticket:set-demo-plan', () => {
  for (const name of ['grouped-build', 'v2-build']) assert.equal(promptAt(name, 'generate-solution'), 'generate-solution-grouped', name);
  const text = prompt('generate-solution-grouped');
  assert.match(text, /\{agent-sh\} ticket:demo-plan \{project\} \{ticket\} \{variation\}/);
  assert.match(text, /pinned commits, refs or expected output/);
  assert.match(text, /\{agent-sh\} ticket:set-demo-plan \{project\} \{ticket\} \{variation\}/);
  assert.doesNotMatch(prompt('generate-solution'), /ticket:set-demo-plan/, 'flat prompt unchanged');
});

test('ASS-222 AC2: the grouped Write Test Plan names moving upstream branches and pins a commit only for a deliberate "before" state', () => {
  for (const name of ['grouped-plan', 'v2-plan']) assert.equal(promptAt(name, 'write-test-plan'), 'write-test-plan-grouped', name);
  const text = prompt('write-test-plan-grouped');
  assert.match(text, /by branch name \(e\.g\. `origin\/master`\)/);
  assert.match(text, /pin a commit only for a deliberate "before" state/);
  assert.doesNotMatch(prompt('write-test-plan'), /deliberate "before" state/, 'flat prompt unchanged');
});
