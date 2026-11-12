// ASS-390 AC5: Blocked's dependency route through control's own tick. A block
// Classify found only waiting for one of the ticket's own dependency merge
// requests to merge (ticket:dependency-wait, exit 0) ends the run at done
// with awaits-dependency, resume-at Build and resume-sub-at its Await
// Sequential Merge; the parent leaves Blocked for Build — though Build is at
// its max-visits, the clearing change marked "dependency-wait" so the counts
// restart — entered at await-dependencies, not its first step, and is not
// marked as handed to the operator. A resume-sub-at that is no step of Build's
// engine is not taken: Build starts at its first step, as before. Not shown
// (exit 3): Blocked for Human. The blocked step runs grouped-blocked's own
// dependency-wait step and its ends; ticket:dependency-wait's answer is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const grouped = JSON.parse(readFileSync(join(engineDir('grouped-blocked'), 'state-engine.json'), 'utf8'));
const KEPT = ['dependency-wait', 'done', 'retry', 'blocked-for-human'];
const WAITS = sub => ({ 'awaits-dependency': true, dependency: { id: 1, repository: 'https://gitlab.com/example/images', status: 'Open', key: '!12', url: 'https://gitlab.com/example/images/-/merge_requests/12', 'waited-by': 2 },
  'resume-at': 'build', 'resume-source': 'declared', 'resume-why': 'Blocked\'s dependency route (ASS-390) declares resume-at await-dependencies (in build)', 'resume-ignored': [],
  'resume-sub-at': sub, 'ai-feedback-short': null, 'ai-feedback-long': null });

// ABC-3 A blocked at local-testing after Build's third visit (its max-visits); Build a group whose engine has Await Sequential Merge second.
function fixture(answer) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-health-interval-seconds'] = 1e9;
    e.steps.unshift({ id: 'blocked-for-human', sequence: -1, 'is-blocked-state': true, action: { type: 'human' } });
    Object.assign(e.steps.find(s => s.id === 'blocked'), {
      action: { type: 'state-engine', engine: 'own' }, 'follow-return-to-state': true,
      'exit-events': [
        { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked-for-human' }] }, 'move-to-state': 'blocked-for-human' },
        { condition: { 'is-done': true }, 'follow-return-to-state': true },
      ],
    });
    Object.assign(e.steps.find(s => s.id === 'build'), { action: { type: 'state-engine', engine: 'mini-build' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'local-testing' }] });
  });
  mkdirSync(join(f.dir, 'engines', 'own'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'own', 'state-engine.json'), JSON.stringify({ steps: grouped.steps.filter(s => KEPT.includes(s.id)).map(({ vm, ...s }) => s) }));
  mkdirSync(join(f.dir, 'engines', 'mini-build'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'mini-build', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'refresh', sequence: 1, action: { type: 'none' } },
    { id: 'await-dependencies', sequence: 2, action: { type: 'none' } },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] }));
  const was = (from, to) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to, timestamp: '2026-11-11T19:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true });
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'Blocked';
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('blocked'),
      'state-changes': [was('plan', 'build'), was('build', 'build'), was('build', 'build'), was('build', 'local-testing'), was('local-testing', 'blocked')] });
  });
  f.now = Date.parse('2026-11-12T09:41:00Z');
  f.ctx.now = () => new Date(f.now);
  const script = f.ctx.script;
  f.calls = [];
  f.ctx.script = (argv, vm) => {
    if (!argv.includes('ticket:dependency-wait')) return script(argv, vm);
    f.calls.push(argv.join(' '));
    return Promise.resolve(answer);
  };
  return f;
}
const state = f => f.variation()['harness-status'].state;
const settle = async f => { for (let i = 0; i < 4 && state(f) === 'blocked'; i++) { await tick(f.ctx); f.now += 60e3; } };

test('ASS-390 AC5: a block only waiting for its dependency merge request resumes at Build, entered at Await Sequential Merge, Build\'s max-visits restarted (cause dependency-wait), not handed to the operator', async () => {
  const f = fixture({ exitCode: 0, stdout: JSON.stringify(WAITS('await-dependencies')) });
  await settle(f);
  assert.equal(state(f), 'build', f.lines.join('\n'));
  assert.match(f.calls[0] ?? '', /ticket:dependency-wait p ABC-3 A \S+$/, 'run with the Blocked run\'s id');
  const cleared = f.variation()['state-changes'].findLast(c => c['from-state'] === 'blocked' && !c['sub-state-change']);
  assert.deepEqual([cleared['to-state'], cleared.cause], ['build', 'dependency-wait'], f.lines.join('\n'));
  assert.deepEqual(f.variation()['harness-status']['sub-status'], { state: 'await-dependencies', 'state-engine': 'mini-build' }, 'Build entered at Await Sequential Merge');
  assert.ok(f.lines.some(l => /^steps ABC-3 A blocked: it only waits for its dependency merge request; resumes at build at await-dependencies: Blocked's dependency route/.test(l)), f.lines.join('\n'));
  assert.equal(f.variation()['ai-feedback-short'] ?? null, null, 'not marked as handed to the operator');
});

test('ASS-390 AC5: a resume-sub-at that is no step of Build\'s engine is not taken — Build starts at its first step', async () => {
  const f = fixture({ exitCode: 0, stdout: JSON.stringify(WAITS('no-such-step')) });
  await settle(f);
  assert.equal(state(f), 'build', f.lines.join('\n'));
  assert.equal(f.variation()['harness-status']['sub-status']?.state, 'refresh', f.lines.join('\n'));
  assert.ok(f.lines.some(l => /resumes at build \(its no-such-step not a step there\)/.test(l)), f.lines.join('\n'));
});

test('ASS-390 AC5: not shown to wait only for a dependency (exit 3) — Blocked for Human, saying why', async () => {
  const f = fixture({ exitCode: 3, stdout: JSON.stringify({ 'awaits-dependency': false, 'dependency-why': 'none of its merge requests depends on an unmerged one in another repository', 'ai-feedback-short': 'Not shown to wait only for a dependency merge request', 'ai-feedback-long': 'L' }) });
  await settle(f);
  assert.equal(state(f), 'blocked-for-human', f.lines.join('\n'));
  assert.equal(f.variation()['ai-feedback-short'], 'Not shown to wait only for a dependency merge request');
  assert.ok(!f.variation()['state-changes'].some(c => c.cause === 'dependency-wait'));
});
