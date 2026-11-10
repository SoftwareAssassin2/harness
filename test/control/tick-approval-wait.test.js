// ASS-351: Team Code Review waits for approvals without spending its visits.
// A release engine shaped as a downstream project's is (the example
// project's grouped-release-example, which mirrors it): team-code-review a
// 5-minute timer of max-visits 10 running merge-request:check, sent to
// ensure-auto-merge (max-visits 3) on needs-attention false and auto-merge
// false. Driven tick by tick by control, with the real merge-request:check
// and merge-request:ensure-auto-merge reading a fake GitLab: app's !7 (MR 1),
// !8 (MR 2, stacked on MR 1) and lib's !9 (MR 3). A poll that matches no exit
// leaves the run where it is — no move, so no visit (engine.js nextState
// null; steps.js runTransient's settle) — so a group set to auto-merge and
// waiting on its reviewers waits as long as it takes, up to the approval
// bound (AC4), which ends the Release at Blocked for Human.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeForge } from '../support/fake-forge.js';
import { EXAMPLE_ENGINES } from '../support/engine-walk.js';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const APP = 'https://gitlab.com/g/app', LIB = 'https://gitlab.com/g/lib';
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const EXAMPLE = JSON.parse(readFileSync(join(EXAMPLE_ENGINES, 'grouped-release-example', 'state-engine.json'), 'utf8'));

// The downstream project's release engine as it is: the example's without
// ASS-351's approval-wait routing (its exit, record-script-output and done step).
function asItIs() {
  const e = structuredClone(EXAMPLE);
  e.steps = e.steps.filter(s => s.id !== 'blocked-for-human');
  const tcr = e.steps.find(s => s.id === 'team-code-review');
  delete tcr['record-script-output'];
  tcr['exit-events'] = tcr['exit-events'].filter(x => !JSON.stringify(x.condition).includes('approval-wait-expired'));
  return e;
}

