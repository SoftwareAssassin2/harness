// ASS-384: Blocked's own-branch fix through control's own tick. A failure
// grouped-blocked found in the ticket's own branch (not on the latest master,
// in a file the variation's branch adds or changes: ticket:own-branch-fix,
// exit 0) ends the run at done with own-branch-fix and a resume-at; the parent
// leaves Blocked for that step (engine.js ownBranchFix, resumeAt) — though it
// is at its max-visits, the clearing change marked "own-branch-fix" so the
// counts restart — and is not marked as handed to the operator. Not shown
// (exit 3): Blocked for Human, as before. The blocked step runs
// grouped-blocked's own own-branch-or-human step and its ends, so the run
// starts there; ticket:own-branch-fix's answer is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';
import { readEngine } from '../../src/workflow/engine-file.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const grouped = readEngine(join(engineDir('grouped-blocked'), 'workflow.yaml'));
const KEPT = ['own-branch-or-human', 'done', 'retry', 'blocked-for-human'];
const FIXED = { 'own-branch-fix': true, 'own-branch-why': 'db/V27__x.sql is one the branch change/EX-1 in api adds or changes', 'plan-revised': 'execution-plan-A.md',
  'resume-at': 'build', 'resume-source': 'declared', 'resume-why': 'Blocked\'s own-branch fix (ASS-384) declares resume-at generate-solution (in build)', 'resume-ignored': [],
  'ai-feedback-short': null, 'ai-feedback-long': null };

// ABC-3 A blocked at local-testing after Build's third visit (its max-visits), its Blocked a run of own-branch-or-human.
// ASS-423 (qa): blocked from a QA step after Local Testing instead — a person's step with its own Jira status, as a project's QA is.
function fixture(answer, { qa = false } = {}) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => {
    e['check-health-interval-seconds'] = 1e9;
    if (qa) {
      e.steps.find(s => s.id === 'local-testing')['exit-events'][0]['move-to-state'] = 'qa';
      e.steps.find(s => s.id === 'done').sequence = 7;
      e.steps.splice(e.steps.findIndex(s => s.id === 'done'), 0, { id: 'qa', sequence: 6, 'is-qa': true, 'paired-ticket-system-status': 'QA', 'return-to-state': 'qa', action: { type: 'human' } });
    }
    e.steps.unshift({ id: 'blocked-for-human', sequence: -1, 'is-blocked-state': true, action: { type: 'human' } });
    Object.assign(e.steps.find(s => s.id === 'blocked'), {
      action: { type: 'state-engine', engine: 'own' }, 'follow-return-to-state': true,
      'exit-events': [
        { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked-for-human' }] }, 'move-to-state': 'blocked-for-human' },
        { condition: { 'is-done': true }, 'follow-return-to-state': true },
      ],
    });
  });
  mkdirSync(join(f.dir, 'engines', 'own'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'own', 'workflow.yaml'), JSON.stringify({ steps: grouped.steps.filter(s => KEPT.includes(s.id)).map(({ vm, ...s }) => s) }));
  const was = (from, to) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to, timestamp: '2026-11-11T19:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true });
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'Blocked';
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('blocked'),
      'state-changes': [was('plan', 'build'), was('build', 'build'), was('build', 'build'), was('build', 'local-testing'), ...(qa ? [was('local-testing', 'qa'), was('qa', 'blocked')] : [was('local-testing', 'blocked')])] });
  });
  f.now = Date.parse('2026-11-11T21:41:00Z');
  f.ctx.now = () => new Date(f.now);
  const script = f.ctx.script;
  f.calls = [];
  f.ctx.script = (argv, vm) => {
    if (!argv.includes('ticket:own-branch-fix')) return script(argv, vm);
    f.calls.push(argv.join(' '));
    return Promise.resolve(answer);
  };
  return f;
}
const state = f => f.variation()['harness-status'].state;
const topTrail = f => f.variation()['state-changes'].filter(c => !c['sub-state-change']).map(c => `${c['from-state']}→${c['to-state']}`);
const settle = async f => { for (let i = 0; i < 4 && state(f) === 'blocked'; i++) { await tick(f.ctx); f.now += 60e3; } };

