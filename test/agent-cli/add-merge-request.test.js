// ASS-424 — a build step (Generate Solution, Address Merge Request Feedback,
// Generate Automated Tests) that needs a change in a repository where the
// ticket has no Open merge request plans a new one (ticket:add-merge-request,
// through ASS-423's plan_new_merge_request) instead of asking the operator;
// control takes it like one from Write Execution Plan. The engine side:
// test/control/tick-merge-awaited.test.js; the prompts:
// test/workflow/prompts.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeForge } from '../support/fake-forge.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const APP = 'https://gitlab.com/g/app', LIB = 'https://gitlab.com/g/lib';

// Project p (repositories app and lib) with ABC-5's variations A and B, A's merge requests as given (rows as recorded).
function ticket(rows, { variation = 'A' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  mkdirSync(join(dir, 'p', 'work', 'ABC-5'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ repositories: [{ url: APP }, { url: LIB }] }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  const file = join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(file, JSON.stringify({
    number: 10, bugs: [], spikes: [],
    features: [{ key: 'ABC-5', title: 'Close the account', variations: [{ name: variation, 'merge-request': rows }] }],
  }, null, 4));
  writeFileSync(join(dir, 'p', 'work', 'ABC-5', `execution-plan-${variation}.md`), '# Plan\n');
  const forge = fakeForge();
  for (const repo of ['app', 'lib']) forge.route('glab', new RegExp(`^api projects/g%2F${repo} --hostname gitlab.com$`), { out: { default_branch: 'master' } });
  const env = { ...process.env, PROJECTS_DIR: dir, PATH: forge.path };
  const mrs = () => JSON.parse(readFileSync(file, 'utf8')).features[0].variations[0]['merge-request'];
  const plan = () => readFileSync(join(dir, 'p', 'work', 'ABC-5', `execution-plan-${variation}.md`), 'utf8');
  // ticket:add-merge-request with <input> on stdin: { code, out, err }.
  const add = input => new Promise(resolve => {
    const child = spawn(AGENT, ['ticket:add-merge-request', 'p', 'abc-5', variation, '-'], { env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out: out.trim() ? JSON.parse(out) : null, err }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
  const agent = async (...args) => {
    try { const { stdout, stderr } = await run(AGENT, args, { env }); return { code: 0, out: JSON.parse(stdout), err: stderr }; }
    catch (e) { return { code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null, err: e.stderr }; }
  };
  return { dir, forge, mrs, plan, add, agent, file };
}
const row = (id, repository, status, v = {}) => ({ id, repository, branch: `change/ABC-5-${id}`, contents: `mr ${id}`, 'depends-on': [], status, key: null, url: null, 'build-status': null, ...v });
const mr = (iid, v = {}) => ({ iid, state: 'opened', draft: false, title: 'ABC-5: Close the account', target_branch: 'master', has_conflicts: false, detailed_merge_status: 'mergeable', blocking_discussions_resolved: true, merge_when_pipeline_succeeds: false, head_pipeline: { status: 'success' }, web_url: `${APP}/-/merge_requests/${iid}`, ...v });
const view = (f, repo, iid, v) => f.forge.route('glab', new RegExp(`^api projects/g%2F${repo}/merge_requests/${iid} --hostname gitlab.com$`), { out: mr(iid, v) });

// ABC-1771's shape: lib's MR 1 merged (from main), app's MR 2 Open; MR 4 planned once and Closed, so the next id is 5.
const merged = () => ticket([
  row(1, LIB, 'Merged', { key: '!825', url: `${LIB}/-/merge_requests/825`, base: 'main' }),
  row(2, APP, 'Open', { key: '!9', url: `${APP}/-/merge_requests/9`, base: 'master', 'depends-on': [1] }),
  row(4, LIB, 'Closed', { base: 'main' }),
]);
const FINDING = { repository: LIB, contents: 'Give each batch invitation event its own event_id', step: 'Generate Solution', why: 'code-review-A finding 1: same-millisecond EXAMPLE_USER_INVITED events share an event_id', 'needed-by': [2] };

test('ASS-424 AC1/AC2/AC6: with every lib merge request Merged or Closed, a build step plans one new one — the next id never used, its branch named, from the last merged one\'s base — and the plan records which step added it and why', async () => {
  const f = merged();
  const added = await f.add(FINDING);
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(added.out, { planned: true, id: 5, repository: LIB, branch: 'change/ABC-5-5', base: 'main', 'needed-by': [2] });
  const [, two, , five] = f.mrs();
  assert.equal(f.mrs().length, 4);
  assert.deepEqual({ ...five, 'planned-by': { ...five['planned-by'], at: 'at' } }, {
    id: 5, repository: LIB, branch: 'change/ABC-5-5', contents: FINDING.contents, 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null, base: 'main',
    'planned-by': { step: 'Generate Solution', why: FINDING.why, at: 'at' },
  });
  assert.match(five['planned-by'].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // The Open MR that needs it now depends on it, so Await Sequential Merge waits for it to merge.
  assert.deepEqual(two['depends-on'], [1, 5]);
  const plan = f.plan();
  assert.match(plan, /\n## Merge request 5 added \(\S+, Generate Solution, variation A\)\n/);
  assert.match(plan, /Generate Solution planned MR 5 on https:\/\/gitlab\.com\/g\/lib, branch change\/ABC-5-5, from origin\/main: the ticket has no Open merge request there/);
  assert.match(plan, /Why: code-review-A finding 1: same-millisecond EXAMPLE_USER_INVITED events share an event_id/);
  assert.match(plan, /Needed by: MR 2, which now depends on it: it merges first\./);
  // A merged one is never touched: MR 1 keeps its row.
  assert.deepEqual(f.mrs()[0], row(1, LIB, 'Merged', { key: '!825', url: `${LIB}/-/merge_requests/825`, base: 'main' }));
  // A later replan by Write Execution Plan keeps planned-by.
  writeFileSync(join(f.dir, 'replan.json'), JSON.stringify([{ id: 5, repository: LIB, contents: 'revised', 'depends-on': [] }]));
  await run(AGENT, ['ticket:set-merge-request-plan', 'p', 'ABC-5', 'A', join(f.dir, 'replan.json')], { env: { ...process.env, PROJECTS_DIR: f.dir } });
  assert.equal(f.mrs()[3]['planned-by'].step, 'Generate Solution');
});

test('ASS-424 AC1: a variation other than A names its branch with the variation; with nothing planned in that repository, ids still go on from the highest; the repository taken as project.json names it; needed-by is optional and a Merged one is never made to depend', async () => {
  const f = ticket([row(1, APP, 'Merged', { key: '!3', base: 'master' }), row(2, APP, 'Open', { key: '!4', base: 'master' })], { variation: 'B' });
  const added = await f.add({ repository: `${LIB}.git`, contents: 'a test fixture', step: 'Generate Automated Tests', why: 'test plan item 3 needs a lib fixture', 'needed-by': [1] });
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(added.out, { planned: true, id: 3, repository: LIB, branch: 'change/ABC-5.B-3', base: null, 'needed-by': [] });
  assert.deepEqual(f.mrs().map(m => [m.id, m['depends-on']]), [[1, []], [2, []], [3, []]]);
  assert.doesNotMatch(f.plan(), /Needed by/);
});

test('ASS-424 AC3/AC6: with a merge request in that repository Open or still Not Created, it plans none — exit 3, naming the one the change goes on', async () => {
  for (const status of ['Open', 'Not Created']) {
    const f = ticket([row(1, LIB, 'Merged', { key: '!1' }), row(2, LIB, status, status === 'Open' ? { key: '!2', url: `${LIB}/-/merge_requests/2` } : {})]);
    const before = readFileSync(f.file, 'utf8');
    const refused = await f.add({ ...FINDING, repository: `${LIB}/`, 'needed-by': [] });
    assert.equal(refused.code, 3, refused.err);
    assert.deepEqual(refused.out, { planned: false, existing: { id: 2, branch: 'change/ABC-5-2', status, key: status === 'Open' ? '!2' : null, url: status === 'Open' ? `${LIB}/-/merge_requests/2` : null } });
    assert.match(refused.err, /already has MR 2 \(.+\) in .+: make the change on its branch change\/ABC-5-2/);
    assert.equal(readFileSync(f.file, 'utf8'), before, status);
    assert.equal(f.plan(), '# Plan\n');
  }
});

test('ASS-424: bad input, a repository not the project\'s, or a needed-by not planned plans nothing (exit 1)', async () => {
  const f = merged();
  const before = readFileSync(f.file, 'utf8');
  for (const [input, message] of [
    ['not json', /stdin must hold/],
    [{ ...FINDING, why: ' ' }, /stdin must hold/],
    [{ ...FINDING, step: undefined }, /stdin must hold/],
    [{ ...FINDING, 'needed-by': ['2'] }, /stdin must hold/],
    [{ ...FINDING, repository: 'https://gitlab.com/g/other' }, /not one of p's repositories/],
    [{ ...FINDING, 'needed-by': [9] }, /needed-by names MR 9, which ABC-5 A has not planned/],
  ]) {
    const refused = await f.add(input);
    assert.equal(refused.code, 1, JSON.stringify(input));
    assert.match(refused.err, message);
  }
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.plan(), '# Plan\n');
});

test('ASS-424 AC5: control does not let a merge request planned mid-build go unbuilt — Await Sequential Merge sends the ticket back to Generate Solution (exit 3) with nothing depending on it, asking no forge; once created it waits as any other', async () => {
  const f = ticket([row(1, LIB, 'Merged', { key: '!1', base: 'master' }), row(2, APP, 'Open', { key: '!9', base: 'master' })]);
  assert.deepEqual((await f.add({ ...FINDING, 'needed-by': [] })).out.id, 3);
  const unbuilt = await f.agent('merge-request:await-dependencies', 'p', 'ABC-5', 'A');
  assert.equal(unbuilt.code, 3, unbuilt.err);
  assert.deepEqual(unbuilt.out.waiting, []);
  assert.deepEqual(unbuilt.out['not-created'].map(m => [m.id, m['planned-by'].step]), [[3, 'Generate Solution']]);
  assert.deepEqual(f.forge.log('glab'), []);
  assert.match(f.plan(), /control, variation A: MR 3 \(g\/lib\) planned mid-build and never created: back to Generate Solution/);
  const v = JSON.parse(readFileSync(f.file, 'utf8')).features[0].variations[0];
  assert.equal(v['ai-feedback-short'], 'Never created: MR 3 (g/lib); back to Generate Solution');
  assert.match(v['ai-feedback-long'], /^MR 3 was planned mid-build by Generate Solution \(code-review-A finding 1: .+\) and never created\. The ticket goes back to Generate Solution to build it\.$/);
  // An ASS-354 leftover (no planned-by) is still not sent back: created, MR 3 is like any other.
  const sprint = JSON.parse(readFileSync(f.file, 'utf8'));
  Object.assign(sprint.features[0].variations[0]['merge-request'][2], { status: 'Open', key: '!11', url: `${LIB}/-/merge_requests/11` });
  writeFileSync(f.file, JSON.stringify(sprint));
  const passes = await f.agent('merge-request:await-dependencies', 'p', 'ABC-5', 'A');
  assert.deepEqual([passes.code, passes.out], [0, { waiting: [] }]);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).features[0].variations[0]['ai-feedback-short'], null);
});

test('ASS-424 AC5: merge-request:check counts a merge request planned mid-build and not yet created as not-created and the group not merged, so Release cannot finish without it; an ASS-354 leftover still counts for nothing', async () => {
  const f = ticket([row(1, LIB, 'Merged', { key: '!1', base: 'master' }), row(2, APP, 'Merged', { key: '!9', base: 'master' }), row(3, APP, 'Not Created')]);
  view(f, 'lib', 1, { state: 'merged', web_url: `${LIB}/-/merge_requests/1` });
  view(f, 'app', 9, { state: 'merged' });
  const check = async () => (await f.agent('merge-request:check', 'p', 'ABC-5', 'A')).out;
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: true });
  // Generate Solution in Release's place would plan lib's next: MR 4 (3 never created, app's, is no Open one in lib).
  assert.equal((await f.add({ ...FINDING, 'needed-by': [] })).out.id, 4);
  assert.deepEqual(await check(), { 'needs-attention': true, reasons: ['not-created'], 'auto-merge': true, merged: false, 'not-created': [4], 'needs-build': true });
  // The merge loop's set (--only) reports it only when it is in the set.
  assert.deepEqual((await f.agent('merge-request:check', 'p', 'ABC-5', 'A', '--only', '1')).out, { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: true });
});

// ASS-428 AC1: a path in place of "-", as ticket:set-merge-request-plan takes one: a confined host agent (Blocked)
// stages the JSON in temp and passes its path, the call a bare one. The forwarder still requires "-" of a VM.
test('ASS-428 AC1: ticket:add-merge-request <project> <ticket> <variation> <file> plans from the file, nothing on stdin; a missing file or bad content plans nothing', async () => {
  const f = merged();
  const staged = join(f.dir, 'mr.json');
  writeFileSync(staged, JSON.stringify(FINDING));
  const added = await f.agent('ticket:add-merge-request', 'p', 'ABC-5', 'A', staged);
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(added.out, { planned: true, id: 5, repository: LIB, branch: 'change/ABC-5-5', base: 'main', 'needed-by': [2] });
  assert.equal(f.mrs()[3]['planned-by'].why, FINDING.why);
  const before = readFileSync(f.file, 'utf8');
  const missing = await f.agent('ticket:add-merge-request', 'p', 'ABC-5', 'A', '/no/such/mr.json');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /ticket:add-merge-request: no file \/no\/such\/mr\.json: nothing planned/);
  writeFileSync(staged, 'not json');
  const bad = await f.agent('ticket:add-merge-request', 'p', 'ABC-5', 'A', staged);
  assert.equal(bad.code, 1);
  assert.ok(bad.err.includes(`${staged} must hold { repository`), bad.err);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
