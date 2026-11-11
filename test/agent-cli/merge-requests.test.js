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
  // !8 waits on !7, unmerged: nothing for Ensure Auto-Merge to do yet, so Team Code Review just waits (ASS-351).
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: false });
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
    comments: [],   // ASS-361: its notes not readable here (no route), so none
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
    comments: [],   // ASS-361: no review comments (no route for them)
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
  assert.deepEqual(waiting.out, { waiting: [{ id: 2, repository: APP, 'depends-on': { id: 1, repository: LIB, status: 'Open', key: '!7', url: `${LIB}/-/merge_requests/7` }, needs: ['draft'] }] });
  assert.ok(f.forge.log('glab').includes('api projects/g%2Flib/merge_requests/7 --hostname gitlab.com'), f.forge.log('glab').join('\n'));
  // Recorded Open, but merged on the forge since: no wait.
  view(f, 'lib', 7, { state: 'merged' });
  assert.equal((await awaiting(f)).code, 0);
  // Not yet created counts as not merged too — and, since ASS-359, is not waited on: exit 3, back to Generate Solution.
  const g = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  g.record({ 2: { status: 'Open', key: '!9', base: 'master' } });
  view(g, 'app', 9, {});
  const unmade = await awaiting(g);
  assert.deepEqual([unmade.code, unmade.out.waiting[0]['depends-on'].status], [3, 'Not Created']);
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

// ASS-359: merge-request:await-dependencies says why each dependency it waits
// on is not merging (needs), tells the operator through the variation's
// ai-feedback only when that changes, and sends a planned merge request never
// created back to Generate Solution (exit 3) rather than waiting on it.
// The engine side: test/workflow/grouped-development.test.js and
// test/control/tick-await-dependencies.test.js.
const variationOf = f => JSON.parse(readFileSync(f.file, 'utf8')).features[0].variations[0];
const LIB_7 = `${LIB}/-/merge_requests/7`;
// MR 2 (app) depending on MR 1 (lib !7), both Open; lib !7 as `v` says, its approvals_left `left` (null: no approvals route).
async function dependedOn(v, left = 0) {
  const f = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  f.record({ 1: { status: 'Open', key: '!7', url: LIB_7, base: 'master' }, 2: { status: 'Open', key: '!9', url: `${APP}/-/merge_requests/9`, base: 'master' } });
  view(f, 'lib', 7, { web_url: LIB_7, ...v });
  view(f, 'app', 9, {});
  if (left != null) f.forge.route('glab', /^api projects\/g%2Flib\/merge_requests\/7\/approvals --hostname gitlab.com$/, { out: { approvals_left: left } });
  return f;
}

