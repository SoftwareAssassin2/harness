// example-github-development: the example GitHub project's own engine, harness-development-v2
// but for Release and backlog refinement. Release's sub-engine is
// example-github-release: v2-release's Merge Pull Request alone, straight to done — no
// Update the Harness (nothing after the merge reads the local checkout: the
// gate fetches origin, agents clone in their VMs) and no Request a Restart or
// Await the Restart (the example GitHub project's merges are not the harness's code).
// Its merge gate runs the project repo's own tests, ./system.sh test (it has no
// root package.json for npm test). Backlog refinement is
// example-github-backlog-refinement, harness-backlog-refinement under the example GitHub project's name
// as it was before ASS-252's Split. ASS-258: the copies are compared by what
// their shared steps do (working: their wording and order aside), so either
// engine may be reworded or gain a step without breaking these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepOf } from '../../src/control/engine.js';
import { loadEngines, walk, sameShared, listsOf } from '../support/engine-walk.js';

const engines = loadEngines();
const engine = name => engines[name];
const GITHUB = ['example-github-development', 'example-github-release', 'example-github-backlog-refinement'];
const runs = (name, text) => engine(name).steps.some(s => JSON.stringify(s.action).includes(text));

test('example-github-development is harness-development-v2 but for Release, which runs example-github-release, and backlog refinement, which runs example-github-backlog-refinement', () => {
  const github = engine('example-github-development'), v2 = engine('harness-development-v2');
  assert.equal(stepOf(github, 'release').action.engine, 'example-github-release');
  assert.ok(github['backlog-refinement-steps'].some(s => s.action.engine === 'example-github-backlog-refinement'));
  const asV2 = s => ({ ...s, action: { ...s.action, ...(s.action.engine && { engine: s.action.engine.replace('example-github-release', 'v2-release').replace('example-github-backlog-refinement', 'harness-backlog-refinement') }) } });
  sameShared(github, v2, { as: asV2 });
  assert.deepEqual(listsOf(github).toSorted(), listsOf(v2).toSorted());
});

test('example-github-release merges the example GitHub project\'s pull request in its turn — its gate running ./system.sh test — and goes straight to done: no Update the Harness, no restart', () => {
  const merge = stepOf(engine('example-github-release'), 'merge-pull-request');
  assert.match(merge.action.command, /^\.\/agent\.sh merge-request:merge-in-turn .* \.\/system\.sh test$/);
  const r = walk(engines, 'example-github-release', { given: { scriptOutput: { waiting: false } } });
  assert.deepEqual([r.end, r.rests], ['done', false]);
  for (const text of ['code:update-workspace', 'harness:request-restart', 'harness:restarted']) assert.ok(!runs('example-github-release', text), text);
  // Its steps but the merge work as v2-release's; the merge as v2-release's but for its gate's tests and its going straight to done.
  const v2Merge = stepOf(engine('v2-release'), 'merge-pull-request');
  sameShared(engine('example-github-release'), engine('v2-release'), { as: s => (s.id !== 'merge-pull-request' ? s : {
    ...s, action: { ...s.action, command: s.action.command.replace(/ \.\/system\.sh test$/, ' npm test') },
    'exit-events': s['exit-events'].map((e, i) => (i === 0 ? { ...e, 'move-to-state': v2Merge['exit-events'][0]['move-to-state'] } : e)),
  }) });
});

// ASS-252: the harness's own refinement splits a ticket too large; the example GitHub project's does not. ASS-264: the
// example GitHub project's notes an estimate above its scale (8 or 13) and rests it at Too Large for the operator, and
// bounds Estimate with max-visits (example-github-too-large.test.js) — its own steps, which the harness's lacks.
// ASS-265: the operator's Split at Too Large runs ASS-252's Split — the same prompt and apply — but
// through the example GitHub project's own steps: no Check Kept Whole or Keep whole, a proposal checked, and every way
// back to Too Large (example-github-split.test.js).
const SPLIT = ['check-kept-whole', 'split', 'awaiting-split-decision', 'create-split-tickets', 'keep-whole', 'superseded'];
const TOO_LARGE = ['note-estimate-8', 'note-estimate-13', 'too-large'];
const GITHUB_SPLIT = ['split', 'check-split-proposal', 'awaiting-split-decision', 'create-split-tickets', 'superseded'];
test('example-github-backlog-refinement is harness-backlog-refinement as it was before Split (ASS-252): its Estimate the shared estimate prompt, straight to Ready — but for 8 and 13, to Too Large (ASS-264), where the operator may Split (ASS-265)', () => {
  const harness = engine('harness-backlog-refinement'), github = engine('example-github-backlog-refinement');
  for (const id of ['check-kept-whole', 'keep-whole']) assert.equal(stepOf(github, id), undefined, id);
  for (const id of TOO_LARGE) assert.equal(stepOf(harness, id), undefined, id);
  assert.equal(stepOf(github, 'estimate').action.prompt, 'estimate');
  // Estimate works as the harness's but for its prompt, its exits towards Split, and its way to Too Large (exits and max-visits).
  const { 'max-visits': _, 'on-max-visits': __, ...bounded } = stepOf(github, 'estimate');
  // The example GitHub project's Split steps are its own (example-github-split.test.js): left out here.
  const shared = { ...github, steps: github.steps.filter(s => !GITHUB_SPLIT.includes(s.id)) };
  sameShared(shared, harness, {
    as: s => (s.id !== 'estimate' ? s : { ...bounded, action: { ...s.action, prompt: 'estimate-with-split' }, 'exit-events': s['exit-events'].filter(x => !TOO_LARGE.includes(x['move-to-state'])) }),
    asReference: s => (s.id !== 'estimate' ? s : { ...s, 'exit-events': s['exit-events'].filter(x => !SPLIT.includes(x['move-to-state'])) }) });
  for (const exit of stepOf(github, 'estimate')['exit-events']) assert.ok(!SPLIT.includes(exit['move-to-state']), JSON.stringify(exit));
});

test('no example GitHub engine names the harness but Self Healing, whose fix ticket is the harness\'s own', () => {
  for (const name of GITHUB) {
    const { steps, ...rest } = engine(name);
    const named = JSON.stringify({ ...rest, steps: steps.filter(s => s.id !== 'self-healing') }).match(/harness(?!-development-v2\b)/gi) ?? [];
    assert.deepEqual(named, [], name);
  }
});
