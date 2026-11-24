// ASS-556: the work-mode commands. ticket:choose-work-mode records where a variation is built from Choose Where to
// Work's answer (AC1) with the project's forced rules over it (AC2); ticket:escalate-work-mode moves a worktree
// variation to full on each trigger, once, and nothing moves it back but the operator (AC4); ticket:set-work-mode is
// the operator's override (AC5); a ci escalation retains a Hindsight memory of why, and merge-request:check records
// the CI results (AC6, its check in sync-merge-requests' fixture below); {work-mode-rule} tells a worktree
// variation's agents when to escalate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, STAMP } from './harness-fixture.js';
import { fakeHindsight } from '../support/fake-hindsight.js';

const RUN = 'bbbbbbbb-0000-4000-8000-000000000556';
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const CAPABLE = { 'run-targets': ['local-substrate', 'local-worktree'], substrate: { clusters: [{ machine: 'mac' }] } };

// The fixture's project p able to build in a worktree (or not), with work-mode rules, and a plan run for ABC-3 A
// whose structured-output is `output`; the plan names `plan`'s files.
function setup({ dev = CAPABLE, rules, output = {}, points = 2, plan = '' } = {}) {
  const f = fixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { if (dev) p['dev-environments'] = dev; if (rules) p['work-mode'] = rules; });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].points = points; s.features[0].title = 'Add the export'; });
  edit(join(f.dir, 'assignments.json'), a => a['transient-state-engines'].push({ id: RUN, project: 'p', 'state-engine': 'grouped-plan', state: 'record-work-mode', parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'plan' }, 'is-done': false, 'structured-output': { 'is-approved': true, ...output } }));
  if (plan) { mkdirSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3'), { recursive: true }); writeFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'execution-plan-A.md'), plan); }
  return f;
}
const choose = f => f.agent('ticket:choose-work-mode', 'p', 'ABC-3', 'A', RUN);
const mode = f => f.variation('A')['work-mode'];

test('ASS-556 AC1: ticket:choose-work-mode records the AI\'s mode and reasons on the variation, with the files, its own choice and its history', async () => {
  const f = setup({ output: { 'work-mode': 'worktree', 'work-mode-reasons': ['2 points, one module', 'unit tests cover it'], 'work-mode-files': ['src/export.js'] }, plan: 'Change `src/export.js` and test/export.test.js.' });
  const { stdout } = await choose(f);
  assert.deepEqual(JSON.parse(stdout), { 'work-mode': 'worktree', by: 'ai', reasons: ['2 points, one module', 'unit tests cover it'], ai: { mode: 'worktree', reasons: ['2 points, one module', 'unit tests cover it'] }, forced: [] });
  const w = mode(f);
  assert.equal(w.mode, 'worktree');
  assert.equal(w.by, 'ai');
  assert.match(w.at, STAMP);
  assert.deepEqual(w.files, ['src/export.js', 'test/export.test.js']);
  assert.equal(w.ai.mode, 'worktree');
  assert.deepEqual(w.escalations, []);
  assert.deepEqual(w.history.map(h => [h.mode, h.by]), [['worktree', 'ai']]);
});

test('ASS-556 AC1: no valid answer from the AI is full by default; a project that lists no worktree target is always full', async () => {
  let f = setup({ output: {} });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).by, mode(f).reasons], ['full', 'rule', ['no valid work mode from Choose Where to Work; full by default']]);
  f = setup({ dev: null, output: { 'work-mode': 'worktree', 'work-mode-reasons': ['small'] } });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).by], ['full', 'rule']);
  assert.match(mode(f).reasons[0], /lists no worktree run target/);
  assert.equal(mode(f).ai.mode, 'worktree', 'the AI\'s own choice is kept beside it');
});