test('ASS-359 AC1: each waiting dependency gets needs from its forge, in order — draft, build-failed, open-threads, needs-rebase, needs-approval — on GitLab and GitHub; one only waiting to merge has [] and the other fields are as before', async () => {
  const red = { draft: true, head_pipeline: { id: 55, status: 'failed' }, blocking_discussions_resolved: false, detailed_merge_status: 'need_rebase' };
  const f = await dependedOn(red, 2);
  f.forge.route('glab', /^api projects\/g%2Flib\/pipelines\/55\/jobs\?scope=failed --hostname gitlab.com$/, { out: [{ name: 'lint' }, { name: 'unit' }] });
  const all = await awaiting(f);
  assert.equal(all.code, 4, all.err);   // ASS-361: build-failed, open-threads and needs-rebase are its own to act on — exit 4
  assert.deepEqual(all.out, { waiting: [{ id: 2, repository: APP, 'depends-on': { id: 1, repository: LIB, status: 'Open', key: '!7', url: LIB_7 }, needs: ['draft', 'build-failed', 'open-threads', 'needs-rebase', 'needs-approval'] }] });
  // A canceled pipeline is build-failed too; conflicts need a rebase.
  const c = await dependedOn({ draft: false, head_pipeline: { id: 56, status: 'canceled' }, has_conflicts: true });
  c.forge.route('glab', /pipelines\/56\/jobs/, { out: [] });
  assert.deepEqual((await awaiting(c)).out.waiting[0].needs, ['build-failed', 'needs-rebase']);
  // Only waiting to merge (out of draft, green, set to auto-merge, approved): needs [], polled on silently.
  const ready = await dependedOn({ draft: false, merge_when_pipeline_succeeds: true });
  const quiet = await awaiting(ready);
  assert.deepEqual([quiet.code, quiet.out.waiting[0].needs, quiet.err], [2, [], '']);
  // A GitLab that will not say its approvals (no route: the call fails) needs none from it.
  const unsaid = await dependedOn({ draft: false }, null);
  assert.deepEqual((await awaiting(unsaid)).out.waiting[0].needs, []);
  // GitHub: a draft, a failed check, changes requested, behind its base, a review still required.
  const g = await planned([{ id: 1, repository: HUB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  g.record({ 1: { status: 'Open', key: '#12', url: 'https://github.com/o/h/pull/12', base: 'main' }, 2: { status: 'Open', key: '!9', base: 'master' } });
  view(g, 'app', 9, {});
  prView(g, 12, { reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BEHIND', statusCheckRollup: [{ name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/h/actions/runs/5/job/1' }] });
  assert.deepEqual((await awaiting(g)).out.waiting[0].needs, ['draft', 'build-failed', 'open-threads', 'needs-rebase']);
  prView(g, 12, { isDraft: false, reviewDecision: 'REVIEW_REQUIRED' });
  const review = await awaiting(g);
  assert.deepEqual(review.out.waiting[0].needs, ['needs-approval']);
  assert.match(variationOf(g)['ai-feedback-long'], /^o\/h #12 https:\/\/github.com\/o\/h\/pull\/12: it needs approval\./);
});

test('ASS-359 AC2: the operator is told what each dependency needs — repository, key, url, in plain words — once per change: not rewritten while the needs stay, rewritten when they change, cleared once nothing needs action; the log (stderr) says the same once', async () => {
  const f = await dependedOn({ draft: true, head_pipeline: { id: 55, status: 'failed' } }, 1);
  f.forge.route('glab', /pipelines\/55\/jobs\?scope=failed/, { out: [{ name: 'check-collisions' }] });
  const first = await awaiting(f);
  assert.equal(first.code, 4, first.err);   // ASS-361: a failed pipeline is its own to act on
  const told = variationOf(f);
  assert.equal(told['ai-feedback-short'], 'Waiting on g/lib !7: is a draft, its pipeline failed (check-collisions), it needs 1 approval; sent to Address Merge Request Feedback');
  assert.equal(told['ai-feedback-long'], `g/lib !7 ${LIB_7}: is a draft; its pipeline failed (check-collisions); it needs 1 approval. MR 2 depends on it. Build has sent g/lib !7 to Address Merge Request Feedback, to act on its review and pipeline; then this step waits again.`);
  assert.deepEqual(told['awaited-dependency-needs'].needs, [{ id: 1, key: '!7', needs: ['draft', 'build-failed', 'needs-approval'] }]);
  assert.match(first.err, /merge-request:await-dependencies: ABC-5 A: g\/lib !7 .*: is a draft; its pipeline failed \(check-collisions\); it needs 1 approval\./);
  // Polled again, the same needs: nothing written, nothing said.
  const again = await awaiting(f);
  assert.deepEqual([again.code, again.err], [4, '']);
  assert.deepEqual(variationOf(f), told);
  // Out of draft: the needs changed, so the feedback is rewritten and said once.
  view(f, 'lib', 7, { web_url: LIB_7, draft: false, head_pipeline: { id: 55, status: 'failed' } });
  const changed = await awaiting(f);
  assert.equal(variationOf(f)['ai-feedback-short'], 'Waiting on g/lib !7: its pipeline failed (check-collisions), it needs 1 approval; sent to Address Merge Request Feedback');
  assert.match(changed.err, /its pipeline failed \(check-collisions\); it needs 1 approval\./);
  // Green and approved, only waiting to merge: cleared, said once; then silent.
  view(f, 'lib', 7, { web_url: LIB_7, draft: false, merge_when_pipeline_succeeds: true });
  f.forge.route('glab', /merge_requests\/7\/approvals/, { out: { approvals_left: 0 } });
  const cleared = await awaiting(f);
  assert.equal(cleared.code, 2);
  assert.match(cleared.err, /no dependency in another repository needs action now/);
  assert.deepEqual([variationOf(f)['ai-feedback-short'], variationOf(f)['ai-feedback-long'], variationOf(f)['awaited-dependency-needs']], [null, null, undefined]);
  assert.equal((await awaiting(f)).err, '');
  // Feedback another step wrote since is not cleared: only this step's own.
  view(f, 'lib', 7, { web_url: LIB_7, draft: true });
  await awaiting(f);
  await f.agent('ticket:set-ai-feedback', 'p', 'ABC-5', 'A', 'Something else', 'Something else entirely');
  view(f, 'lib', 7, { state: 'merged' });
  assert.equal((await awaiting(f)).code, 0);
  assert.deepEqual([variationOf(f)['ai-feedback-short'], variationOf(f)['awaited-dependency-needs']], ['Something else', undefined]);
});

test('ASS-359 AC3: a dependency of the ticket\'s own never created is not waited on — exit 3, needs not-created, the operator told which and the execution plan noted for Generate Solution', async () => {
  const f = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  f.record({ 2: { status: 'Open', key: '!9', base: 'master' } });
  view(f, 'app', 9, {});
  const unmade = await awaiting(f);
  assert.equal(unmade.code, 3, unmade.err);
  assert.deepEqual(unmade.out.waiting, [{ id: 2, repository: APP, 'depends-on': { id: 1, repository: LIB, status: 'Not Created', key: null, url: null }, needs: ['not-created'] }]);
  assert.equal(variationOf(f)['ai-feedback-short'], 'Never created: MR 1 (g/lib); back to Generate Solution');
  assert.match(variationOf(f)['ai-feedback-long'], /^MR 1 \(g\/lib\): was never created\. MR 2 depends on it\. A planned merge request Generate Solution never created is not waited on/);
  assert.ok(f.notes().some(l => /MR 1 never created, though MR 2 in another repository depends on it: back to Generate Solution to build it and record it/.test(l)), f.notes().join('\n'));
  assert.ok(!f.forge.log('glab').some(l => /approvals|jobs/.test(l)), 'nothing asked of a forge for one not created');
});

test('ASS-359 AC4: an error in the command exits 1, never a code the step reads as waiting (2) or never created (3)', async () => {
  const f = await dependedOn({});
  view(f, 'lib', 7, {}, { exit: 1 });
  const failed = await awaiting(f);
  assert.equal(failed.code, 1, failed.err);
});

// ASS-361: a reviewer's blocking request left as a plain comment (no thread)
// on a waiting dependency — the ticket's own merge request — is
// review-comments, after open-threads; merge-request:view lists those
// comments, merge-request:reply answers one, and a dependency with feedback of
// its own to act on (threads, comments, a failed pipeline, a rebase) exits 4,
// grouped-build's way to its own Address Merge Request Feedback. The engine
// side: test/workflow/grouped-development.test.js and
// test/control/tick-await-dependencies.test.js.
const T = h => `2026-11-11T${String(h).padStart(2, '0')}:00:00.000Z`;
const note = (id, author, h, v = {}) => ({ id, author: { username: author }, body: `note ${id}`, created_at: T(h), system: false, resolvable: false, ...v });
// The project's push account (as control last checked it) and the host's own glab login: the harness's.
const ours = (f, provider = 'GitLab') => writeFileSync(join(f.dir, 'p', 'push-account.json'), JSON.stringify({ project: 'p', provider, account: 'Harness-Pusher', error: null, 'checked-at': T(1) }));
// <repo> !<iid>'s notes as given; its commits the latest at <commitAt> o'clock (an offset, as GitLab may give it), one earlier.
function noted(f, repo, iid, notes, commitAt = 10) {
  ours(f);
  f.forge.route('glab', /^api user --hostname gitlab.com$/, { out: { username: 'host-me' } });
  f.forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid}/notes\\?per_page=100 --hostname gitlab.com$`), { out: notes });
  f.forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid}/commits\\?per_page=100 --hostname gitlab.com$`), { out: [{ id: 'c2', committed_date: T(commitAt).replace('Z', '+00:00') }, { id: 'c1', committed_date: T(8) }] });
}
// o/h #12's issue comments and reviews as given, its latest commit at 10 o'clock.
const discussed = (f, comments, reviews = []) => f.forge.route('gh', /^pr view 12 --repo o\/h --json comments,reviews,commits$/, { out: { comments, reviews, commits: [{ oid: 'c1', committedDate: '2026-11-11T10:00:00Z' }] } });
const SAM = { id: 'IC_1', author: { login: 'sam' }, body: 'Renumber V12; it collides with master', createdAt: T(11) };
const HUB_REVIEWS = [
  { id: 'PRR_1', author: { login: 'lee' }, body: 'And rebase, please', state: 'COMMENTED', submittedAt: T(12) },
  { id: 'PRR_2', author: { login: 'kim' }, body: 'LGTM', state: 'APPROVED', submittedAt: T(12) },
  { id: 'PRR_3', author: { login: 'lee' }, body: '', state: 'COMMENTED', submittedAt: T(12) }];