// The merge requests' side: a projects folder holding ABC-3 A's rows, and a
// fake GitLab; GitLab's views of them as given, a merge PUT on one raising
// flag set<iid>, so its view then says auto-merge is set.
function mergeRequests(rows = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  mkdirSync(join(dir, 'p', 'work', 'ABC-3'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ repositories: [{ url: APP }, { url: LIB }] }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  const row = (id, repository, key, base, dependsOn = []) => ({ id, repository, branch: `change/ABC-3-${id}`, contents: 'x', 'depends-on': dependsOn, status: 'Open', key, url: `${repository}/-/merge_requests/${key.slice(1)}`, base, ...rows[id] });
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', title: 'Close the account', variations: [{ name: 'A',
    'merge-request': [row(1, APP, '!7', 'master'), row(2, APP, '!8', 'change/ABC-3-1', [1]), row(3, LIB, '!9', 'master')] }] }] }, null, 4));
  const forge = fakeForge();
  for (const repo of ['app', 'lib']) forge.route('glab', new RegExp(`^api projects/g%2F${repo} --hostname gitlab.com$`), { out: { default_branch: 'master' } });
  const mr = (iid, v = {}) => ({ iid, state: 'opened', draft: false, title: 'ABC-3: Close the account', target_branch: 'master', has_conflicts: false, detailed_merge_status: 'not_approved', blocking_discussions_resolved: true, merge_when_pipeline_succeeds: false, head_pipeline: { status: 'success' }, ...v });
  const view = (repo, iid, v, response = {}) => forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid} --hostname gitlab.com$`), { out: mr(iid, v), ...response });
  for (const [repo, iid, target] of [['app', 7, 'master'], ['app', 8, 'change/ABC-3-1'], ['lib', 9, 'master']]) {
    view(repo, iid, { target_branch: target });
    view(repo, iid, { target_branch: target, merge_when_pipeline_succeeds: true }, { when: `set${iid}` });
    forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid}/merge --hostname gitlab.com -X PUT -f merge_when_pipeline_succeeds=true$`), { out: {}, touch: `set${iid}` });
  }
  const set = () => forge.log('glab').filter(l => /\/merge --hostname/.test(l)).map(l => Number(/merge_requests\/(\d+)/.exec(l)[1]));
  return { dir, forge, view, set, rows: () => JSON.parse(readFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8')).features[0].variations[0]['merge-request'] };
}

// The control fixture with p's local-testing step running `release` (the
// engine given) as Release, its exits as the example's are, and a Blocked
// for Human step; ABC-3 A In Review, at team-code-review. Its scripts run
// agent.sh for real against `mrs` — each call kept in `calls` — and a tick
// waits for them, so each poll is read in the tick that started it.
function fixture(release, mrs) {
  const f = controlFixture();
  const engines = join(f.dir, 'engines');
  mkdirSync(join(engines, 'release'), { recursive: true });
  writeFileSync(join(engines, 'release', 'state-engine.json'), JSON.stringify(release, null, 4));
  edit(join(engines, 'example-development', 'state-engine.json'), e => {
    e['check-health-interval-seconds'] = 1e9;
    e.steps.unshift({ id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, 'follow-return-to-state': true, action: { type: 'human' },
      'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }] });
    const step = e.steps.find(s => s.id === 'local-testing');
    step.action = { type: 'state-engine', engine: 'release' };
    step['paired-ticket-system-status'] = 'In Review';
    const ended = at => ({ all: [{ 'is-done': true }, { 'sub-engine-ended-at': at }] });
    step['exit-events'] = [
      { condition: ended('blocked'), 'move-to-state': 'blocked' },
      ...(release.steps.some(s => s.id === 'blocked-for-human') ? [{ condition: ended('blocked-for-human'), 'move-to-state': 'blocked-for-human' }] : []),
      { condition: ended('rebuild'), 'move-to-state': 'build' },
      { condition: { 'is-done': true }, 'move-to-state': 'done' },
    ];
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0]['ticket-system-status'] = 'In Review';
    s.features[0].variations[0]['harness-status'] = { state: 'local-testing', 'state-engine': 'example-development', 'sub-status': { state: 'team-code-review', 'state-engine': 'release' } };
  });
  f.now = Date.parse('2026-11-10T15:00:00Z');
  f.ctx.now = () => new Date(f.now);
  f.ctx.scriptWait = 60_000;
  f.calls = [];
  f.ctx.script = argv => new Promise(resolve => {
    f.calls.push(argv.slice(1, 2).join(' '));
    execFile(AGENT, argv.slice(1), { env: { ...process.env, PROJECTS_DIR: mrs.dir, PATH: mrs.forge.path, HARNESS_FILE: join(mrs.dir, 'harness.json') } },
      (error, stdout) => resolve({ exitCode: error ? (error.code ?? 1) : 0, stdout }));
  });
  f.run = () => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'release');
  f.moves = () => (f.run()?.['state-changes'] ?? []).map(c => `${c['from-state']}→${c['to-state']}`);
  // A tick every six minutes: one poll each, past the five-minute timer.
  f.poll = async (n = 1) => { for (let i = 0; i < n; i++) { f.now += 6 * 60e3; await tick(f.ctx); } };
  return f;
}

test('ASS-351 AC1/AC2: with the release engine as it is, a group set to auto-merge whose dependent waits on an unmerged dependency waits at team-code-review poll after poll — no visit spent, no Ensure Auto-Merge round trip — and once the dependency merges Ensure Auto-Merge runs once, then waiting resumes', async () => {
  const mrs = mergeRequests();
  const f = fixture(asItIs(), mrs);
  try {
    await tick(f.ctx);                                                    // the release run, at team-code-review
    assert.equal(f.run()?.state, 'team-code-review', f.lines.join('\n'));
    // First poll: !7 and !9 could be set and are not — Ensure Auto-Merge sets them, once (!8 waits on !7).
    await f.poll();
    assert.deepEqual(mrs.set(), [7, 9], f.lines.join('\n'));
    assert.deepEqual(f.moves(), ['team-code-review→ensure-auto-merge', 'ensure-auto-merge→team-code-review'], f.lines.join('\n'));
    // AC1: twelve polls — more than team-code-review's ten visits, an hour and more — and the run stays put.
    await f.poll(12);
    assert.equal(f.run().state, 'team-code-review', f.lines.join('\n'));
    assert.deepEqual(f.moves(), ['team-code-review→ensure-auto-merge', 'ensure-auto-merge→team-code-review'], 'no visit spent waiting');
    assert.equal(f.calls.filter(c => c === 'merge-request:check').length, 13, f.calls.join('\n'));
    assert.equal(f.calls.filter(c => c === 'merge-request:ensure-auto-merge').length, 1, 'no round trip while waiting');
    assert.deepEqual(mrs.set(), [7, 9]);
    assert.equal(f.variation()['harness-status'].state, 'local-testing');
    // AC2: !7 merges. !8 is retargeted to master, unblocked and not set: Ensure Auto-Merge runs once and sets it.
    mrs.view('app', 7, { state: 'merged', merged_at: '2026-11-10T16:30:00Z', merge_when_pipeline_succeeds: true });
    mrs.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/8 --hostname gitlab.com -X PUT -f target_branch=master$/, { out: {}, touch: 'retargeted' });
    mrs.view('app', 8, { target_branch: 'master' }, { when: 'retargeted' });
    mrs.view('app', 8, { target_branch: 'master', merge_when_pipeline_succeeds: true }, { when: 'set8' });
    await f.poll();
    assert.deepEqual(mrs.set(), [7, 9, 8], f.lines.join('\n'));
    assert.equal(f.calls.filter(c => c === 'merge-request:ensure-auto-merge').length, 2);
    assert.equal(f.run().state, 'team-code-review');
    // Waiting resumes: more polls, no more moves.
    const moved = f.moves().length;
    await f.poll(5);
    assert.equal(f.moves().length, moved, f.moves().join('\n'));
    assert.equal(f.calls.filter(c => c === 'merge-request:ensure-auto-merge').length, 2);
    assert.deepEqual(mrs.rows().map(r => r.status), ['Merged', 'Open', 'Open']);
    // All merged: done, and the ticket moves on.
    mrs.view('app', 8, { state: 'merged' });
    mrs.view('lib', 9, { state: 'merged' });
    await f.poll();
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'done', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-351 AC3: with the release engine as it is, a real problem is no wait — a refused auto-merge still sends the run to blocked and the ticket to Blocked, as before', async () => {
  const mrs = mergeRequests();
  mrs.forge.route('glab', /merge_requests\/7\/merge /, { out: { message: '405 Method Not Allowed' }, exit: 1 });
  const f = fixture(asItIs(), mrs);
  try {
    await tick(f.ctx);
    await f.poll();
    // ensure-auto-merge fails: its non-zero exit sends the run to blocked at once, and the ticket to Blocked.
    assert.ok(f.moves().includes('ensure-auto-merge→blocked'), f.moves().join('\n'));
    await tick(f.ctx);                                                    // the parent reads the ended run
    assert.equal(f.variation()['harness-status'].state, 'blocked', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-351 AC4: once an MR set to auto-merge has waited past approval-wait-days, team-code-review\'s approval-wait-expired exit ends the Release at Blocked for Human, the feedback naming the MRs still needing approval', async () => {
  const since = new Date(Date.now() - 4 * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const mrs = mergeRequests({ 1: { 'approval-wait-since': since }, 3: { 'approval-wait-since': since } });
  for (const iid of [7, 9]) mrs.forge.route('glab', new RegExp(`merge_requests/${iid} --hostname gitlab.com$`), { out: { iid, state: 'opened', draft: false, title: 't', target_branch: 'master', blocking_discussions_resolved: true, merge_when_pipeline_succeeds: true, head_pipeline: { status: 'success' }, detailed_merge_status: 'not_approved' } });
  const f = fixture(EXAMPLE, mrs);
  try {
    // A bound longer than the wait: it waits, as in AC1.
    writeFileSync(join(mrs.dir, 'harness.json'), JSON.stringify({ 'approval-wait-days': 5 }));
    await tick(f.ctx);
    await f.poll(3);
    assert.equal(f.run().state, 'team-code-review', f.lines.join('\n'));
    assert.deepEqual(f.moves(), []);
    // The default, 3 days: past it.
    writeFileSync(join(mrs.dir, 'harness.json'), JSON.stringify({}));
    await f.poll();
    assert.deepEqual(f.moves(), ['team-code-review→blocked-for-human'], f.lines.join('\n'));
    await tick(f.ctx);                                                    // the parent reads the ended run
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'blocked-for-human', f.lines.join('\n'));
    assert.equal(v['ai-feedback-short'], 'Waited over 3 days for approval: MR 1 (!7), MR 3 (!9)');
    assert.match(v['ai-feedback-long'], /MR 1 \(!7\) https:\/\/gitlab.com\/g\/app\/-\/merge_requests\/7, waiting since /);
    assert.match(v['ai-feedback-long'], /MR 3 \(!9\) https:\/\/gitlab.com\/g\/lib\/-\/merge_requests\/9/);
    assert.match(v['ai-feedback-long'], /Waiting for those before them to merge: MR 2 \(!8\)/);
    assert.equal(f.calls.filter(c => c === 'merge-request:ensure-auto-merge').length, 0);
  } finally {
    f.ctx.stopAgents();
  }
});