test('ASS-384 AC1/AC5: a failure in the ticket\'s own branch sends it back to the step Generate Solution runs in — Build, at its max-visits, the change marked own-branch-fix — not to Blocked for Human', async () => {
  const f = fixture({ exitCode: 0, stdout: JSON.stringify(FIXED) });
  await settle(f);
  assert.notEqual(state(f), 'blocked-for-human', f.lines.join('\n'));   // Build's script runs at once and moves on: the trail tells
  assert.deepEqual(topTrail(f).slice(4), ['local-testing→blocked', 'blocked→build', 'build→local-testing'], f.lines.join('\n'));
  assert.match(f.calls[0] ?? '', /ticket:own-branch-fix p ABC-3 A \S+$/, 'run with the Blocked run\'s id');
  const cleared = f.variation()['state-changes'].findLast(c => c['from-state'] === 'blocked' && !c['sub-state-change']);
  assert.deepEqual([cleared['to-state'], cleared.cause], ['build', 'own-branch-fix'], f.lines.join('\n'));
  assert.ok(f.lines.some(l => /^steps ABC-3 A blocked: the failure is in its own branch \(own-branch fix\); resumes at build: Blocked's own-branch fix/.test(l)), f.lines.join('\n'));
  assert.equal(f.variation()['ai-feedback-short'] ?? null, null, 'not marked as handed to the operator');
});

test('ASS-384 AC4/AC5: not shown to be the ticket\'s own branch (exit 3) — Blocked for Human, as before', async () => {
  const f = fixture({ exitCode: 3, stdout: JSON.stringify({ 'own-branch-fix': false, 'own-branch-why': 'Troubleshoot named no failing repository, file and job or assertion' }) });
  await settle(f);
  assert.equal(state(f), 'blocked-for-human', f.lines.join('\n'));
  assert.ok(!f.variation()['state-changes'].some(c => c.cause === 'own-branch-fix'));
});

test('ASS-423 AC5: a block from QA (its merge requests merged) taking the own-branch fix — back to Build, Generate Solution\'s group, its Jira status Build\'s pairing, not QA\'s or Blocked\'s; on through Build again toward QA, not to Blocked for Human', async () => {
  const planned = { 'own-branch-source': 'merged', 'merge-request-planned': { id: 4, repository: 'https://gitlab.com/g/api', branch: 'change/ABC-3-4', base: 'master' },
    'own-branch-why': 'apps/x_test.go is one this ticket\'s merged MR 3 (!3951) in api added or changed, and the latest master does not show the failure' };
  const f = fixture({ exitCode: 0, stdout: JSON.stringify({ ...FIXED, ...planned }) }, { qa: true });
  await settle(f);
  assert.notEqual(state(f), 'blocked-for-human', f.lines.join('\n'));
  assert.deepEqual(topTrail(f).slice(4), ['local-testing→qa', 'qa→blocked', 'blocked→build', 'build→local-testing'], f.lines.join('\n'));
  const cleared = f.variation()['state-changes'].findLast(c => c['from-state'] === 'blocked' && !c['sub-state-change']);
  assert.deepEqual([cleared['to-state'], cleared.cause], ['build', 'own-branch-fix'], 'resumed at Build, not back at QA (its return-to-state)');
  assert.ok(f.lines.some(l => /^steps ABC-3 A blocked: the failure is in its own branch \(own-branch fix\); resumes at build/.test(l)), f.lines.join('\n'));
  assert.equal(f.ticket()['ticket-system-status'], 'In Progress', 'Build\'s paired status');
  assert.equal(f.variation()['ai-feedback-short'] ?? null, null, 'not marked as handed to the operator');
});