const HUB_IGNORED = [{ id: 'IC_2', author: { login: 'github-actions[bot]' }, body: 'coverage 91%', createdAt: T(11) }, { id: 'IC_0', author: { login: 'kim' }, body: 'old', createdAt: T(9) }];
// MR 2 (app) depending on MR 1 (o/h #12), out of draft, nothing else needed.
async function hubDependedOn() {
  const g = await planned([{ id: 1, repository: HUB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  g.record({ 1: { status: 'Open', key: '#12', url: 'https://github.com/o/h/pull/12', base: 'main' }, 2: { status: 'Open', key: '!9', base: 'master' } });
  view(g, 'app', 9, {});
  prView(g, 12, { isDraft: false });
  ours(g, 'GitHub');
  g.forge.route('gh', /^api user$/, { out: { login: 'host-me' } });
  return g;
}

test('ASS-361 AC1: on GitLab a plain note — not system, not a bot\'s, not resolvable — by anyone but the harness after the latest commit is review-comments, after open-threads; a reply by the harness (push account or host login) or a new commit answers it', async () => {
  const f = await dependedOn({ draft: false, blocking_discussions_resolved: false });
  noted(f, 'lib', 7, [
    note(1, 'kim', 9),                               // before the latest commit
    note(2, 'sam', 11),                              // counts
    note(3, 'lee', 11, { resolvable: true }),        // a thread's: open-threads counts it
    note(4, 'sam', 12, { system: true }),            // "added 1 commit"
    note(5, 'project_12_bot_ab12', 12),              // a project bot's
    note(6, 'harness-pusher', 9)]);                  // the harness's own, before it
  const one = await awaiting(f);
  assert.equal(one.code, 4, one.err);
  assert.deepEqual(one.out.waiting[0].needs, ['open-threads', 'review-comments']);
  assert.match(variationOf(f)['ai-feedback-long'], /: it has unresolved review threads; it has a review comment from sam\. MR 2 depends on it\./);
  assert.deepEqual(variationOf(f)['awaited-dependency-needs'].needs, [{ id: 1, key: '!7', needs: ['open-threads', 'review-comments'], from: ['sam'] }]);
  // The thread resolved; the harness's reply after the comment — posted as the host's login, as merge-request:reply posts — answers it.
  view(f, 'lib', 7, { web_url: LIB_7, draft: false });
  noted(f, 'lib', 7, [note(2, 'sam', 11), note(7, 'host-me', 12)]);
  assert.deepEqual(await awaiting(f).then(r => [r.code, r.out.waiting[0].needs]), [2, []]);
  // Sam again, after that reply: counts; then the push account's reply (any case) answers it.
  noted(f, 'lib', 7, [note(2, 'sam', 11), note(7, 'host-me', 12), note(8, 'Sam', 13)]);
  assert.deepEqual(await awaiting(f).then(r => [r.code, r.out.waiting[0].needs]), [4, ['review-comments']]);
  noted(f, 'lib', 7, [note(2, 'sam', 11), note(7, 'host-me', 12), note(8, 'Sam', 13), note(9, 'Harness-Pusher', 14)]);
  assert.deepEqual(await awaiting(f).then(r => [r.code, r.out.waiting[0].needs]), [2, []]);
  // A new commit after the comment answers it too.
  noted(f, 'lib', 7, [note(8, 'sam', 13)], 14);
  assert.deepEqual(await awaiting(f).then(r => [r.code, r.out.waiting[0].needs]), [2, []]);
});

test('ASS-361 AC1: on GitHub an issue comment, or the body of a review that commented, by anyone but the harness after the latest commit is review-comments; an approval, an empty review, a [bot]\'s and an earlier one are not; the harness\'s reply answers it', async () => {
  const g = await hubDependedOn();
  discussed(g, [SAM, ...HUB_IGNORED], HUB_REVIEWS);
  const r = await awaiting(g);
  assert.equal(r.code, 4, r.err);
  assert.deepEqual(r.out.waiting[0].needs, ['review-comments']);
  assert.equal(variationOf(g)['ai-feedback-short'], 'Waiting on o/h #12: it has 2 review comments from lee, sam; sent to Address Merge Request Feedback');
  discussed(g, [SAM, ...HUB_IGNORED, { id: 'IC_3', author: { login: 'Host-Me' }, body: 'Renumbered in abc123', createdAt: T(13) }], HUB_REVIEWS);
  assert.deepEqual(await awaiting(g).then(x => [x.code, x.out.waiting[0].needs]), [2, []]);
  assert.ok(!g.forge.log('glab').some(l => /notes|commits|api user/.test(l)), 'a GitHub dependency\'s comments are never asked of GitLab');
});

test('ASS-361 AC2: merge-request:view lists the review comments still to act on as comments [{ id, author, body, created }] beside threads, on GitLab and GitHub, its other fields as before', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  view(f, 'app', 7, { description: 'D', source_branch: 'change/ABC-5-1' });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/discussions\?per_page=100 --hostname gitlab.com$/, { out: [] });
  noted(f, 'app', 7, [note(2, 'sam', 11), note(1, 'kim', 9), note(3, 'host-me', 10, { created_at: '2026-11-11T09:30:00Z' })]);
  const seen = JSON.parse((await f.agent('merge-request:view', 'p', 'ABC-5', 'A', '1')).stdout);
  assert.deepEqual(Object.keys(seen), ['id', 'url', 'state', 'draft', 'base', 'branch', 'title', 'description', 'threads', 'comments', 'failed-jobs']);
  assert.deepEqual([seen.threads, seen.comments], [[], [{ id: 2, author: 'sam', body: 'note 2', created: T(11) }]]);
  const g = await hubDependedOn();
  g.forge.route('gh', /^pr view 12 --repo o\/h --json url,state,isDraft,baseRefName,headRefName,title,body,statusCheckRollup$/, { out: {
    url: 'https://github.com/o/h/pull/12', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'change/ABC-5-1', title: 'ABC-5: Close the account', body: 'B', statusCheckRollup: [] } });
  g.forge.route('gh', /^api graphql -f query=.*reviewThreads.* -F number=12$/, { out: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } } });
  discussed(g, [SAM, ...HUB_IGNORED], HUB_REVIEWS);
  assert.deepEqual(JSON.parse((await g.agent('merge-request:view', 'p', 'ABC-5', 'A', '1')).stdout).comments, [
    { id: 'IC_1', author: 'sam', body: 'Renumber V12; it collides with master', created: T(11) },
    { id: 'PRR_1', author: 'lee', body: 'And rebase, please', created: T(12) }]);
});