test('ASS-556 AC2: the project\'s forced rules override the AI: a path glob the plan touches, a points floor, then work-mode.force', async () => {
  const rules = { 'force-full': [{ paths: ['db/migrations/**', '**/*.tf'], why: 'migrations and infrastructure need the stack' }, { 'min-points': 8 }] };
  const worktree = { 'work-mode': 'worktree', 'work-mode-reasons': ['small'] };
  // A file the AI named matches.
  let f = setup({ rules, output: { ...worktree, 'work-mode-files': ['db/migrations/0042_add_index.sql'] } });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).by], ['full', 'rule']);
  assert.deepEqual(mode(f).forced, ['migrations and infrastructure need the stack (db/migrations/0042_add_index.sql matches db/migrations/**, **/*.tf)']);
  assert.deepEqual(mode(f).reasons, mode(f).forced);
  assert.equal(mode(f).ai.mode, 'worktree');
  // A file only the plan names matches, deep in folders.
  f = setup({ rules, output: worktree, plan: 'Edit infra/env/prod/main.tf to add the bucket.' });
  await choose(f);
  assert.equal(mode(f).mode, 'full');
  // The points floor.
  f = setup({ rules, output: worktree, points: 8 });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).forced], ['full', ['forced full by the project: 8 points, at least 8']]);
  // Nothing matches: the AI's.
  f = setup({ rules, output: { ...worktree, 'work-mode-files': ['src/a.js'] }, points: 3 });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).by], ['worktree', 'ai']);
  // work-mode.force, every ticket — under the rules that force full.
  f = setup({ rules: { force: 'full' }, output: worktree });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).by, mode(f).reasons], ['full', 'rule', ['the project forces full (work-mode.force)']]);
  f = setup({ rules: { force: 'worktree' }, output: { 'work-mode': 'full', 'work-mode-reasons': ['risky'] } });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).by], ['worktree', 'rule']);
});

test('ASS-556 AC4: ticket:escalate-work-mode moves a worktree variation to full on each trigger — tests, review, ci — once, recorded with its trigger, why and step; never back by a later choice', async () => {
  for (const trigger of ['tests', 'review', 'ci']) {
    const f = setup({ output: { 'work-mode': 'worktree', 'work-mode-reasons': ['small'] } });
    await choose(f);
    const first = JSON.parse((await f.agent('ticket:escalate-work-mode', 'p', 'abc-3', 'A', trigger, `needs the stack for ${trigger}`)).stdout);
    assert.equal(first.escalated, true, trigger);
    assert.equal(first['work-mode'], 'full');
    let w = mode(f);
    assert.deepEqual([w.mode, w.by, w.reasons], ['full', 'escalation', [`${trigger}: needs the stack for ${trigger}`]]);
    assert.deepEqual(w.escalations.map(e => [e.trigger, e.why, e.from, e.step]), [[trigger, `needs the stack for ${trigger}`, 'worktree', 'generate-solution']]);
    assert.deepEqual(w.history.map(h => [h.mode, h.by, h.trigger ?? null]), [['worktree', 'ai', null], ['full', 'escalation', trigger]]);
    // Once: a second call changes nothing.
    const again = JSON.parse((await f.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'A', 'tests', 'again')).stdout);
    assert.deepEqual([again.escalated, again['work-mode']], [false, 'full']);
    assert.equal(mode(f).escalations.length, 1);
    // Never back automatically: Plan run again, the AI choosing worktree, keeps it full.
    await choose(f);
    w = mode(f);
    assert.deepEqual([w.mode, w.by], ['full', 'escalation'], trigger);
    assert.equal(w.ai.mode, 'worktree');
  }
});

test('ASS-556 AC4: escalating a variation not in worktree mode (full, or none chosen) does nothing; bad arguments fail writing nothing', async () => {
  const f = setup({ output: { 'work-mode': 'full', 'work-mode-reasons': ['risky'] } });
  const none = JSON.parse((await f.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'A', 'tests', 'x')).stdout);
  assert.deepEqual([none.escalated, none['work-mode']], [false, 'unset']);
  await choose(f);
  const full = JSON.parse((await f.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'A', 'review', 'x')).stdout);
  assert.deepEqual([full.escalated, full['work-mode']], [false, 'full']);
  assert.deepEqual(mode(f).escalations, []);
  const before = f.snapshot();
  await assert.rejects(f.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'A', 'lint', 'x'), e => /usage: ticket:escalate-work-mode/.test(e.stderr));
  await assert.rejects(f.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'Z', 'ci', 'x'), e => /no ABC-3 variation Z/.test(e.stderr));
  assert.equal(f.snapshot(), before);
});

