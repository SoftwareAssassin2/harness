// ASS-81 — a variation's planned merge requests (ASS-80) on their forges:
// merge-request:create <id> opens one when Generate Solution has built it,
// merge-request:check is control's read of them all, merge-request:merge and
// :ensure-auto-merge release them in depends-on order. No checkout: every
// call goes to the forge's API (glab api --hostname, gh --repo), here a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeForge } from '../support/fake-forge.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const APP = 'https://gitlab.com/g/app', LIB = 'https://gitlab.com/g/lib', HUB = 'https://github.com/o/h';
const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

// Project p (repositories app, lib and h; no local-pc checkout) with ABC-5 in its active sprint, its variation A's merge requests planned as given.
async function planned(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'mrs-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  mkdirSync(join(dir, 'p', 'work', 'ABC-5'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ repositories: [{ url: APP }, { url: LIB }, { url: HUB }] }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10, bugs: [], spikes: [],
    features: [{ key: 'ABC-5', title: 'Close the account', url: 'https://jira.example.com/browse/ABC-5', variations: [{ name: 'A', 'merge-request': [] }] }],
  }, null, 4));
  writeFileSync(join(dir, 'p', 'work', 'ABC-5', 'execution-plan-A.md'), '# Plan\n');
  const forge = fakeForge();
  const env = { env: { ...process.env, PROJECTS_DIR: dir, PATH: forge.path } };
  const agent = (...args) => run(AGENT, args, env);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(entries.map(({ id, repository, contents = 'x', 'depends-on': d = [] }) => ({ id, repository, contents, 'depends-on': d }))));
  await agent('ticket:set-merge-request-plan', 'p', 'ABC-5', 'A', join(dir, 'plan.json'));
  const file = join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
  const mrs = () => JSON.parse(readFileSync(file, 'utf8')).features[0].variations[0]['merge-request'];
  // Recorded as created already: { id: { status, key, url, base } }.
  const record = created => {
    const sprint = JSON.parse(readFileSync(file, 'utf8'));
    for (const m of sprint.features[0].variations[0]['merge-request']) Object.assign(m, created[m.id] ?? {});
    writeFileSync(file, JSON.stringify(sprint, null, 4));
  };
  const notes = () => readFileSync(join(dir, 'p', 'work', 'ABC-5', 'execution-plan-A.md'), 'utf8').split('\n').filter(l => l.includes('control'));
  // GitLab's answers: each repository's default branch, master.
  for (const repo of ['app', 'lib']) forge.route('glab', new RegExp(`^api projects/g%2F${repo} --hostname gitlab.com$`), { out: { default_branch: 'master' } });
  forge.route('gh', /^api repos\/o\/h$/, { out: { default_branch: 'main' } });
  return { dir, forge, agent, mrs, record, notes, entries: entries.map(e => e.entries ?? e), file };
}
const mr = (iid, v = {}) => ({ iid, state: 'opened', draft: true, title: `Draft: ABC-5: Close the account`, target_branch: 'master', has_conflicts: false, detailed_merge_status: 'mergeable', blocking_discussions_resolved: true, merge_when_pipeline_succeeds: false, head_pipeline: { status: 'success' }, web_url: `${APP}/-/merge_requests/${iid}`, ...v });
const view = (f, repo, iid, v, response = {}) => f.forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid} --hostname gitlab.com$`), { out: mr(iid, v), ...response });

test('AC1: merge-request:create <id> opens the planned MR\'s draft against its base through GitLab\'s API, in depends-on order, recording key, url and Open; an open one is reused', async () => {
  const f = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }, { id: 3, repository: APP, 'depends-on': [2] }]);
  await fails(f.agent('merge-request:create', 'p', 'ABC-5', 'A', '2'), /MR 2 depends on MR 1, which is not created yet/);
  assert.equal(f.mrs()[1].status, 'Not Created');
  const none = /merge_requests\?state=opened&source_branch=change%2FABC-5-\d --hostname gitlab.com$/;
  f.forge.route('glab', none, { out: [] });
  f.forge.route('glab', /repository\/branches\/change%2FABC-5-\d --hostname gitlab.com$/, { out: {} });
  f.forge.route('glab', /repository\/compare\?from=.*&to=change%2FABC-5-\d --hostname gitlab.com$/, { out: { diffs: [{ new_path: 'a.js' }] } });
  f.forge.route('glab', /^api projects\/g%2Flib\/merge_requests --hostname gitlab.com -X POST/, { out: { iid: 7, web_url: `${LIB}/-/merge_requests/7` } });
  const { stdout } = await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '1');
  assert.deepEqual(JSON.parse(stdout), { id: 1, status: 'Open', iid: 7, url: `${LIB}/-/merge_requests/7`, created: true });
  assert.ok(f.forge.log('glab').join('\n').includes('api projects/g%2Flib/merge_requests --hostname gitlab.com -X POST -f source_branch=change/ABC-5-1 -f target_branch=master -f title=Draft: ABC-5: Close the account (MR 1) -f description=> [ABC-5](https://jira.example.com/browse/ABC-5)\n\nx'), f.forge.log('glab').join('\n'));
  assert.deepEqual(f.mrs()[0], { id: 1, repository: LIB, branch: 'change/ABC-5-1', contents: 'x', 'depends-on': [], status: 'Open', key: '!7', url: `${LIB}/-/merge_requests/7`, 'build-status': 'Pending', base: 'master' });
  // Asked again: it is open, so nothing new.
  view(f, 'lib', 7, { web_url: `${LIB}/-/merge_requests/7` });
  assert.equal(JSON.parse((await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '1')).stdout).created, false);
  // MR 2 (app) depends on MR 1 in another repository: based on app's master. One already open on its branch is reused.
  f.forge.route('glab', /merge_requests\?state=opened&source_branch=change%2FABC-5-2 /, { out: [{ iid: 9, web_url: `${APP}/-/merge_requests/9` }] });
  assert.deepEqual(JSON.parse((await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '2')).stdout), { id: 2, status: 'Open', iid: 9, url: `${APP}/-/merge_requests/9`, created: false });
  // MR 3 depends on MR 2, unmerged, in the same repository: built on, and opened against, MR 2's branch.
  view(f, 'app', 9, {});
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests --hostname gitlab.com -X POST/, { out: { iid: 10, web_url: `${APP}/-/merge_requests/10` } });
  await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '3');
  assert.match(f.forge.log('glab').filter(l => / -X POST/.test(l)).at(-1), /-f source_branch=change\/ABC-5-3 -f target_branch=change\/ABC-5-2 /);
  assert.deepEqual(f.mrs().map(m => [m.id, m.status, m.key, m.base]), [[1, 'Open', '!7', 'master'], [2, 'Open', '!9', 'master'], [3, 'Open', '!10', 'change/ABC-5-2']]);
  assert.equal(f.forge.log('gh').length, 0);
});

const pr = (v = {}) => ({ state: 'OPEN', isDraft: true, title: 'ABC-5: Close the account', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', autoMergeRequest: null, statusCheckRollup: [], ...v });
const prView = (f, number, v, response = {}) => f.forge.route('gh', new RegExp(`^pr view ${number} --repo o/h --json `), { out: pr(v), ...response });

test('ASS-86 AC4: an off-board ticket (its url a file://) is named plain in merge-request:create <id>\'s description, "<KEY>: <title>", never linked to a file or to null', async () => {
  for (const url of ['file:///h/src/off-board/x/ABC-5.md', null]) {
    const f = await planned([{ id: 1, repository: HUB }]);
    const sprint = JSON.parse(readFileSync(f.file, 'utf8'));
    sprint.features[0].url = url;
    writeFileSync(f.file, JSON.stringify(sprint, null, 4));
    f.forge.route('gh', /^pr list /, { out: [] });
    f.forge.route('gh', /^api repos\/o\/h\/compare\//, { out: { files: [{ filename: 'a.js' }] } });
    f.forge.route('gh', /^pr create /, { out: 'https://github.com/o/h/pull/12' });
    await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '1');
    assert.ok(f.forge.log('gh').join('\n').includes('--body > ABC-5: Close the account\n\nx --draft'), f.forge.log('gh').join('\n'));
  }
});

test('AC1: on GitHub, merge-request:create <id> opens a draft pull request with gh --repo against its base, recorded as #<number>; one open from its branch is reused', async () => {
  const f = await planned([{ id: 1, repository: HUB }]);
  f.forge.route('gh', /^pr list --repo o\/h --head change\/ABC-5-1 --state open --json number,url$/, { out: [] });
  f.forge.route('gh', /^api repos\/o\/h\/compare\/main\.\.\.change\/ABC-5-1$/, { out: { files: [{ filename: 'a.js' }] } });
  f.forge.route('gh', /^pr create --repo o\/h --head change\/ABC-5-1 --base main --title ABC-5: Close the account --body /, { out: 'https://github.com/o/h/pull/12' });
  assert.deepEqual(JSON.parse((await f.agent('merge-request:create', 'p', 'abc-5', 'A', '1')).stdout), { id: 1, status: 'Open', iid: 12, url: 'https://github.com/o/h/pull/12', created: true });
  assert.match(f.forge.log('gh').join('\n'), /pr create[\s\S]* --draft$/);
  assert.deepEqual([f.mrs()[0].key, f.mrs()[0].status, f.mrs()[0].base], ['#12', 'Open', 'main']);
  const g = await planned([{ id: 1, repository: HUB }]);
  g.forge.route('gh', /^pr list /, { out: [{ number: 13, url: 'https://github.com/o/h/pull/13' }] });
  assert.deepEqual(JSON.parse((await g.agent('merge-request:create', 'p', 'ABC-5', 'A', '1')).stdout), { id: 1, status: 'Open', iid: 13, url: 'https://github.com/o/h/pull/13', created: false });
  assert.ok(!g.forge.log('gh').some(l => /^pr create/.test(l)));
});

test('AC2: control reads every MR from the forge and records it by id — merged or closed there becomes Merged or Closed, a dependent of a merged one is based on master (retargeted when open) — noting each change and why, every row kept', async () => {
  const f = await planned([{ id: 1, repository: APP }, { id: 2, repository: APP, 'depends-on': [1] }, { id: 3, repository: APP, 'depends-on': [1] }, { id: 4, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '!8', base: 'change/ABC-5-1' }, 3: { base: 'change/ABC-5-1' }, 4: { status: 'Open', key: '!10', base: 'master' } });
  view(f, 'app', 7, { state: 'merged' });
  view(f, 'app', 8, { target_branch: 'change/ABC-5-1' });
  view(f, 'app', 10, { state: 'closed' });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/8 --hostname gitlab.com -X PUT -f target_branch=master$/, { out: {}, touch: 'retargeted' });
  view(f, 'app', 8, { target_branch: 'master' }, { when: 'retargeted' });
  await f.agent('merge-request:check', 'p', 'ABC-5', 'A');
  assert.deepEqual(f.mrs().map(m => [m.id, m.status, m.base]), [[1, 'Merged', 'master'], [2, 'Open', 'master'], [3, 'Not Created', 'master'], [4, 'Closed', 'master']]);
  assert.ok(f.forge.log('glab').includes('api projects/g%2Fapp/merge_requests/8 --hostname gitlab.com -X PUT -f target_branch=master'));
  const notes = f.notes();
  assert.equal(notes.length, 4, notes.join('\n'));
  for (const said of [/MR 1 \(change\/ABC-5-1\) is Merged on the forge, was Open/, /MR 4 \(change\/ABC-5-4\) is Closed on the forge, was Open/,
    /MR 2 \(change\/ABC-5-2\) is based on master, not change\/ABC-5-1: MR 1 is Merged/, /MR 3 \(change\/ABC-5-3\) is based on master, not change\/ABC-5-1: MR 1 is Merged/])
    assert.ok(notes.some(n => said.test(n) && n.includes('control, variation A')), `${said}\n${notes.join('\n')}`);
  // Read again: nothing has changed, so nothing is noted, retargeted or written.
  const before = readFileSync(f.file, 'utf8');
  await f.agent('merge-request:check', 'p', 'ABC-5', 'A');
  assert.equal(f.notes().length, 4);
  assert.equal(f.forge.log('glab').filter(l => / -X PUT/.test(l)).length, 1);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('AC2: a planned MR whose branch has no changes against its base is marked Closed by control, not opened, and the execution plan says why', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  f.forge.route('glab', /merge_requests\?state=opened/, { out: [] });
  f.forge.route('glab', /repository\/branches\//, { out: {} });
  f.forge.route('glab', /repository\/compare\?from=master&to=change%2FABC-5-1 /, { out: { diffs: [] } });
  assert.deepEqual(JSON.parse((await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '1')).stdout), { id: 1, status: 'Closed', iid: null, url: null, created: false });
  assert.equal(f.mrs()[0].status, 'Closed');
  assert.ok(!f.forge.log('glab').some(l => / -X POST/.test(l)));
  assert.match(f.notes().join('\n'), /MR 1 \(change\/ABC-5-1\) is Closed, not opened: its branch has no changes against master\./);
  // A branch never pushed cannot be compared: refused, nothing recorded.
  const g = await planned([{ id: 1, repository: HUB }]);
  g.forge.route('gh', /^pr list /, { out: [] });
  g.forge.route('gh', /compare/, { out: { message: 'Not Found' }, exit: 1 });
  await fails(g.agent('merge-request:create', 'p', 'ABC-5', 'A', '1'), /could not compare MR 1's branch with its base; push it first/);
  assert.equal(g.mrs()[0].status, 'Not Created');
});

// Harness: three pull requests stacked 1 ← 2 ← 3, listed out of order; each merges (and then reads MERGED) once gh merges it.
async function stacked() {
  const f = await planned([{ id: 2, repository: HUB, 'depends-on': [1] }, { id: 1, repository: HUB }, { id: 3, repository: HUB, 'depends-on': [2] }]);
  f.record({ 1: { status: 'Open', key: '#1', base: 'main' }, 2: { status: 'Open', key: '#2', base: 'change/ABC-5-1' }, 3: { status: 'Open', key: '#3', base: 'change/ABC-5-2' } });
  for (const n of [1, 2, 3]) {
    prView(f, n, { baseRefName: n === 1 ? 'main' : `change/ABC-5-${n - 1}` });
    f.forge.route('gh', new RegExp(`^pr edit ${n} --repo o/h --base main$`), { touch: `main-${n}` });
    prView(f, n, { baseRefName: 'main' }, { when: `main-${n}` });
    f.forge.route('gh', new RegExp(`^pr ready ${n} --repo o/h$`));
    f.forge.route('gh', new RegExp(`^pr merge ${n} --repo o/h --merge --delete-branch$`), { touch: `merged-${n}` });
    prView(f, n, { state: 'MERGED' }, { when: `merged-${n}` });
  }
  return f;
}
const merges = f => f.forge.log('gh').filter(l => /^pr (merge|edit)/.test(l)).map(l => l.split(' --')[0] + (l.includes('--base') ? ' → main' : ''));

test('AC5 harness: merge-request:merge merges the Open MRs in depends-on order, each dependent retargeted to master once its dependency merged, writing Merged by id as it goes', async () => {
  const f = await stacked();
  const { stdout } = await f.agent('merge-request:merge', 'p', 'ABC-5', 'A');
  assert.deepEqual(stdout.trim().split('\n').map(l => JSON.parse(l)), [1, 2, 3].map(iid => ({ iid, merged: true })));
  assert.deepEqual(merges(f), ['pr merge 1', 'pr edit 2 → main', 'pr merge 2', 'pr edit 3 → main', 'pr merge 3']);
  assert.ok(f.forge.log('gh').indexOf('pr ready 1 --repo o/h') < f.forge.log('gh').indexOf('pr merge 1 --repo o/h --merge --delete-branch'));
  assert.deepEqual(f.mrs().map(m => [m.id, m.status, m.base]), [[2, 'Merged', 'main'], [1, 'Merged', 'main'], [3, 'Merged', 'main']]);
});

test('AC5 harness: the first MR that cannot merge stops merge-request:merge non-zero (the ticket blocks); those merged stay Merged, and a re-run resumes from the first unmerged', async () => {
  const f = await stacked();
  f.forge.route('gh', /^pr merge 2 /, { out: 'X Pull request #2 is not mergeable: the merge commit cannot be cleanly created.', exit: 1 });
  await fails(f.agent('merge-request:merge', 'p', 'ABC-5', 'A'), /could not merge MR 2 \(#2\)/);
  assert.deepEqual(f.mrs().map(m => [m.id, m.status]), [[2, 'Open'], [1, 'Merged'], [3, 'Open']]);
  assert.deepEqual(merges(f), ['pr merge 1', 'pr edit 2 → main', 'pr merge 2']);
  // Fixed: the re-run merges 2, then 3, and never 1 again.
  f.forge.route('gh', /^pr merge 2 /, { touch: 'merged-2' });
  const before = f.forge.log('gh').length;
  await f.agent('merge-request:merge', 'p', 'ABC-5', 'A');
  assert.deepEqual(f.forge.log('gh').slice(before).filter(l => /^pr merge/.test(l)).map(l => l.split(' --')[0]), ['pr merge 2', 'pr merge 3']);
  assert.deepEqual(f.mrs().map(m => m.status), ['Merged', 'Merged', 'Merged']);
  // gh said nothing went wrong, yet it is not merged: stopped too.
  const g = await stacked();
  g.forge.route('gh', /^pr merge 1 /);
  await fails(g.agent('merge-request:merge', 'p', 'ABC-5', 'A'), /MR 1 \(#1\) is Open, not merged/);
  // Every one on GitHub, or nothing is merged.
  const lab = await planned([{ id: 1, repository: APP }]);
  lab.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  await fails(lab.agent('merge-request:merge', 'p', 'ABC-5', 'A'), /merges GitHub pull requests only; https:\/\/gitlab.com\/g\/app is not on GitHub/);
});

// Example: app's !7 (MR 1) and !8 (MR 2, stacked on MR 1's branch), and lib's !9 (MR 3, on its own).
async function example() {
  const f = await planned([{ id: 1, repository: APP }, { id: 2, repository: APP, 'depends-on': [1] }, { id: 3, repository: LIB }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '!8', base: 'change/ABC-5-1' }, 3: { status: 'Open', key: '!9', base: 'master' } });
  view(f, 'app', 7, {});
  view(f, 'app', 8, { target_branch: 'change/ABC-5-1' });
  view(f, 'lib', 9, {});
  for (const [repo, iid] of [['app', 7], ['app', 8], ['lib', 9]]) {
    f.forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid}/merge --hostname gitlab.com -X PUT -f merge_when_pipeline_succeeds=true$`), { out: {} });
    f.forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid} --hostname gitlab.com -X PUT -f title=ABC-5: Close the account$`), { out: {} });
  }
  return f;
}
const autoMerged = f => f.forge.log('glab').filter(l => /\/merge --hostname/.test(l)).map(l => Number(/merge_requests\/(\d+)/.exec(l)[1]));

test('AC5 example: merge-request:ensure-auto-merge sets auto-merge in depends-on order — a dependent only once its dependency merged, retargeted to master first — and Team Code Review\'s check covers every MR', async () => {
  const f = await example();
  const check = async () => JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-5', 'A')).stdout);
  view(f, 'lib', 9, { head_pipeline: { status: 'failed' } });
  assert.deepEqual(await check(), { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': false, merged: false });
  view(f, 'lib', 9, {});
  await f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-5', 'A');
  assert.deepEqual(autoMerged(f), [7, 9]);                       // !8 waits on !7
  view(f, 'app', 7, { merge_when_pipeline_succeeds: true });
  view(f, 'lib', 9, { merge_when_pipeline_succeeds: true });
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });   // so Ensure Auto-Merge runs again
  // !7 merges: !8 is retargeted to master, then set.
  view(f, 'app', 7, { state: 'merged' });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/8 --hostname gitlab.com -X PUT -f target_branch=master$/, { out: {}, touch: 'retargeted' });
  view(f, 'app', 8, { target_branch: 'master' }, { when: 'retargeted' });
  await f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-5', 'A');
  const log = f.forge.log('glab');
  assert.ok(log.indexOf('api projects/g%2Fapp/merge_requests/8 --hostname gitlab.com -X PUT -f target_branch=master') < log.indexOf('api projects/g%2Fapp/merge_requests/8/merge --hostname gitlab.com -X PUT -f merge_when_pipeline_succeeds=true'));
  assert.deepEqual(autoMerged(f), [7, 9, 8]);                    // !9, set already, not set again
  view(f, 'app', 8, { target_branch: 'master', merge_when_pipeline_succeeds: true }, { when: 'retargeted' });
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: false });
  for (const [repo, iid] of [['app', 8], ['lib', 9]]) view(f, repo, iid, { state: 'merged' }, { when: 'retargeted' });
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: true });
});

test('AC5 example: a refused auto-merge stops merge-request:ensure-auto-merge non-zero (the ticket blocks) before any later MR; Take out of Draft Mode readies every Open MR', async () => {
  const f = await example();
  f.forge.route('glab', /merge_requests\/7\/merge /, { out: { message: '405 Method Not Allowed' }, exit: 1 });
  await fails(f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-5', 'A'), /could not set MR 1 \(!7\) to auto-merge/);
  assert.deepEqual(autoMerged(f), [7]);
  const { stdout } = await f.agent('code:take-out-of-draft-mode', 'p', 'ABC-5', 'A');
  assert.deepEqual(stdout.trim().split('\n').map(l => JSON.parse(l)), [7, 8, 9].map(iid => ({ iid, ready: true })));
  assert.equal(f.forge.log('glab').filter(l => / -X PUT -f title=ABC-5: Close the account$/.test(l)).length, 3);
});

test('ASS-54: glab auth status is asked once per command, before any other glab call; not authenticated, the command fails at once saying so and asks GitLab nothing else', async () => {
  const f = await example();
  const before = f.forge.log('glab').length;
  await f.agent('merge-request:check', 'p', 'ABC-5', 'A');
  const asked = f.forge.log('glab').slice(before);
  assert.equal(asked[0], 'auth status');
  assert.equal(asked.filter(l => l === 'auth status').length, 1, asked.join('\n'));
  assert.ok(asked.length > 3);                                   // three views and the default branches: run as before
  f.forge.route('glab', /^auth status$/, { out: 'oauth2: "invalid_grant" token expired', exit: 1 });
  for (const command of ['merge-request:check', 'merge-request:ensure-auto-merge', 'merge-request:merge', 'code:take-out-of-draft-mode']) {
    const from = f.forge.log('glab').length;
    await fails(f.agent(command, 'p', 'ABC-5', 'A'), new RegExp(`${command}: glab is not authenticated`));
    assert.deepEqual(f.forge.log('glab').slice(from), ['auth status'], command);
  }
});

test('ASS-151 AC2: a fast-tracked ticket with no merge request (its plan empty) passes merge-request:merge and :check with nothing to merge, asking no forge; any other ticket with none still fails', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  const sprint = JSON.parse(readFileSync(f.file, 'utf8'));
  sprint.features[0].variations[0]['merge-request'] = [];
  writeFileSync(f.file, JSON.stringify(sprint, null, 4));
  await fails(f.agent('merge-request:merge', 'p', 'ABC-5', 'A'), /ABC-5 A has no merge request/);
  sprint.features[0]['fast-track'] = true;
  writeFileSync(f.file, JSON.stringify(sprint, null, 4));
  const before = f.forge.log('glab').length + f.forge.log('gh').length;
  assert.equal((await f.agent('merge-request:merge', 'p', 'ABC-5', 'A')).stdout, '');
  assert.deepEqual(JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-5', 'A')).stdout), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  assert.equal(f.forge.log('glab').length + f.forge.log('gh').length, before);
  assert.deepEqual(f.mrs(), []);
});

test('ASS-177 AC1/AC3: a refresh writes each MR by its id, read inside the lock — a row added while the forge is asked is kept and left as it was', async () => {
  const f = await planned([{ id: 1, repository: APP }, { id: 2, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '!8', base: 'master' } });
  view(f, 'app', 7, { state: 'merged' });
  view(f, 'app', 8, {});
  // While control asks the forge, another command puts MR 5 first.
  const sprint = JSON.parse(readFileSync(f.file, 'utf8'));
  sprint.features[0].variations[0]['merge-request'].unshift({ id: 5, repository: APP, branch: 'change/ABC-5-5', contents: 'x', 'depends-on': [], status: 'Not Created' });
  f.forge.route('glab', /^api projects\/g%2Fapp --hostname gitlab.com$/, { out: { default_branch: 'master' }, write: [f.file, JSON.stringify(sprint, null, 4)] });
  await f.agent('merge-request:check', 'p', 'ABC-5', 'A');
  assert.deepEqual(f.mrs().map(m => [m.id, m.status, m.base]), [[5, 'Not Created', undefined], [1, 'Merged', 'master'], [2, 'Open', 'master']]);
});

test('ASS-177 AC2/AC3: a status never goes from Merged or Closed back to Open — not from a stale forge view, nor over a merge recorded while the forge is asked', async () => {
  // Recorded Merged and Closed; the forge (stale, or reopened) says opened.
  const f = await planned([{ id: 1, repository: APP }, { id: 2, repository: APP }]);
  f.record({ 1: { status: 'Merged', key: '!7', base: 'master' }, 2: { status: 'Closed', key: '!8', base: 'master' } });
  view(f, 'app', 7, {});
  view(f, 'app', 8, {});
  await f.agent('merge-request:check', 'p', 'ABC-5', 'A');
  assert.deepEqual(f.mrs().map(m => m.status), ['Merged', 'Closed']);
  assert.ok(!f.forge.log('glab').some(l => / -X PUT/.test(l)));
  assert.equal(f.notes().length, 0, f.notes().join('\n'));
  // Open when read, then merged by a concurrent merge-request:merge before the write; MR 2 closing makes the refresh write.
  const g = await planned([{ id: 1, repository: APP }, { id: 2, repository: APP }]);
  g.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '!8', base: 'master' } });
  view(g, 'app', 7, {});
  view(g, 'app', 8, { state: 'closed' });
  const sprint = JSON.parse(readFileSync(g.file, 'utf8'));
  sprint.features[0].variations[0]['merge-request'][0].status = 'Merged';
  g.forge.route('glab', /^api projects\/g%2Fapp --hostname gitlab.com$/, { out: { default_branch: 'master' }, write: [g.file, JSON.stringify(sprint, null, 4)] });
  await g.agent('merge-request:check', 'p', 'ABC-5', 'A');
  assert.deepEqual(g.mrs().map(m => [m.id, m.status]), [[1, 'Merged'], [2, 'Closed']]);
});

// ASS-219: merge-request:check-details, the step after Update Merge Request
// Details — each Open MR's title in the project's format (project.json's
// "merge-request-title"), its description naming every commit on its branch,
// and its head pipeline's .pre jobs (example-ci's mr-title) finished and
// passed. Prints { status: passed | waiting | failed }; a failure is written to
// the ticket's merge-request-details-check-<variation>.md for the agent, the
// file gone once it passes.
async function detailed(format, mr1 = {}, { commits = ['Close the account (ABC-5)'], jobs } = {}) {
  const f = await planned([{ id: 1, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  if (format) writeFileSync(join(f.dir, 'p', 'project.json'), JSON.stringify({ repositories: [{ url: APP }], 'merge-request-title': format }));
  view(f, 'app', 7, { description: '> ABC-5\n\n- Close the account', head_pipeline: null, ...mr1 });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/commits\?per_page=100 --hostname gitlab.com$/, { out: commits.map(title => ({ title })) });
  if (jobs) f.forge.route('glab', /^api projects\/g%2Fapp\/pipelines\/50\/jobs\?per_page=100 --hostname gitlab.com$/, { out: jobs });
  f.check = async () => JSON.parse((await f.agent('merge-request:check-details', 'p', 'ABC-5', 'A')).stdout);
  f.report = join(f.dir, 'p', 'work', 'ABC-5', 'merge-request-details-check-A.md');
  return f;
}

test('ASS-219 AC2/AC4: key-summary (the default) wants "KEY: summary", conventional "type(scope): subject (KEY)", the draft prefix ignored; a title in another format fails, the report naming the format wanted', async () => {
  for (const [format, title, status] of [
    [undefined, 'Draft: ABC-5: Close the account', 'passed'],
    ['key-summary', 'ABC-5: Close the account', 'passed'],
    [undefined, 'fix(accounts): close the account (ABC-5)', 'failed'],
    ['conventional', 'Draft: fix(accounts): close the account (ABC-5)', 'passed'],
    ['conventional', 'feat: close the account (ABC-5)', 'passed'],
    ['conventional', 'Draft: ABC-5: Close the account', 'failed'],
    ['conventional', 'fix(accounts): close the account', 'failed'],
    ['conventional', 'Fix(accounts): close the account (ABC-5)', 'failed'],
  ]) {
    const f = await detailed(format, { title });
    assert.deepEqual(await f.check(), { status }, `${format} ${title}`);
    if (status === 'failed') {
      const report = readFileSync(f.report, 'utf8');
      assert.ok(report.includes(`MR 1 (!7): its title "${title}" is not`), report);
      assert.match(report, format === 'conventional' ? /type\(scope\): subject \(KEY\)/ : /ABC-1234: Fix the search timeout/);
    } else assert.equal(existsSync(f.report), false);
  }
  const f = await detailed('shouty');
  await fails(f.agent('merge-request:check-details', 'p', 'ABC-5', 'A'), /unknown "merge-request-title" "shouty"/);
});

test('ASS-219 AC3/AC4: each commit subject on the branch, its trailing (KEY) left off, must be in the description, case aside; one missing fails, the report listing it, and passing again removes the report', async () => {
  const commits = ['Close the account (ABC-5)', 'Re-pin the five cluster allowances (ABC-5)', 'Keep the audit row'];
  const f = await detailed(undefined, { description: '- close the account\n- Keep the audit row' }, { commits });
  assert.deepEqual(await f.check(), { status: 'failed' });
  const report = readFileSync(f.report, 'utf8');
  assert.ok(report.includes('- Re-pin the five cluster allowances'), report);
  assert.ok(!report.includes('Keep the audit row') && !report.includes('- Close the account'), report);
  view(f, 'app', 7, { head_pipeline: null, description: '- close the account\n- re-pin the five cluster allowances\n- Keep the audit row' });
  assert.deepEqual(await f.check(), { status: 'passed' });
  assert.equal(existsSync(f.report), false);
});

test('ASS-219 AC2/AC4: the head pipeline\'s .pre jobs (mr-title) are waited for — running is waiting; failed sends the step back with the job\'s log in the report; other stages, allowed failures and no pipeline or no .pre job pass at once', async () => {
  const job = (status, v = {}) => ({ id: 9, name: 'mr-title', stage: '.pre', status, allow_failure: false, ...v });
  const other = { id: 10, name: 'unit', stage: 'test', status: 'failed', allow_failure: false };
  const f = await detailed(undefined, { head_pipeline: { id: 50, status: 'running' } }, { jobs: [job('running'), other] });
  assert.deepEqual(await f.check(), { status: 'waiting' });
  assert.equal(existsSync(f.report), false);
  f.forge.route('glab', /pipelines\/50\/jobs/, { out: [job('failed'), other] });
  f.forge.route('glab', /^api projects\/g%2Fapp\/jobs\/9\/trace --hostname gitlab.com$/, { out: 'Checking the title\nERROR: the merge request title is not a conventional commit:' });
  assert.deepEqual(await f.check(), { status: 'failed' });
  const report = readFileSync(f.report, 'utf8');
  assert.ok(report.includes('MR 1 (!7): its pipeline\'s .pre job mr-title failed'), report);
  assert.ok(report.includes('ERROR: the merge request title is not a conventional commit:'), report);
  for (const jobs of [[job('success'), other], [job('failed', { allow_failure: true })], [other]]) {
    f.forge.route('glab', /pipelines\/50\/jobs/, { out: jobs });
    assert.deepEqual(await f.check(), { status: 'passed' }, JSON.stringify(jobs));
  }
  assert.equal(existsSync(f.report), false);
  // No head pipeline: no job asked for.
  const g = await detailed(undefined, {});
  assert.deepEqual(await g.check(), { status: 'passed' });
  assert.ok(!g.forge.log('glab').some(l => /pipelines/.test(l)));
});

// ASS-302: GitHub truncates a commit subject over ~70 characters in messageHeadline — cut at 69 characters
// and ended with "…" (U+2026) — and holds the rest in messageBody, itself led by "…", the commit's own
// body following after a blank line.
// LONG_SUBJECT is 104 characters, its trailing (ABC-5) past the cut, as seen on ASS-301's branch.
const LONG_SUBJECT = 'ABC-5: Close the account and re-pin the five cluster allowances it held open while it all drains (ABC-5)';
const COMMIT_BODY = 'The allowances were pinned by hand in the console.';
const truncated = (subject = LONG_SUBJECT, body = COMMIT_BODY) => ({ messageHeadline: `${subject.slice(0, 69)}…`, messageBody: `…${subject.slice(69)}\n\n${body}` });

// Project p's one merge request on GitHub, MR 1 (#4) Open, its PR as gh pr view answers it; f.pr re-answers
// it, f.check and f.report read as detailed()'s do.
async function hubDetailed({ title = 'ABC-5: Close the account', body = `> ABC-5\n\n- ${LONG_SUBJECT}`, commits = [truncated()] } = {}) {
  const f = await planned([{ id: 1, repository: HUB }]);
  f.record({ 1: { status: 'Open', key: '#4', base: 'main' } });
  f.pr = (v = {}) => f.forge.route('gh', /^pr view 4 --repo o\/h --json title,body,commits$/, { out: { title, body, commits, ...v } });
  f.pr();
  f.check = async () => JSON.parse((await f.agent('merge-request:check-details', 'p', 'ABC-5', 'A')).stdout);
  f.report = join(f.dir, 'p', 'work', 'ABC-5', 'merge-request-details-check-A.md');
  return f;
}

test('ASS-302 AC1/AC3: a GitHub commit subject cut short in messageHeadline is rebuilt from messageBody, both "…" markers left off, before the match — the full subject in the description passes with no report, case aside and its trailing (KEY) aside; an empty or absent messageBody falls back to the headline', async () => {
  const f = await hubDetailed();
  assert.deepEqual(await f.check(), { status: 'passed' });
  assert.equal(existsSync(f.report), false);
  // The commit's own body, past the subject's first line, is not folded into the subject: the description never names it.
  assert.ok(!`> ABC-5\n\n- ${LONG_SUBJECT}`.includes(COMMIT_BODY));
  // The same subject named in another case, and named without the trailing (ABC-5) that sits in the remainder.
  for (const body of [`> ABC-5\n\n- ${LONG_SUBJECT.toLowerCase()}`, `> ABC-5\n\n- ${LONG_SUBJECT.replace(' (ABC-5)', '')}`]) {
    const g = await hubDetailed({ body });
    assert.deepEqual(await g.check(), { status: 'passed' }, body);
    assert.equal(existsSync(g.report), false);
  }
  // A headline ending in "…" with no remainder to rebuild from: the headline without it, and no jq error taking the command down.
  for (const messageBody of ['', null]) {
    const g = await hubDetailed({ commits: [{ ...truncated(), messageBody }], body: `> ABC-5\n\n- ${LONG_SUBJECT.slice(0, 69)}` });
    const { stdout, stderr } = await g.agent('merge-request:check-details', 'p', 'ABC-5', 'A');
    assert.deepEqual(JSON.parse(stdout), { status: 'passed' }, JSON.stringify(messageBody));
    assert.doesNotMatch(stderr, /jq: error/, stderr);
  }
});

test('ASS-302 AC2/AC3: a subject missing from the description fails, the report naming the full untruncated subject and never GitHub\'s "…" form; naming it passes and removes the report, and an untruncated commit missing beside a truncated one present is listed alone', async () => {
  const f = await hubDetailed({ body: '> ABC-5\n\n- Something else' });
  assert.deepEqual(await f.check(), { status: 'failed' });
  const report = readFileSync(f.report, 'utf8');
  assert.ok(report.includes(`- ${LONG_SUBJECT.replace(' (ABC-5)', '')}`), report);
  assert.ok(!report.includes('…'), report);
  // Named in the description now.
  f.pr({ body: `> ABC-5\n\n- ${LONG_SUBJECT}` });
  assert.deepEqual(await f.check(), { status: 'passed' });
  assert.equal(existsSync(f.report), false);
  const g = await hubDetailed({ commits: [truncated(), { messageHeadline: 'Keep the audit row' }] });
  assert.deepEqual(await g.check(), { status: 'failed' });
  const mixed = readFileSync(g.report, 'utf8');
  assert.ok(mixed.includes('- Keep the audit row'), mixed);
  assert.ok(!mixed.includes(LONG_SUBJECT.slice(0, 69)), mixed);
});

test('ASS-219 AC2: on GitHub the title and commits come from gh pr view, and with no pre-stage jobs there it passes at once; Closed, Merged and Not Created ones are not checked', async () => {
  const f = await planned([{ id: 1, repository: HUB }, { id: 2, repository: APP }, { id: 3, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '#4', base: 'main' }, 2: { status: 'Merged', key: '!8', base: 'master' } });
  f.forge.route('gh', /^pr view 4 --repo o\/h --json title,body,commits$/, { out: { title: 'ABC-5: Close the account', body: 'Close the account', commits: [{ messageHeadline: 'Close the account (ABC-5)' }] } });
  assert.deepEqual(JSON.parse((await f.agent('merge-request:check-details', 'p', 'ABC-5', 'A')).stdout), { status: 'passed' });
  assert.ok(!f.forge.log('glab').some(l => /merge_requests/.test(l)), f.forge.log('glab').join('\n'));
  f.forge.route('gh', /^pr view 4 /, { out: { title: 'ABC-5: Close the account', body: '', commits: [{ messageHeadline: 'Close the account (ABC-5)' }] } });
  assert.deepEqual(JSON.parse((await f.agent('merge-request:check-details', 'p', 'ABC-5', 'A')).stdout), { status: 'failed' });
});

// ASS-238: VM agents read and update their merge requests through host commands — merge-request:view, :update
// (the description on stdin) and :upload-image (a PNG on stdin, the markdown to embed printed) — run with the
// host's forge login; no forge token or CLI in the VM. Each takes the planned id of one created merge request.
const piped = (f, input, ...args) => new Promise((resolve, reject) => {
  const child = execFile(AGENT, args, { env: { ...process.env, PROJECTS_DIR: f.dir, PATH: f.forge.path }, encoding: 'buffer' },
    (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: stderr.toString() })) : resolve({ stdout: stdout.toString(), stderr: stderr.toString() })));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake image bytes')]);

test('ASS-238 AC1, ASS-239 AC2: merge-request:view <id> on GitLab prints the MR — state, draft, base, branch, title, description — with its unresolved threads and its head pipeline\'s failed jobs, their log ends; refused for an id not created', async () => {
  const f = await planned([{ id: 1, repository: APP }, { id: 2, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  view(f, 'app', 7, { description: 'D', source_branch: 'change/ABC-5-1', head_pipeline: { id: 50, status: 'failed' } });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/discussions\?per_page=100 --hostname gitlab.com$/, { out: [
    { id: 'd1', notes: [{ resolvable: true, resolved: false, author: { username: 'rev' }, body: 'Rename x', position: { new_path: 'a.js', new_line: 3 } }, { resolvable: true, resolved: false, author: { username: 'me' }, body: 'Why?' }] },
    { notes: [{ resolvable: false, author: { username: 'bot' }, body: 'added 1 commit' }] },
    { notes: [{ resolvable: true, resolved: true, author: { username: 'rev' }, body: 'Done already' }] },
  ] });
  f.forge.route('glab', /^api projects\/g%2Fapp\/pipelines\/50\/jobs\?per_page=100 --hostname gitlab.com$/, { out: [
    { id: 9, name: 'unit', status: 'failed', allow_failure: false, web_url: 'https://gitlab.com/g/app/-/jobs/9' },
    { id: 10, name: 'lint', status: 'failed', allow_failure: true }, { id: 11, name: 'build', status: 'success' }] });
  f.forge.route('glab', /^api projects\/g%2Fapp\/jobs\/9\/trace --hostname gitlab.com$/, { out: 'setup\nFAIL a.test.js' });
  assert.deepEqual(JSON.parse((await f.agent('merge-request:view', 'p', 'abc-5', 'A', '1')).stdout), {
    id: 1, url: `${APP}/-/merge_requests/7`, state: 'Open', draft: true, base: 'master', branch: 'change/ABC-5-1', title: 'Draft: ABC-5: Close the account', description: 'D',
    threads: [{ id: 'd1', path: 'a.js', line: 3, comments: [{ author: 'rev', body: 'Rename x' }, { author: 'me', body: 'Why?' }] }],
    'failed-jobs': [{ name: 'unit', url: 'https://gitlab.com/g/app/-/jobs/9', log: 'setup\nFAIL a.test.js' }],
  });
  await fails(f.agent('merge-request:view', 'p', 'ABC-5', 'A', '2'), /merge-request:view: ABC-5 A has no created merge request 2/);
  await fails(f.agent('merge-request:view', 'p', 'ABC-5', 'A', '!7'), /<id> must be a planned merge request's id/);
  await fails(f.agent('merge-request:view', 'p', 'ABC-5', 'A'), /usage: merge-request:view <project> <ticket-key> <variation> <id>/);
});

test('ASS-238 AC1, ASS-239 AC2: merge-request:view <id> on GitHub prints the pull request the same way, its unresolved review threads from GraphQL and its failing checks', async () => {
  const f = await planned([{ id: 1, repository: HUB }]);
  f.record({ 1: { status: 'Open', key: '#12', base: 'main' } });
  f.forge.route('gh', /^pr view 12 --repo o\/h --json url,state,isDraft,baseRefName,headRefName,title,body,statusCheckRollup$/, { out: {
    url: 'https://github.com/o/h/pull/12', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'change/ABC-5-1', title: 'ABC-5: Close the account', body: 'B',
    statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE', detailsUrl: 'https://ci/1' }, { name: 'ok', conclusion: 'SUCCESS', detailsUrl: 'https://ci/2' }] } });
  f.forge.route('gh', /^api graphql -f query=.*reviewThreads.* -f owner=o -f name=h -F number=12$/, { out: { data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: 'PRRT_1', isResolved: false, path: 'a.js', line: 2, comments: { nodes: [{ author: { login: 'rev' }, body: 'why?' }] } },
    { isResolved: true, path: 'b.js', line: 1, comments: { nodes: [{ author: { login: 'rev' }, body: 'ok' }] } }] } } } } } });
  assert.deepEqual(JSON.parse((await f.agent('merge-request:view', 'p', 'ABC-5', 'A', '1')).stdout), {
    id: 1, url: 'https://github.com/o/h/pull/12', state: 'Open', draft: false, base: 'main', branch: 'change/ABC-5-1', title: 'ABC-5: Close the account', description: 'B',
    threads: [{ id: 'PRRT_1', path: 'a.js', line: 2, comments: [{ author: 'rev', body: 'why?' }] }],
    'failed-jobs': [{ name: 'ci', url: 'https://ci/1' }],
  });
  assert.equal(f.forge.log('glab').filter(l => l !== 'auth status').length, 0);
});

test('ASS-238 AC1: merge-request:update <id> - [<title>] sets the description from stdin and the title on GitLab, a draft kept a draft, and a changed title starts a new merge request pipeline; no title, or the same one, starts none', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  view(f, 'app', 7, {});
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7 --hostname gitlab.com -X PUT /, { out: mr(7) });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/pipelines --hostname gitlab.com -X POST$/, { out: { id: 51 } });
  const { stdout } = await piped(f, 'New "description" with $dollars\n', 'merge-request:update', 'p', 'ABC-5', 'A', '1', '-', 'ABC-5: Close the account (app)');
  assert.equal(stdout, `${APP}/-/merge_requests/7\n`);
  const writes = () => f.forge.log('glab').filter(l => / -X (PUT|POST)/.test(l));
  assert.deepEqual(writes(), [
    'api projects/g%2Fapp/merge_requests/7 --hostname gitlab.com -X PUT -f description=New "description" with $dollars -f title=Draft: ABC-5: Close the account (app)',
    'api projects/g%2Fapp/merge_requests/7/pipelines --hostname gitlab.com -X POST']);
  await piped(f, 'Only the description', 'merge-request:update', 'p', 'ABC-5', 'A', '1', '-');
  await piped(f, 'Same title', 'merge-request:update', 'p', 'ABC-5', 'A', '1', '-', 'ABC-5: Close the account');   // as it is, its draft prefix aside
  assert.deepEqual(writes().slice(2), [
    'api projects/g%2Fapp/merge_requests/7 --hostname gitlab.com -X PUT -f description=Only the description',
    'api projects/g%2Fapp/merge_requests/7 --hostname gitlab.com -X PUT -f description=Same title -f title=Draft: ABC-5: Close the account']);
  await assert.rejects(piped(f, '  \n', 'merge-request:update', 'p', 'ABC-5', 'A', '1', '-'), e => /nothing on stdin/.test(e.stderr));
  await assert.rejects(piped(f, 'x', 'merge-request:update', 'p', 'ABC-5', 'A', '1', 'desc.md'), e => /usage: merge-request:update <project> <ticket-key> <variation> <id> - \[<title>\]/.test(e.stderr));
  assert.equal(writes().length, 4);
});

test('ASS-238 AC1: merge-request:update <id> on GitHub edits the pull request\'s body and title with gh --repo', async () => {
  const f = await planned([{ id: 1, repository: HUB }]);
  f.record({ 1: { status: 'Open', key: '#12', base: 'main' } });
  f.forge.route('gh', /^pr edit 12 --repo o\/h /, { out: 'https://github.com/o/h/pull/12' });
  assert.equal((await piped(f, 'Body\n', 'merge-request:update', 'p', 'ABC-5', 'A', '1', '-', 'ABC-5: Close the account')).stdout, 'https://github.com/o/h/pull/12\n');
  await piped(f, 'Body only', 'merge-request:update', 'p', 'ABC-5', 'A', '1', '-');
  assert.deepEqual(f.forge.log('gh'), ['pr edit 12 --repo o/h --body Body --title ABC-5: Close the account', 'pr edit 12 --repo o/h --body Body only']);
});

test('ASS-238 AC1: merge-request:upload-image <id> - <name> uploads a PNG from stdin to the GitLab project\'s uploads and prints the markdown to embed; not a PNG, or a bad name, is refused before any forge call', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  f.forge.route('glab', /^api projects\/g%2Fapp\/uploads --hostname gitlab.com -X POST --form file=@\/.+\/login\.png$/, { out: { markdown: '![login.png](/uploads/abc/login.png)', url: '/uploads/abc/login.png' } });
  assert.equal((await piped(f, PNG, 'merge-request:upload-image', 'p', 'ABC-5', 'A', '1', '-', 'login.png')).stdout, '![login.png](/uploads/abc/login.png)\n');
  const before = f.forge.log('glab').length;
  await assert.rejects(piped(f, 'not an image', 'merge-request:upload-image', 'p', 'ABC-5', 'A', '1', '-', 'login.png'), e => /stdin is not a PNG/.test(e.stderr));
  for (const name of ['../x.png', 'shot.jpg', 'a b.png']) await assert.rejects(piped(f, PNG, 'merge-request:upload-image', 'p', 'ABC-5', 'A', '1', '-', name), e => /<name> must be a file name ending \.png/.test(e.stderr), name);
  await assert.rejects(piped(f, PNG, 'merge-request:upload-image', 'p', 'ABC-5', 'A', '1', '-'), e => /usage: merge-request:upload-image <project> <ticket-key> <variation> <id> - <name>/.test(e.stderr));
  assert.equal(f.forge.log('glab').length, before);
});

test('ASS-238 AC1: merge-request:upload-image <id> on GitHub commits the PNG to screenshots/<KEY>-<variation> under <id>/ through the git data API — the branch made, then built on — and prints a link pinned to that commit', async () => {
  const f = await planned([{ id: 1, repository: HUB }]);
  f.record({ 1: { status: 'Open', key: '#12', base: 'main' } });
  const branch = 'screenshots/ABC-5-A';
  f.forge.route('gh', new RegExp(`^api repos/o/h/git/ref/heads/${branch}$`), { exit: 1 });
  f.forge.route('gh', /^api repos\/o\/h\/git\/blobs -X POST --input -$/, { out: { sha: 'b1' } });
  f.forge.route('gh', /^api repos\/o\/h\/git\/trees -X POST --input -$/, { out: { sha: 't1' } });
  f.forge.route('gh', /^api repos\/o\/h\/git\/commits -X POST --input -$/, { out: { sha: 'c1' } });
  f.forge.route('gh', /^api repos\/o\/h\/git\/refs -X POST --input -$/, { out: {} });
  assert.equal((await piped(f, PNG, 'merge-request:upload-image', 'p', 'abc-5', 'A', '1', '-', 'login.png')).stdout, '![login.png](https://github.com/o/h/blob/c1/1/login.png?raw=true)\n');
  const sent = f.forge.stdin('gh').map(s => JSON.parse(s));
  assert.deepEqual(sent, [
    { content: PNG.toString('base64'), encoding: 'base64' },
    { tree: [{ path: '1/login.png', mode: '100644', type: 'blob', sha: 'b1' }] },
    { message: 'ABC-5 A: screenshot login.png for merge request 1', tree: 't1', parents: [] },
    { ref: `refs/heads/${branch}`, sha: 'c1' }]);
  // The branch is there now: built on its head, moved forward.
  f.forge.route('gh', new RegExp(`^api repos/o/h/git/ref/heads/${branch}$`), { out: { object: { sha: 'c1' } } });
  f.forge.route('gh', /^api repos\/o\/h\/git\/commits\/c1$/, { out: { tree: { sha: 't1' } } });
  f.forge.route('gh', /^api repos\/o\/h\/git\/commits -X POST --input -$/, { out: { sha: 'c2' } });
  f.forge.route('gh', new RegExp(`^api repos/o/h/git/refs/heads/${branch} -X PATCH --input -$`), { out: {} });
  assert.equal((await piped(f, PNG, 'merge-request:upload-image', 'p', 'ABC-5', 'A', '1', '-', 'after.png')).stdout, '![after.png](https://github.com/o/h/blob/c2/1/after.png?raw=true)\n');
  assert.deepEqual(f.forge.stdin('gh').slice(4).map(s => JSON.parse(s)).slice(1), [
    { base_tree: 't1', tree: [{ path: '1/after.png', mode: '100644', type: 'blob', sha: 'b1' }] },
    { message: 'ABC-5 A: screenshot after.png for merge request 1', tree: 't1', parents: ['c1'] },
    { sha: 'c2' }]);
  assert.ok(!f.forge.log('gh').some(l => / --ref| main|change\/ABC-5-1/.test(l)), 'never the merge request\'s branch or its base');
});

// ASS-239: the agent answers review threads through the host too — merge-request:reply <id> <thread-id> - (the reply
// on stdin) and merge-request:resolve <id> <thread-id>, the thread named by the id merge-request:view prints.
test('ASS-239 AC1: merge-request:reply <id> <thread-id> - adds the stdin as a note on the GitLab discussion, and merge-request:resolve resolves it; a bad thread id, no reply, or a bad usage makes no forge call', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/discussions\/d1\/notes --hostname gitlab.com -X POST /, { out: { id: 3 } });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/discussions\/d1 --hostname gitlab.com -X PUT -f resolved=true$/, { out: { id: 'd1' } });
  await piped(f, 'Renamed x to y in abc123 "quoted" $x\n', 'merge-request:reply', 'p', 'abc-5', 'A', '1', 'd1', '-');
  await f.agent('merge-request:resolve', 'p', 'ABC-5', 'A', '1', 'd1');
  const writes = () => f.forge.log('glab').filter(l => / -X (PUT|POST)/.test(l));
  assert.deepEqual(writes(), [
    'api projects/g%2Fapp/merge_requests/7/discussions/d1/notes --hostname gitlab.com -X POST -f body=Renamed x to y in abc123 "quoted" $x',
    'api projects/g%2Fapp/merge_requests/7/discussions/d1 --hostname gitlab.com -X PUT -f resolved=true']);
  await assert.rejects(piped(f, 'x', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', '../d1', '-'), e => /<thread-id> must be a thread's id from merge-request:view/.test(e.stderr));
  await fails(f.agent('merge-request:resolve', 'p', 'ABC-5', 'A', '1', 'd1/notes'), /<thread-id> must be a thread's id from merge-request:view/);
  await assert.rejects(piped(f, ' \n', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', 'd1', '-'), e => /nothing on stdin/.test(e.stderr));
  await assert.rejects(piped(f, 'x', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', 'd1'), e => /usage: merge-request:reply <project> <ticket-key> <variation> <id> <thread-id> -/.test(e.stderr));
  await fails(f.agent('merge-request:resolve', 'p', 'ABC-5', 'A', '1'), /usage: merge-request:resolve <project> <ticket-key> <variation> <id> <thread-id>/);
  await assert.rejects(piped(f, 'x', 'merge-request:reply', 'p', 'ABC-5', 'A', '2', 'd1', '-'), e => /has no created merge request 2/.test(e.stderr));
  assert.equal(writes().length, 2);
});

test('ASS-239 AC1: on GitHub merge-request:reply and :resolve reply to and resolve the review thread through GraphQL, once the thread is found on this pull request; another\'s thread is refused', async () => {
  const f = await planned([{ id: 1, repository: HUB }]);
  f.record({ 1: { status: 'Open', key: '#12', base: 'main' } });
  const owner = /^api graphql -f query=.*PullRequestReviewThread.* -f id=PRRT_1$/;
  f.forge.route('gh', owner, { out: { data: { node: { pullRequest: { number: 12, repository: { nameWithOwner: 'O/h' } } } } } });
  f.forge.route('gh', /^api graphql -f query=mutation.*addPullRequestReviewThreadReply.* -f thread=PRRT_1 -f body=/, { out: { data: { addPullRequestReviewThreadReply: { comment: { url: 'u' } } } } });
  f.forge.route('gh', /^api graphql -f query=mutation.*resolveReviewThread.* -f thread=PRRT_1$/, { out: { data: { resolveReviewThread: { thread: { isResolved: true } } } } });
  await piped(f, 'Done in abc123\n', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', 'PRRT_1', '-');
  await f.agent('merge-request:resolve', 'p', 'ABC-5', 'A', '1', 'PRRT_1');
  const mutations = () => f.forge.log('gh').filter(l => /query=mutation/.test(l));
  assert.equal(mutations().length, 2);
  assert.match(mutations()[0], /-f thread=PRRT_1 -f body=Done in abc123$/);
  // A thread on another pull request, or another repository's, or no thread at all: refused, nothing changed.
  for (const node of [{ pullRequest: { number: 13, repository: { nameWithOwner: 'o/h' } } }, { pullRequest: { number: 12, repository: { nameWithOwner: 'o/other' } } }, null]) {
    f.forge.route('gh', owner, { out: { data: { node } } });
    await assert.rejects(piped(f, 'x', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', 'PRRT_1', '-'), e => /PRRT_1 is not a review thread of MR 1 \(#12\)/.test(e.stderr), JSON.stringify(node));
    await fails(f.agent('merge-request:resolve', 'p', 'ABC-5', 'A', '1', 'PRRT_1'), /PRRT_1 is not a review thread of MR 1 \(#12\)/);
  }
  assert.equal(mutations().length, 2);
  assert.equal(f.forge.log('glab').filter(l => l !== 'auth status').length, 0);
});

// ASS-335: a merge request depending on one in another repository is not
// stacked on it (same-repository ones are), so its tests run against what that
// repository has published — the dependency's change missing until it merges.
// merge-request:await-dependencies is Build's gate before Automated Testing
// (grouped-build's Await Dependencies in Other Repositories, waiting exit 2;
// the engine side: test/workflow/grouped-development.test.js): 2 while one
// waits, 0 once none does.
const awaiting = async f => {
  try { const { stdout } = await f.agent('merge-request:await-dependencies', 'p', 'ABC-5', 'A'); return { code: 0, out: JSON.parse(stdout) }; }
  catch (e) { return { code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null, err: e.stderr }; }
};

test('ASS-335 AC1: MR 2 depending on MR 1 in another repository, MR 1 not Merged — merge-request:await-dependencies waits (exit 2), naming both, so the tests are not run; the forge is read first, so the wait is on its live state', async () => {
  const f = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  f.record({ 1: { status: 'Open', key: '!7', url: `${LIB}/-/merge_requests/7`, base: 'master' }, 2: { status: 'Open', key: '!9', url: `${APP}/-/merge_requests/9`, base: 'master' } });
  view(f, 'lib', 7, { web_url: `${LIB}/-/merge_requests/7` });
  view(f, 'app', 9, {});
  const waiting = await awaiting(f);
  assert.equal(waiting.code, 2, waiting.err);
  assert.deepEqual(waiting.out, { waiting: [{ id: 2, repository: APP, 'depends-on': { id: 1, repository: LIB, status: 'Open', key: '!7', url: `${LIB}/-/merge_requests/7` } }] });
  assert.ok(f.forge.log('glab').includes('api projects/g%2Flib/merge_requests/7 --hostname gitlab.com'), f.forge.log('glab').join('\n'));
  // Recorded Open, but merged on the forge since: no wait.
  view(f, 'lib', 7, { state: 'merged' });
  assert.equal((await awaiting(f)).code, 0);
  // Not yet created counts as not merged too.
  const g = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  g.record({ 2: { status: 'Open', key: '!9', base: 'master' } });
  view(g, 'app', 9, {});
  const unmade = await awaiting(g);
  assert.deepEqual([unmade.code, unmade.out.waiting[0]['depends-on'].status], [2, 'Not Created']);
});

test('ASS-335 AC2: once MR 1 is Merged the dependent flow goes on — merge-request:await-dependencies exits 0, MR 1 recorded Merged; nothing to wait for (a same-repository dependency, which is stacked, one Closed, or none) exits 0 asking no forge', async () => {
  const f = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '!9', base: 'master' } });
  view(f, 'lib', 7, { state: 'merged' });
  view(f, 'app', 9, {});
  assert.deepEqual(await awaiting(f), { code: 0, out: { waiting: [] } });
  assert.deepEqual(f.mrs().map(m => [m.id, m.status]), [[1, 'Merged'], [2, 'Open']]);
  // Recorded Merged: no forge asked at all.
  const asked = f.forge.log('glab').length;
  assert.deepEqual(await awaiting(f), { code: 0, out: { waiting: [] } });
  assert.equal(f.forge.log('glab').length, asked);
  for (const [entries, created] of [
    [[{ id: 1, repository: APP }, { id: 2, repository: APP, 'depends-on': [1] }], { 1: { status: 'Open', key: '!7' }, 2: { status: 'Open', key: '!9' } }],
    [[{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }], { 1: { status: 'Closed' }, 2: { status: 'Open', key: '!9' } }],
    [[{ id: 1, repository: LIB }, { id: 2, repository: APP }], { 1: { status: 'Open', key: '!7' }, 2: { status: 'Open', key: '!9' } }],
  ]) {
    const g = await planned(entries);
    g.record(created);
    assert.deepEqual(await awaiting(g), { code: 0, out: { waiting: [] } }, JSON.stringify(entries));
    assert.deepEqual(g.forge.log('glab'), [], JSON.stringify(entries));
  }
});

// ASS-335 AC3: merge-request:create titles a merge request in the project's
// format, so a CI mr-title job (a conventional-commit lint) passes from the
// first pipeline. lint-title.sh's regex, as merge-request-title.bash copies it.
const CONVENTIONAL = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test|flow)(\([a-z0-9._/-]+\))?!?: .+/;

test('ASS-335 AC3: with "merge-request-title": "conventional", merge-request:create <id> opens "<type>: <title> (<KEY>)" — a Bug a fix, a Story (or none) a feat, a Task a chore; with several MRs "(MR <id>)" before the key — passing the conventional-commit regex', async () => {
  for (const [issueType, count, wanted] of [
    ['Bug', 1, 'fix: close the account (ABC-5)'],
    ['Story', 1, 'feat: close the account (ABC-5)'],
    [undefined, 1, 'feat: close the account (ABC-5)'],
    ['Task', 2, 'chore: close the account (MR 1) (ABC-5)'],
  ]) {
    const f = await planned(Array.from({ length: count }, (_, i) => ({ id: i + 1, repository: LIB })));
    const project = join(f.dir, 'p', 'project.json');
    writeFileSync(project, JSON.stringify({ ...JSON.parse(readFileSync(project, 'utf8')), 'merge-request-title': 'conventional' }));
    if (issueType) { const sprint = JSON.parse(readFileSync(f.file, 'utf8')); sprint.features[0]['issue-type'] = issueType; writeFileSync(f.file, JSON.stringify(sprint, null, 4)); }
    f.forge.route('glab', /merge_requests\?state=opened&source_branch=/, { out: [] });
    f.forge.route('glab', /repository\/branches\//, { out: {} });
    f.forge.route('glab', /repository\/compare\?/, { out: { diffs: [{ new_path: 'a.js' }] } });
    f.forge.route('glab', /^api projects\/g%2Flib\/merge_requests --hostname gitlab.com -X POST/, { out: { iid: 7, web_url: `${LIB}/-/merge_requests/7` } });
    await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '1');
    const post = f.forge.log('glab').find(l => / -X POST/.test(l));
    const title = post.match(/ -f title=Draft: (.*) -f description=/)[1];
    assert.equal(title, wanted, post);
    assert.match(title, CONVENTIONAL);
    assert.ok(title.endsWith(' (ABC-5)'));
  }
  // A bug filed in the sprint's bugs, no issue-type recorded: a fix. An acronym keeps its capitals.
  const f = await planned([{ id: 1, repository: HUB }]);
  writeFileSync(join(f.dir, 'p', 'project.json'), JSON.stringify({ repositories: [{ url: HUB }], 'merge-request-title': 'conventional' }));
  const sprint = JSON.parse(readFileSync(f.file, 'utf8'));
  sprint.bugs = [{ ...sprint.features[0], title: 'API times out' }]; sprint.features = [];
  writeFileSync(f.file, JSON.stringify(sprint, null, 4));
  f.forge.route('gh', /^pr list /, { out: [] });
  f.forge.route('gh', /^api repos\/o\/h\/compare\//, { out: { files: [{ filename: 'a.js' }] } });
  f.forge.route('gh', /^pr create /, { out: 'https://github.com/o/h/pull/12' });
  await f.agent('merge-request:create', 'p', 'ABC-5', 'A', '1');
  const created = f.forge.log('gh').find(l => /^pr create/.test(l));
  assert.match(created, / --title fix: API times out \(ABC-5\) --body /);
  assert.match('fix: API times out (ABC-5)', CONVENTIONAL);
});