test('ASS-361 AC4: merge-request:reply answers a plain review comment by its id from comments — a new comment naming its author and linking it, never a thread — once it is found on that merge request; another\'s is refused', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', url: `${APP}/-/merge_requests/7`, base: 'master' } });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/notes\/42 --hostname gitlab.com$/, { out: { id: 42, author: { username: 'sam' }, body: 'Renumber V12' } });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7\/notes --hostname gitlab.com -X POST /, { out: { id: 43 } });
  await piped(f, 'Renumbered to V13 in abc123\n', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', '42', '-');
  assert.ok(f.forge.log('glab').join('\n').includes(`api projects/g%2Fapp/merge_requests/7/notes --hostname gitlab.com -X POST -f body=@sam (re ${APP}/-/merge_requests/7#note_42)\n\nRenumbered to V13 in abc123`), f.forge.log('glab').join('\n'));
  assert.ok(!f.forge.log('glab').some(l => /discussions/.test(l)), 'no thread made of it');
  f.forge.route('glab', /notes\/44 --hostname/, { exit: 1 });
  await assert.rejects(piped(f, 'x', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', '44', '-'), e => /44 is not a comment of MR 1 \(!7\)/.test(e.stderr));
  assert.equal(f.forge.log('glab').filter(l => / -X POST/.test(l)).length, 1);
  const g = await planned([{ id: 1, repository: HUB }]);
  g.record({ 1: { status: 'Open', key: '#12', base: 'main' } });
  const node = pullRequest => g.forge.route('gh', /^api graphql -f query=.*IssueComment.* -f id=IC_1$/, { out: { data: { node: { url: 'https://github.com/o/h/pull/12#issuecomment-1', author: { login: 'sam' }, pullRequest } } } });
  node({ number: 12, repository: { nameWithOwner: 'o/h' } });
  g.forge.route('gh', /^api repos\/o\/h\/issues\/12\/comments -X POST -f body=/, { out: { id: 2 } });
  await piped(g, 'Done in abc123', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', 'IC_1', '-');
  assert.ok(g.forge.log('gh').join('\n').includes('api repos/o/h/issues/12/comments -X POST -f body=@sam (re https://github.com/o/h/pull/12#issuecomment-1)\n\nDone in abc123'), g.forge.log('gh').join('\n'));
  node({ number: 13, repository: { nameWithOwner: 'o/h' } });
  await assert.rejects(piped(g, 'x', 'merge-request:reply', 'p', 'ABC-5', 'A', '1', 'IC_1', '-'), e => /IC_1 is not a comment of MR 1 \(#12\)/.test(e.stderr));
  assert.equal(g.forge.log('gh').filter(l => / -X POST/.test(l)).length, 1);
});

test('ASS-361 AC3/AC5: feedback of its own to act on exits 4 — the execution plan naming the merge request and what it needs, the operator told it went to Address Merge Request Feedback — while a draft or an approval alone still polls (exit 2)', async () => {
  const f = await dependedOn({ draft: true, has_conflicts: true }, 1);
  const r = await awaiting(f);
  assert.equal(r.code, 4, r.err);
  assert.ok(f.notes().some(l => /MR 1 \(!7\) has needs-rebase, and another repository's merge request of this ticket waits on it: to Address Merge Request Feedback/.test(l)), f.notes().join('\n'));
  assert.match(variationOf(f)['ai-feedback-long'], /is a draft; it needs a rebase onto its target branch; it needs 1 approval\. MR 2 depends on it\. Build has sent g\/lib !7 to Address Merge Request Feedback/);
  for (const [v, left, needs] of [[{ draft: true }, 0, ['draft']], [{ draft: false }, 2, ['needs-approval']], [{ draft: true }, 1, ['draft', 'needs-approval']]]) {
    const quiet = await dependedOn(v, left);
    const q = await awaiting(quiet);
    assert.deepEqual([q.code, q.out.waiting[0].needs], [2, needs]);
    assert.doesNotMatch(variationOf(quiet)['ai-feedback-short'], /Address Merge Request Feedback/);
    assert.ok(!quiet.notes().some(l => /Address Merge Request Feedback/.test(l)));
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

// ASS-346: merge-request:check holds back a failed pipeline that only
// reflects a dependency — while any depends-on is neither Merged nor Closed
// (in any repository), and, once all have merged, while a pipeline that
// started before the latest merge runs again. Times are the forge's: GitLab's
// merged_at and head_pipeline.created_at, GitHub's mergedAt and each failed
// check's startedAt.
const BEFORE = '2026-11-10T10:00:00.000Z', MERGED_AT = '2026-11-10T11:00:00.000Z', AFTER = '2026-11-10T11:05:00.000Z';
const failedAt = (created_at, id = 50) => ({ head_pipeline: { id, status: 'failed', created_at } });
const checked = async f => JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-5', 'A')).stdout);
const reruns = f => [...f.forge.log('glab').filter(l => /\/pipelines(\/\d+\/retry)? --hostname gitlab.com -X POST$/.test(l)), ...f.forge.log('gh').filter(l => /^run rerun /.test(l))];

// lib's !7 (MR 1) and app's !9 (MR 2, depending on MR 1).
async function dependent(mr1 = {}, mr2 = {}) {
  const f = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '!9', base: 'master' } });
  view(f, 'lib', 7, mr1);
  view(f, 'app', 9, mr2);
  return f;
}

test('ASS-346 AC1/AC3: an Open MR whose pipeline failed while a dependency (another repository\'s, or its own stacked one) is neither Merged nor Closed is not build-failed — needs-attention false with nothing else, its open threads and needs-rebase still reported — and nothing is re-run', async () => {
  const f = await dependent({}, failedAt(BEFORE));
  assert.deepEqual(await checked(f), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false, 'build-pending': [{ id: 2, key: '!9', why: 'dependency-unmerged' }] });
  // Threads and a rebase on the waiting one are still reasons; only the pipeline failure is held back.
  view(f, 'app', 9, { ...failedAt(BEFORE), blocking_discussions_resolved: false, has_conflicts: true });
  assert.deepEqual(await checked(f), { 'needs-attention': true, reasons: ['open-threads', 'needs-rebase'], 'auto-merge': false, merged: false, 'build-pending': [{ id: 2, key: '!9', why: 'dependency-unmerged' }] });
  // Not yet created counts as unmerged too.
  const n = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  n.record({ 2: { status: 'Open', key: '!9', base: 'master' } });
  view(n, 'app', 9, failedAt(BEFORE));
  assert.equal((await checked(n))['needs-attention'], false);
  // The same repository: !8 stacked on !7's branch.
  const g = await planned([{ id: 1, repository: APP }, { id: 2, repository: APP, 'depends-on': [1] }]);
  g.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '!8', base: 'change/ABC-5-1' } });
  view(g, 'app', 7, {});
  view(g, 'app', 8, { target_branch: 'change/ABC-5-1', ...failedAt(BEFORE) });
  assert.deepEqual(await checked(g), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false, 'build-pending': [{ id: 2, key: '!8', why: 'dependency-unmerged' }] });
  // The dependency's own failure is still build-failed: it waits on nothing.
  view(f, 'lib', 7, failedAt(BEFORE));
  assert.deepEqual((await checked(f)).reasons, ['open-threads', 'build-failed', 'needs-rebase']);
  assert.deepEqual([...reruns(f), ...reruns(g), ...reruns(n)], []);
});

test('ASS-346 AC2: a failed pipeline with no depends-on, a Closed dependency, or one that started after its dependency merged is build-failed, and nothing is re-run', async () => {
  const f = await planned([{ id: 1, repository: APP }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' } });
  view(f, 'app', 7, failedAt(BEFORE));
  assert.deepEqual(await checked(f), { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': false, merged: false });
  const closed = await dependent({ state: 'closed' }, failedAt(BEFORE));
  assert.deepEqual((await checked(closed)).reasons, ['build-failed']);
  const after = await dependent({ state: 'merged', merged_at: MERGED_AT }, failedAt(AFTER));
  assert.deepEqual(await checked(after), { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': false, merged: false });
  assert.deepEqual([...reruns(f), ...reruns(closed), ...reruns(after)], []);
});

test('ASS-346 AC4: on GitLab, once the dependency merged, a pipeline that failed before the merge is started again (a new merge request pipeline) and pending, not build-failed; once per merge — failing again after it is build-failed, with no second re-run', async () => {
  const f = await dependent({ state: 'merged', merged_at: MERGED_AT }, failedAt(BEFORE));
  const POST = 'api projects/g%2Fapp/merge_requests/9/pipelines --hostname gitlab.com -X POST';
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/9\/pipelines --hostname gitlab.com -X POST$/, { out: { id: 51, status: 'created' } });
  assert.deepEqual(await checked(f), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false, 'build-pending': [{ id: 2, key: '!9', why: 're-run' }] });
  assert.deepEqual(reruns(f), [POST]);
  assert.equal(f.mrs()[1]['pipeline-rerun'], Date.parse(MERGED_AT) / 1000);
  // Running: nothing to report, nothing started.
  view(f, 'app', 9, { head_pipeline: { id: 51, status: 'running', created_at: AFTER } });
  assert.deepEqual(await checked(f), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  // Failed again: a real failure.
  view(f, 'app', 9, failedAt(AFTER, 51));
  assert.deepEqual(await checked(f), { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': false, merged: false });
  // The forge still showing the old pipeline: re-run already for this merge, so build-failed.
  view(f, 'app', 9, failedAt(BEFORE));
  assert.deepEqual((await checked(f)).reasons, ['build-failed']);
  assert.deepEqual(reruns(f), [POST]);
  // A project with no merge request pipelines refuses a new one: the head pipeline's failed jobs are retried instead.
  const g = await dependent({ state: 'merged', merged_at: MERGED_AT }, failedAt(BEFORE));
  g.forge.route('glab', /merge_requests\/9\/pipelines --hostname gitlab.com -X POST$/, { out: { message: 'No pipeline created' }, exit: 1 });
  g.forge.route('glab', /^api projects\/g%2Fapp\/pipelines\/50\/retry --hostname gitlab.com -X POST$/, { out: { id: 50, status: 'running' } });
  assert.deepEqual((await checked(g))['build-pending'], [{ id: 2, key: '!9', why: 're-run' }]);
  assert.deepEqual(reruns(g), [POST, 'api projects/g%2Fapp/pipelines/50/retry --hostname gitlab.com -X POST']);
  // Neither could be started: build-failed, saying why, and nothing recorded.
  const h = await dependent({ state: 'merged', merged_at: MERGED_AT }, failedAt(BEFORE));
  h.forge.route('glab', /\/pipelines(\/50\/retry)? --hostname gitlab.com -X POST$/, { out: { message: 'Forbidden' }, exit: 1 });
  const { stdout, stderr } = await h.agent('merge-request:check', 'p', 'ABC-5', 'A');
  assert.deepEqual(JSON.parse(stdout), { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': false, merged: false });
  assert.match(stderr, /could not start MR 2 \(!9\)'s failed pipeline again/);
  assert.equal(h.mrs()[1]['pipeline-rerun'], undefined);
});

test('ASS-346 AC4: on GitHub, once the dependency merged, the failed workflow runs that started before the merge are re-run (gh run rerun --failed), once; a failed check that is no workflow run cannot be, and is build-failed', async () => {
  const f = await planned([{ id: 1, repository: LIB }, { id: 2, repository: HUB, 'depends-on': [1] }]);
  f.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '#12', base: 'main' } });
  view(f, 'lib', 7, {});
  const check = (conclusion, startedAt, run) => ({ __typename: 'CheckRun', name: `job-${run}`, status: 'COMPLETED', conclusion, startedAt, detailsUrl: `https://github.com/o/h/actions/runs/${run}/job/${run}1` });
  prView(f, 12, { statusCheckRollup: [check('FAILURE', '2026-11-10T09:58:00Z', 77), check('FAILURE', '2026-11-10T10:00:00Z', 78), check('FAILURE', '2026-11-10T09:59:00Z', 77), check('SUCCESS', '2026-11-10T10:00:00Z', 79)] });
  // MR 1 not merged: held back, as on GitLab.
  assert.deepEqual((await checked(f))['build-pending'], [{ id: 2, key: '#12', why: 'dependency-unmerged' }]);
  assert.ok(f.forge.log('gh').some(l => /^pr view 12 --repo o\/h --json .*,mergedAt$/.test(l)), f.forge.log('gh').join('\n'));
  view(f, 'lib', 7, { state: 'merged', merged_at: MERGED_AT });
  f.forge.route('gh', /^run rerun \d+ --failed --repo o\/h$/);
  assert.deepEqual(await checked(f), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false, 'build-pending': [{ id: 2, key: '#12', why: 're-run' }] });
  assert.deepEqual(reruns(f), ['run rerun 77 --failed --repo o/h', 'run rerun 78 --failed --repo o/h']);
  // Re-run, one fails again after the merge: build-failed, not re-run again.
  prView(f, 12, { statusCheckRollup: [check('FAILURE', '2026-11-10T11:06:00Z', 80)] });
  assert.deepEqual((await checked(f)).reasons, ['build-failed']);
  assert.equal(reruns(f).length, 2);
  // A failed status from another CI (no workflow run): it cannot be re-run here, so build-failed.
  const g = await planned([{ id: 1, repository: LIB }, { id: 2, repository: HUB, 'depends-on': [1] }]);
  g.record({ 1: { status: 'Open', key: '!7', base: 'master' }, 2: { status: 'Open', key: '#12', base: 'main' } });
  view(g, 'lib', 7, { state: 'merged', merged_at: MERGED_AT });
  prView(g, 12, { statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/external', state: 'ERROR', startedAt: '2026-11-10T10:00:00Z', targetUrl: 'https://ci.example.com/1' }] });
  assert.deepEqual((await checked(g)).reasons, ['build-failed']);
  assert.deepEqual(reruns(g), []);
});

// ASS-351: Team Code Review waits for approvals without bouncing through
// Ensure Auto-Merge. auto-merge is true when every merge request not Closed is
// Merged, set to auto-merge, or Open and waiting on a dependency not yet
// merged (MR_DEPS unmerged_deps): Ensure Auto-Merge has nothing to set now. An
// Open one set to auto-merge with nothing of its own to act on records when it
// started waiting (approval-wait-since); past harness.json's
// approval-wait-days (3 by default), the check says so, naming them.
const daysAgo = days => new Date(Date.now() - days * 86400e3).toISOString();
const withHarness = (f, harness) => {
  const file = join(f.dir, 'harness.json');
  writeFileSync(file, JSON.stringify(harness));
  return async () => JSON.parse((await run(AGENT, ['merge-request:check', 'p', 'ABC-5', 'A'], { env: { ...process.env, PROJECTS_DIR: f.dir, PATH: f.forge.path, HARNESS_FILE: file } })).stdout);
};
const WAITING = { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: false };

test('ASS-351 AC1: auto-merge is true while every Open MR is set to auto-merge or waits on a dependency not yet merged — so Ensure Auto-Merge is not asked again — and false while one could be set and is not', async () => {
  const f = await example();
  const check = async () => JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-5', 'A')).stdout);
  // Nothing set yet: !7 and !9 could be.
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  // !7 and !9 set; !8 waits on !7, unmerged: nothing for Ensure Auto-Merge to do.
  view(f, 'app', 7, { merge_when_pipeline_succeeds: true });
  view(f, 'lib', 9, { merge_when_pipeline_succeeds: true });
  assert.deepEqual(await check(), WAITING);
  // Each set one records when it started waiting; the dependent one, waiting on another, does not.
  const since = f.mrs().map(m => m['approval-wait-since'] ?? null);
  assert.ok(since[0] && since[2] && since[1] === null, JSON.stringify(f.mrs()));
  assert.deepEqual(await check(), WAITING);
  assert.deepEqual(f.mrs().map(m => m['approval-wait-since'] ?? null), since, 'kept, not moved on, by a later poll');
  // !9 not set (its auto-merge cancelled), waiting on nothing: Ensure Auto-Merge has work again.
  view(f, 'lib', 9, {});
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  assert.equal(f.mrs()[2]['approval-wait-since'], null, 'cleared once it is not waiting');
  // A dependency recorded but not yet created leaves its dependent waiting, but is no auto-merge itself.
  const n = await planned([{ id: 1, repository: LIB }, { id: 2, repository: APP, 'depends-on': [1] }]);
  n.record({ 2: { status: 'Open', key: '!9', base: 'master' } });
  view(n, 'app', 9, {});
  assert.equal(JSON.parse((await n.agent('merge-request:check', 'p', 'ABC-5', 'A')).stdout)['auto-merge'], false);
});

test('ASS-351 AC2: once the dependency merges, the MR waiting on it and not yet set makes auto-merge false — Ensure Auto-Merge sets it, once — and waiting resumes', async () => {
  const f = await example();
  const check = async () => JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-5', 'A')).stdout);
  view(f, 'app', 7, { merge_when_pipeline_succeeds: true });
  view(f, 'lib', 9, { merge_when_pipeline_succeeds: true });
  assert.deepEqual(await check(), WAITING);
  view(f, 'app', 7, { state: 'merged' });
  f.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/8 --hostname gitlab.com -X PUT -f target_branch=master$/, { out: {}, touch: 'retargeted' });
  view(f, 'app', 8, { target_branch: 'master' }, { when: 'retargeted' });
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  await f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-5', 'A');
  assert.deepEqual(autoMerged(f), [8]);                          // !9 set already, not set again
  view(f, 'app', 8, { target_branch: 'master', merge_when_pipeline_succeeds: true }, { when: 'retargeted' });
  assert.deepEqual(await check(), WAITING);
  assert.ok(f.mrs()[1]['approval-wait-since'], 'its own wait starts now');
});

test('ASS-351 AC3: a real problem on a waiting MR — open threads, a failed pipeline not waiting on a dependency, a needed rebase — still needs attention, and a set MR with one stops its approval wait', async () => {
  const f = await example();
  const check = async () => JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-5', 'A')).stdout);
  view(f, 'app', 7, { merge_when_pipeline_succeeds: true });
  view(f, 'lib', 9, { merge_when_pipeline_succeeds: true });
  await check();
  view(f, 'app', 8, { target_branch: 'change/ABC-5-1', blocking_discussions_resolved: false });
  assert.deepEqual(await check(), { 'needs-attention': true, reasons: ['open-threads'], 'auto-merge': true, merged: false });
  view(f, 'app', 8, { target_branch: 'change/ABC-5-1', has_conflicts: true });
  assert.deepEqual((await check()).reasons, ['needs-rebase']);
  view(f, 'app', 8, { target_branch: 'change/ABC-5-1' });
  view(f, 'lib', 9, { merge_when_pipeline_succeeds: true, head_pipeline: { status: 'failed' } });
  assert.deepEqual(await check(), { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': true, merged: false });
  assert.equal(f.mrs()[2]['approval-wait-since'], null);
  assert.ok(f.mrs()[0]['approval-wait-since']);
});

test('ASS-351 AC4: an MR set to auto-merge that has waited past approval-wait-days (3 by default, from harness.json) makes the check say approval-wait-expired, naming those still needing approval, with feedback for Blocked for Human', async () => {
  const f = await example();
  view(f, 'app', 7, { merge_when_pipeline_succeeds: true });
  view(f, 'lib', 9, { merge_when_pipeline_succeeds: true });
  f.record({ 1: { url: `${APP}/-/merge_requests/7`, 'approval-wait-since': daysAgo(4) }, 3: { url: `${LIB}/-/merge_requests/9`, 'approval-wait-since': daysAgo(1) } });
  const check = withHarness(f, {});
  const out = await check();
  assert.equal(out['approval-wait-expired'], true);
  assert.deepEqual(out['awaiting-approval'], [{ id: 1, key: '!7', url: `${APP}/-/merge_requests/7`, since: f.mrs()[0]['approval-wait-since'] }]);
  assert.equal(out['ai-feedback-short'], 'Waited over 3 days for approval: MR 1 (!7)');
  assert.match(out['ai-feedback-long'], /MR 1 \(!7\) https:\/\/gitlab.com\/g\/app\/-\/merge_requests\/7, waiting since /);
  assert.match(out['ai-feedback-long'], /Waiting for those before them to merge: MR 2 \(!8\)\./);
  assert.match(out['ai-feedback-long'], /choose Resolved/);
  // Both past the bound: both named.
  f.record({ 3: { 'approval-wait-since': daysAgo(3.5) } });
  assert.deepEqual((await check())['awaiting-approval'].map(m => m.key), ['!7', '!9']);
  // A longer bound from harness.json: still waiting.
  assert.deepEqual(await withHarness(f, { 'approval-wait-days': 5 })(), WAITING);
  // A bad one: the default, said on stderr.
  const bad = await run(AGENT, ['merge-request:check', 'p', 'ABC-5', 'A'], { env: { ...process.env, PROJECTS_DIR: f.dir, PATH: f.forge.path, HARNESS_FILE: (writeFileSync(join(f.dir, 'bad.json'), '{"approval-wait-days": "soon"}'), join(f.dir, 'bad.json')) } });
  assert.equal(JSON.parse(bad.stdout)['approval-wait-expired'], true);
  assert.match(bad.stderr, /approval-wait-days must be a positive number of days; 3 used/);
  // The variation entered its step (a Release resumed from Blocked for Human) a day ago: the wait counts from then.
  const sprint = JSON.parse(readFileSync(f.file, 'utf8'));
  sprint.features[0].variations[0]['state-changes'] = [
    { 'from-state': 'blocked-for-human', 'to-state': 'release', timestamp: daysAgo(1).replace(/\.\d+Z$/, 'Z') },
    { 'from-state': 'release', 'to-state': 'release', 'sub-state-change': { 'from-state': 'take-out-of-draft-mode', 'to-state': 'team-code-review' }, timestamp: daysAgo(0.9) },
  ];
  writeFileSync(f.file, JSON.stringify(sprint, null, 4));
  assert.deepEqual(await check(), WAITING);
  // Something to act on: no expiry, whatever the wait.
  sprint.features[0].variations[0]['state-changes'] = [];
  writeFileSync(f.file, JSON.stringify(sprint, null, 4));
  view(f, 'app', 8, { target_branch: 'change/ABC-5-1', blocking_discussions_resolved: false });
  const attention = await check();
  assert.equal(attention['needs-attention'], true);
  assert.equal(attention['approval-wait-expired'], undefined);
});