test('ASS-556 AC5: ticket:set-work-mode is the operator\'s override — kept by a later choice, the only way back to worktree after an escalation; refused for a project with no worktree target', async () => {
  const f = setup({ output: { 'work-mode': 'worktree', 'work-mode-reasons': ['small'] } });
  await choose(f);
  await f.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'A', 'review', 'auth change');
  const { stdout } = await f.agent('ticket:set-work-mode', 'p', 'ABC-3', 'A', 'worktree', 'reviewed: the auth part is a rename');
  assert.deepEqual(JSON.parse(stdout), { ticket: 'ABC-3', variation: 'A', 'work-mode': 'worktree', by: 'operator' });
  assert.deepEqual([mode(f).mode, mode(f).by, mode(f).reasons], ['worktree', 'operator', ['reviewed: the auth part is a rename']]);
  assert.equal(mode(f).escalations.length, 1, 'the escalation stays in the record');
  // A later Choose Where to Work keeps the operator's choice.
  edit(join(f.dir, 'assignments.json'), a => { a['transient-state-engines'].find(r => r.id === RUN)['structured-output']['work-mode'] = 'full'; });
  await choose(f);
  assert.deepEqual([mode(f).mode, mode(f).by], ['full', 'escalation'], 'an escalation on record keeps it full on a re-plan');
  await f.agent('ticket:set-work-mode', 'p', 'ABC-3', 'A', 'full');
  assert.deepEqual([mode(f).mode, mode(f).by, mode(f).reasons], ['full', 'operator', ['set by the operator']]);
  // No worktree target: worktree refused (3), nothing written.
  const g = setup({ dev: null });
  const before = g.snapshot();
  await assert.rejects(g.agent('ticket:set-work-mode', 'p', 'ABC-3', 'A', 'worktree'), e => e.code === 3 && /lists no worktree run target/.test(e.stderr));
  await assert.rejects(g.agent('ticket:set-work-mode', 'p', 'ABC-3', 'A', 'sideways'), e => /usage: ticket:set-work-mode/.test(e.stderr));
  assert.equal(g.snapshot(), before);
  await g.agent('ticket:set-work-mode', 'p', 'ABC-3', 'A', 'full');
  assert.equal(mode(g).mode, 'full');
});

test('ASS-556 AC6: a worktree variation escalated for its merge request\'s CI retains a Hindsight memory of why; Hindsight down never fails the escalation', async t => {
  const hindsight = await fakeHindsight();
  t.after(() => hindsight.close());
  const f = setup({ output: { 'work-mode': 'worktree', 'work-mode-reasons': ['small'], 'work-mode-files': ['src/billing/invoice.js'] } });
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p.hindsight = { port: hindsight.port, 'llm-api-key': null }; });
  await choose(f);
  const out = JSON.parse((await f.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'A', 'ci', 'the e2e job needs the billing service')).stdout);
  assert.equal(out.memory, 'retained');
  const [memory] = hindsight.banks.get('p');
  assert.equal(memory.document_id, 'work-mode-ci-abc-3-a');
  assert.deepEqual(memory.metadata, { ticket: 'ABC-3', kind: 'work-mode-ci' });
  assert.match(memory.text, /^ABC-3 \(Add the export\) was built in a worktree, and its merge request's CI failed on something the worktree could not catch: the e2e job needs the billing service\. The plan touched src\/billing\/invoice\.js\./);
  assert.equal(mode(f).escalations[0].memory, 'retained');
  // Not ci: no memory. Hindsight down: escalated all the same, said.
  const g = setup({ output: { 'work-mode': 'worktree' } });
  edit(join(g.dir, 'projects', 'p', 'project.json'), p => { p.hindsight = { port: 1, 'llm-api-key': null }; });
  await choose(g);
  const down = await g.agent('ticket:escalate-work-mode', 'p', 'ABC-3', 'A', 'ci', 'needs the queue');
  assert.equal(JSON.parse(down.stdout).escalated, true);
  assert.match(down.stderr, /not retained: p's Hindsight did not answer/);
  assert.match(mode(g).escalations[0].memory, /^not retained/);
});

test('ASS-556: {work-mode-rule} tells a worktree variation\'s agent what it lacks and how to escalate; in full mode, or none chosen, the paragraph is left out', async () => {
  const f = setup({ output: { 'work-mode': 'worktree' } });
  const promptFile = join(f.dir, 'prompts', 'generate-solution', 'prompt.txt');
  writeFileSync(promptFile, 'Build {ticket}.\n\n{work-mode-rule}\n\nDone.\n');
  const dispatched = async () => { await f.agent('agent:dispatch', 'Daredevil'); return f.inbox('Daredevil').at(-1) ?? ''; };
  const plain = await dispatched();
  assert.doesNotMatch(plain, /Work mode|work-mode-rule/);
  assert.match(plain, /Build ABC-3\.\n\nDone\./);
  await choose(f);
  const told = await dispatched();
  assert.match(told, /Work mode: variation A is built in a worktree/);
  assert.match(told, /agent\.sh ticket:escalate-work-mode p ABC-3 A <trigger> "<why, one line>"/);
  assert.doesNotMatch(told, /\{work-mode-rule\}|\{agent-sh\}/);
});
