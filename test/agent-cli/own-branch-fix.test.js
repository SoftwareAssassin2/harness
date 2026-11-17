// ASS-384: ticket:own-branch-fix — a failure grouped-blocked put in the
// project's code that the latest master does not show, and that is in a file
// the ticket's own branch adds or changes, is the agents' to fix: its finding
// (summary, root cause, failing check, file:line, evidence, master evidence)
// is appended to the variation's execution plan, which Generate Solution
// reads, and the run is told to resume at Generate Solution's group. Not
// shown (Classify not saying so, nothing named, no VM, a file the branch does
// not change) is exit 3, nothing written. limactl is test/support/fake-limactl.js;
// the VM's root a folder holding real git checkouts (vm-fixture.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { lima, git, edit } from './vm-fixture.js';
import { run, AGENT } from './harness-fixture.js';
import { fakeForge } from '../support/fake-forge.js';

const RUN = '55555555-5555-4555-8555-555555555555';
const FOUND = {
  'needs-fix': true, summary: 'events migration V27 collides with master\'s V27', 'root-cause': 'the branch picked V27 before master merged its own V27; the immutability check needs a number above master\'s',
  evidence: ['check-migration-numbers.sh → exit 1: V27 already applied on master'],
  'failing-repository': 'https://github.com/o/harness', 'failing-job': 'migrations-validate', 'failing-assertion': 'check-migration-numbers.sh exit 1', 'failing-file': 'db/V27__events.sql:1',
  issue: 'project', reasoning: 'R', 'own-branch': true,
  'on-master': 'unknown', 'master-evidence': 'no finished main pipeline of the last 20 ran job migrations-validate',
  'ai-feedback-short': 'Not proven on master: no project bug raised', 'ai-feedback-long': 'L',
};

// ABC-3 A, its VM abc-3-a, blocked from build of p's `dev` engine (Build runs Generate Solution); its
// merge request in harness on change/ABC-3-1, base main, a commit adding db/V27__events.sql; the
// Blocked run RUN holding `output`.
function setup(output = FOUND, { vm = 'abc-3-a', mrs = null, env = null } = {}) {
  const l = lima();
  l.v.instance('abc-3-a', 'Running');
  const at = (...rest) => join(l.f.dir, ...rest);
  const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(json)); };
  const group = (id, sequence, engine) => ({ id, sequence, 'return-to-state': id, action: { type: 'state-engine', engine }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'done' }] });
  write(at('engines', 'dev', 'state-engine.json'), { steps: [
    { id: 'blocked', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'grouped-blocked' }, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }] },
    { id: 'committed', sequence: 1, action: { type: 'none' } },
    group('plan', 2, 'sub-plan'), group('build', 3, 'sub-build'), group('test', 4, 'sub-test'),
    { id: 'done', sequence: 5, 'is-done': true, action: { type: 'none' } },
  ] });
  for (const [name, prompt] of [['sub-plan', 'write-execution-plan-grouped'], ['sub-build', 'generate-solution-grouped'], ['sub-test', 'test-grouped']]) {
    write(at('engines', name, 'state-engine.json'), { steps: [
      { id: prompt.replace(/-grouped$/, ''), sequence: 1, action: { type: 'prompt', prompt } },
      { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
    ] });
  }
  edit(at('projects', 'p', 'project.json'), p => { p['execution-state-engine'] = 'dev'; });
  const c = (from, to) => ({ 'state-engine': 'dev', 'from-state': from, 'to-state': to, timestamp: '2026-11-11T19:00:00Z', 'agent-dispatch-log': [] });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0].variations[0], {
      ...(vm ? { vm: { name: vm, ip: '192.168.64.9', 'created-at': '2026-11-11T00:00:00Z' } } : {}),
      'state-changes': [c('committed', 'plan'), c('plan', 'build'), c('build', 'test'), c('test', 'blocked')],
      'merge-request': mrs ?? [{ id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', base: 'main', contents: 'c', 'depends-on': [], status: 'Open', key: null, url: null, 'build-status': null }],
    });
  });
  const a = JSON.parse(readFileSync(at('assignments.json'), 'utf8'));
  a['transient-state-engines'].push({ id: RUN, project: 'p', 'state-engine': 'grouped-blocked', state: 'own-branch-or-human', parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'dev', state: 'blocked' }, 'is-done': false, 'structured-output': output });
  writeFileSync(at('assignments.json'), JSON.stringify(a));
  const own = l.vmFile('repos', 'harness');
  git(own, 'config', 'user.email', 't@example.com'); git(own, 'config', 'user.name', 'T');
  git(own, 'checkout', '-q', '-b', 'change/ABC-3-1');
  mkdirSync(join(own, 'db'), { recursive: true });
  writeFileSync(join(own, 'db', 'V27__events.sql'), 'create table events ();\n'); git(own, 'add', '.'); git(own, 'commit', '-q', '-m', 'events');
  const plan = join(l.folder, 'execution-plan-A.md');
  return {
    ...l, own, plan,
    fix: () => (env ? run(AGENT, ['ticket:own-branch-fix', 'p', 'ABC-3', 'A', RUN], { env: env(l.env) }) : l.cli('ticket:own-branch-fix', 'p', 'ABC-3', 'A', RUN)),
    refused: () => (env ? run(AGENT, ['ticket:own-branch-fix', 'p', 'ABC-3', 'A', RUN], { env: env(l.env) }) : l.cli('ticket:own-branch-fix', 'p', 'ABC-3', 'A', RUN)).then(() => assert.fail('it passed'), e => e),
    read: () => readFileSync(plan, 'utf8'),
  };
}

test('ASS-384 AC1: a failing file the branch adds — the finding appended to the execution plan (summary, cause, failing check, file:line, evidence, master evidence), resume-at Generate Solution\'s group, the not-proven feedback cleared', async () => {
  const s = setup();
  writeFileSync(s.plan, '# Plan\n\n## Approach\nDo the thing.\n');
  const out = JSON.parse((await s.fix()).stdout);
  assert.equal(out['own-branch-fix'], true);
  assert.match(out['own-branch-why'], /^db\/V27__events\.sql is one the branch change\/ABC-3-1 in harness adds or changes/);
  assert.deepEqual([out['plan-revised'], out['resume-at'], out['resume-source']], ['execution-plan-A.md', 'build', 'declared']);
  assert.match(out['resume-why'], /own-branch fix \(ASS-384\) declares resume-at generate-solution \(in build\)/);
  assert.deepEqual([out['ai-feedback-short'], out['ai-feedback-long']], [null, null]);
  const text = s.read();
  assert.ok(text.startsWith('# Plan\n\n## Approach\nDo the thing.\n\n## Own-branch fix ('), 'the plan before it kept');
  const added = text.slice(text.indexOf('## Own-branch fix'));
  assert.match(added, /^## Own-branch fix \(\d{4}-\d\d-\d\d, Blocked, variation A, attempt 1\)\n/);
  assert.match(added, /Blocked: events migration V27 collides with master's V27\. Cause: the branch picked V27/);
  assert.match(added, /Failing check: https:\/\/github\.com\/o\/harness job migrations-validate — check-migration-numbers\.sh exit 1\. File: db\/V27__events\.sql:1\./);
  assert.match(added, /Evidence:\n- check-migration-numbers\.sh → exit 1/);
  assert.match(added, /Not on the latest master \(no finished main pipeline .*\): the failure is in this ticket's own branch change\/ABC-3-1, which adds or changes db\/V27__events\.sql — no p bug raised/);
  assert.match(added, /Step added: fix it in this ticket's own branch \(Generate Solution\)/);
  assert.ok(s.v.calls().some(c => c.vm === 'abc-3-a' && c.workdir === '/repos/harness'), 'the branch read in the VM');
});

test('ASS-384 AC2: a later attempt says which — the run\'s own-branch-fixes (ticket:fix-attempts) plus one; a file not committed yet, or new, is the branch\'s too', async () => {
  const s = setup({ ...FOUND, 'own-branch-fixes': 2, 'failing-file': '/repos/harness/db/V28__more.sql' });
  writeFileSync(join(s.own, 'db', 'V28__more.sql'), 'x\n');
  await s.fix();
  assert.match(s.read(), /^## Own-branch fix \(.*attempt 3\)/);
});

test('ASS-384 AC3/AC4: not shown to be the branch\'s — Classify not saying so, nothing named, a file the branch does not change, no VM — exit 3, nothing written', async () => {
  const cases = [
    [{ ...FOUND, 'own-branch': false }, /Classify did not put the cause in the ticket's own branch/],
    [{ ...FOUND, 'failing-file': undefined }, /named no failing repository, file and job or assertion/],
    [{ ...FOUND, 'failing-job': undefined, 'failing-assertion': undefined }, /named no failing repository, file and job or assertion/],
    [{ ...FOUND, 'failing-file': 'README.md:3' }, /README\.md is not one the branch change\/ABC-3-1 in harness adds or changes/],
  ];
  for (const [output, why] of cases) {
    const s = setup(output);
    const e = await s.refused();
    assert.equal(e.code, 3, e.stderr);
    const out = JSON.parse(e.stdout);
    assert.equal(out['own-branch-fix'], false);
    assert.match(out['own-branch-why'], why);
    assert.equal(out['ai-feedback-short'], undefined, 'check-on-master\'s feedback left as it was');
    assert.ok(!existsSync(s.plan), 'no plan written');
  }
  const none = setup(FOUND, { vm: null });
  const e = await none.refused();
  assert.equal(e.code, 3);
  assert.match(JSON.parse(e.stdout)['own-branch-why'], /has no VM/);
});

test('ASS-384: an unknown run or a bad variation fails (exit 1), writing nothing', async () => {
  const s = setup();
  const unknown = await s.cli('ticket:own-branch-fix', 'p', 'ABC-3', 'A', '66666666-6666-4666-8666-666666666666').then(() => null, e => e);
  assert.equal(unknown?.code, 1);
  const bad = await s.cli('ticket:own-branch-fix', 'p', 'ABC-3', 'Z', RUN).then(() => null, e => e);
  assert.equal(bad?.code, 1);
  assert.ok(!existsSync(s.plan));
});

// ASS-423 — the ticket's own code includes what its merged merge requests added or changed, read from their diffs on
// the forge (fake-forge.js), not from the VM's checkout, which shows nothing of them once they merged. Modelled on
// ABC-1770: QA put it On Hold after its MRs merged, over a gap in a test its own MR added.
const CORPUS = 'https://gitlab.com/g/example-corpus.git', HUB = 'https://github.com/o/harness';
const MERGED = {
  ...FOUND, summary: 'the reconciler integration test records no subscription invoice', 'root-cause': 'the test Worker sets no Subscription, so worker.go skips recording and the test passes without exercising record_stripe_subscription_invoice',
  evidence: ['postgres_integration_test.go:204 — Worker{} without Subscription'],
  'failing-repository': 'https://gitlab.com/g/example-corpus', 'failing-job': 'go-test', 'failing-assertion': 'TestReconcilerAgainstRealPlatformDatabase records evt_int_inv', 'failing-file': 'apps/billing-reconciler/postgres_integration_test.go:204',
};
const row = (id, repository, status, key, base = 'master') => ({ id, repository, branch: `change/ABC-3-${id}`, base, contents: `MR ${id}`, 'depends-on': [], status, key, url: null, 'build-status': status });
// MR 1 (harness) and MR 2, MR 3 (example-corpus) all Merged or Closed; the VM's example-corpus on master (nothing of its own: the merge base is HEAD).
const ALL_DONE = [row(1, HUB, 'Merged', '#7', 'main'), row(2, CORPUS, 'Merged', '!3951'), row(3, CORPUS, 'Closed', '!3952')];
const DIFFS = /^api projects\/g%2Fexample-corpus\/merge_requests\/3951\/diffs\?per_page=100 --hostname gitlab\.com --paginate$/;
const TEST_FILE = 'apps/billing-reconciler/postgres_integration_test.go';
const withForge = (routes, mrs = ALL_DONE, output = MERGED) => {
  const forge = fakeForge();
  for (const [tool, match, response] of routes) forge.route(tool, match, response);
  const bin = forge.path.split(':')[0];
  return { forge, s: setup(output, { mrs, env: e => ({ ...e, PATH: `${bin}:${e.PATH}` }) }) };
};
const mrsOf = s => JSON.parse(readFileSync(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8')).features[0].variations[0]['merge-request'];

test('ASS-423 AC1/AC2/AC3: every MR of the failing repository Merged or Closed, the failing file in a merged one\'s diff on the forge — the own-branch fix, one new MR planned (next id, change/ABC-3-<id> on the merged one\'s base, contents saying what to fix and why), the plan naming it and forbidding the merged branches', async () => {
  const { s, forge } = withForge([['glab', DIFFS, { out: [{ old_path: 'apps/billing-reconciler/worker.go', new_path: 'apps/billing-reconciler/worker.go' }, { old_path: TEST_FILE, new_path: TEST_FILE }] }]]);
  const out = JSON.parse((await s.fix()).stdout);
  assert.equal(out['own-branch-fix'], true);
  assert.equal(out['own-branch-source'], 'merged');
  assert.match(out['own-branch-why'], /^apps\/billing-reconciler\/postgres_integration_test\.go is one this ticket's merged MR 2 \(!3951\) in example-corpus added or changed/);
  assert.deepEqual(out['merge-request-planned'], { id: 4, repository: CORPUS, branch: 'change/ABC-3-4', base: 'master' });
  assert.deepEqual([out['resume-at'], out['ai-feedback-short']], ['build', null]);
  const mrs = mrsOf(s);
  assert.equal(mrs.length, 4, 'one new MR, the others kept');
  assert.deepEqual(mrs.slice(0, 3).map(m => m.status), ['Merged', 'Merged', 'Closed']);
  const added = mrs[3];
  assert.deepEqual([added.id, added.repository, added.branch, added.base, added.status, added.key, added['depends-on']], [4, CORPUS, 'change/ABC-3-4', 'master', 'Not Created', null, []]);
  assert.equal(added['planned-by']?.step, 'Blocked', 'marked planned-by, so control holds Build and Release until it is built (ASS-424)');
  assert.match(added['planned-by'].why, /^Blocked's own-branch fix: apps\/billing-reconciler\/postgres_integration_test\.go is this ticket's own code and its merge requests in example-corpus have merged or closed$/);
  assert.match(added['planned-by'].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(mrs.slice(0, 3).every(m => m['planned-by'] == null), 'only the new one is marked');
  assert.match(added.contents, /^Own-branch fix \(Blocked, \d{4}-\d\d-\d\d\): the reconciler integration test records no subscription invoice\. Fix apps\/billing-reconciler\/postgres_integration_test\.go:204 in https:\/\/gitlab\.com\/g\/example-corpus \(job go-test\) — TestReconcilerAgainstRealPlatformDatabase records evt_int_inv: the test Worker sets no Subscription/);
  assert.match(added.contents, /its merge requests there \(MR 2 \(!3951\), MR 3 \(!3952\)\) have merged or closed, so the fix goes in this new one, from the latest origin\/master/);
  const text = s.read();
  assert.match(text, /the failure is in this ticket's own code: apps\/billing-reconciler\/postgres_integration_test\.go, which its merged MR 2 \(!3951\) in example-corpus added or changed/);
  assert.match(text, /Step added: fix it in a new merge request, MR 4 \(example-corpus, branch change\/ABC-3-4, from the latest origin\/master\), planned for this fix \(Generate Solution builds and opens it\)\. This ticket's merge requests in example-corpus \(MR 2 \(!3951\), MR 3 \(!3952\)\) are merged or closed: do not reopen them or push to their branches\./);
  assert.ok(!forge.log('glab').some(l => /3952/.test(l)), 'a closed one\'s diff is not read: it never landed');
  assert.equal(forge.log('glab').filter(l => / -X /.test(l)).length, 0, 'nothing written on the forge');
});

test('ASS-423 AC1: a merged pull request on GitHub, its files read with --paginate; GitLab\'s older …/changes when …/diffs is refused', async () => {
  const hub = withForge([['gh', /^api repos\/o\/harness\/pulls\/7\/files\?per_page=100 --paginate$/, { out: [{ filename: 'db/V28__other.sql' }, { filename: 'db/V27__events.sql', previous_filename: 'db/V26__events.sql' }] }]],
    [row(1, HUB, 'Merged', '#7', 'main')], { ...FOUND, 'failing-file': 'db/V26__events.sql' });
  const out = JSON.parse((await hub.s.fix()).stdout);
  assert.equal(out['own-branch-source'], 'merged', 'a rename\'s old name counts');
  assert.deepEqual(out['merge-request-planned'], { id: 2, repository: HUB, branch: 'change/ABC-3-2', base: 'main' }, 'its one MR merged: a new one');
  const changes = withForge([['glab', DIFFS, { exit: 1 }], ['glab', /^api projects\/g%2Fexample-corpus\/merge_requests\/3951\/changes --hostname gitlab\.com$/, { out: { changes: [{ old_path: 'x', new_path: TEST_FILE }] } }]]);
  assert.equal(JSON.parse((await changes.s.fix()).stdout)['own-branch-source'], 'merged');
});

test('ASS-423 AC2: an open MR of the ticket for the failing repository — the fix goes on it, as before: nothing planned', async () => {
  const { s } = withForge([['glab', DIFFS, { out: [{ old_path: TEST_FILE, new_path: TEST_FILE }] }]], [...ALL_DONE, row(4, CORPUS, 'Open', '!4000')]);
  const out = JSON.parse((await s.fix()).stdout);
  assert.deepEqual([out['own-branch-fix'], out['own-branch-source'], out['merge-request-planned']], [true, 'merged', null]);
  assert.equal(mrsOf(s).length, 4);
  assert.match(s.read(), /Step added: fix it in this ticket's own branch \(Generate Solution\)/);
});

test('ASS-423 AC7: a file in no MR of the ticket (nor its branch), or a merged MR the forge will not show — not its own code: exit 3, nothing planned or written', async () => {
  const none = withForge([['glab', DIFFS, { out: [{ old_path: 'apps/other.go', new_path: 'apps/other.go' }] }]]);
  let e = await none.s.refused();
  assert.equal(e.code, 3, e.stderr);
  assert.match(JSON.parse(e.stdout)['own-branch-why'], /apps\/billing-reconciler\/postgres_integration_test\.go is not one the branch master in example-corpus adds or changes; none of its merged merge requests in example-corpus adds or changes it/);
  assert.equal(mrsOf(none.s).length, 3);
  assert.ok(!existsSync(none.s.plan));
  const unread = withForge([['glab', DIFFS, { exit: 1 }], ['glab', /\/changes /, { exit: 1 }]]);
  e = await unread.s.refused();
  assert.equal(e.code, 3);
  assert.match(JSON.parse(e.stdout)['own-branch-why'], /its merged MR 2 \(!3951\) in example-corpus could not be read from the forge/);
  assert.equal(mrsOf(unread.s).length, 3);
});

// ASS-492 — nothing failed, but the ticket's own work is incomplete: Classify own-branch true and a missing change in
// one of the project's repositories, no failing file. Modelled on ABC-2870: both merge requests merged, the app's bump
// of the library the first one published never planned. No VM or forge is read.
const MISSING = {
  'needs-fix': true, summary: 'the indicator never reaches users: the app pins the library to preview.83', 'root-cause': 'the ticket\'s work is incomplete: it needs a bump of @scope/* to preview.85 in the app',
  evidence: ['a jira comment: !90 published as preview.85; the app pins preview.83'],
  issue: 'project', reasoning: 'own work incomplete: no step failed; the fix is a new MR in example-corpus planned by Generate Solution', 'own-branch': true,
  'missing-change': 'bump @scope/* to 1.0.0-preview.85 in package.json and the lockfile', 'missing-change-repository': 'https://gitlab.com/g/example-corpus',
  'on-master': 'unknown', 'master-evidence': 'Troubleshoot named no failing repository and CI job to check',
  'ai-feedback-short': 'Not proven on master: Troubleshoot named no failing check', 'ai-feedback-long': 'L',
};
const ABC_2870 = [row(1, HUB, 'Merged', '#90', 'main'), row(2, CORPUS, 'Merged', '!4207')];

test('ASS-492 AC1/AC5: own work incomplete, every MR in the repository merged — a new Not Created MR planned there (planned-by Blocked, its why Classify\'s), the finding appended to the plan, resume-at Generate Solution\'s group, the not-proven feedback cleared', async () => {
  const s = setup(MISSING, { mrs: ABC_2870, vm: null });
  writeFileSync(s.plan, '# Plan\n');
  const out = JSON.parse((await s.fix()).stdout);
  assert.deepEqual([out['own-branch-fix'], out['own-branch-source'], out['merge-request-existing']], [true, 'missing-change', null]);
  assert.match(out['own-branch-why'], /^Classify put a missing change in example-corpus in this ticket's own work: bump @scope/);
  assert.deepEqual(out['merge-request-planned'], { id: 3, repository: CORPUS, branch: 'change/ABC-3-3', base: 'master' });
  assert.deepEqual([out['plan-revised'], out['resume-at'], out['resume-source'], out['ai-feedback-short'], out['ai-feedback-long']], ['execution-plan-A.md', 'build', 'declared', null, null]);
  const mrs = mrsOf(s);
  assert.equal(mrs.length, 3, 'one new MR, the merged ones kept');
  assert.deepEqual(mrs.slice(0, 2).map(m => m.status), ['Merged', 'Merged']);
  const added = mrs[2];
  assert.deepEqual([added.id, added.repository, added.branch, added.base, added.status, added['depends-on']], [3, CORPUS, 'change/ABC-3-3', 'master', 'Not Created', []]);
  assert.equal(added['planned-by']?.step, 'Blocked');
  assert.equal(added['planned-by'].why, 'Blocked\'s own-branch fix (missing change): own work incomplete: no step failed; the fix is a new MR in example-corpus planned by Generate Solution');
  assert.match(added.contents, /^Missing change \(Blocked, \d{4}-\d\d-\d\d\): bump @scope\/\* to 1\.0\.0-preview\.85 in package\.json and the lockfile in https:\/\/gitlab\.com\/g\/example-corpus\.git\. Blocked found: the indicator never reaches users: the app pins the library to preview\.83\. Nothing failed: the ticket's work lacks it/);
  assert.match(added.contents, /its merge requests there \(MR 2 \(!4207\)\) have merged or closed, so it goes in this new one/);
  const text = s.read();
  assert.ok(text.startsWith('# Plan\n\n## Own-branch fix ('), 'appended after the plan');
  assert.match(text, /^## Own-branch fix \(\d{4}-\d\d-\d\d, Blocked, variation A, attempt 1\)\n/m);
  assert.match(text, /^Blocked: the indicator never reaches users: the app pins the library to preview\.83\. Cause: the ticket's work is incomplete/m);
  assert.match(text, /^Missing change: bump @scope\/\* to 1\.0\.0-preview\.85 in package\.json and the lockfile \(in https:\/\/gitlab\.com\/g\/example-corpus\.git\)\. Classify: own work incomplete/m);
  assert.match(text, /^Evidence:\n- a jira comment/m);
  assert.match(text, /^Nothing failed: this ticket's own work is incomplete — no p bug raised, no ticket scope added\.$/m);
  assert.match(text, /^Step added: make it in a new merge request, MR 3 \(example-corpus, branch change\/ABC-3-3, from the latest origin\/master\), planned for it \(Generate Solution builds and opens it\)\. This ticket's merge requests in example-corpus \(MR 2 \(!4207\)\) are merged or closed: do not reopen them or push to their branches\./m);
  assert.doesNotMatch(text, /Failing check/);
});

test('ASS-492 AC2/AC5: an Open or Not Created MR of the ticket in that repository takes the change — nothing planned, the plan naming it, the run still resuming at Generate Solution', async () => {
  for (const status of ['Open', 'Not Created']) {
    const s = setup(MISSING, { mrs: [...ABC_2870, row(3, CORPUS, status, status === 'Open' ? '!4300' : null)] });
    const out = JSON.parse((await s.fix()).stdout);
    assert.deepEqual([out['own-branch-fix'], out['merge-request-planned'], out['resume-at']], [true, null, 'build'], status);
    assert.deepEqual(out['merge-request-existing'], { id: 3, branch: 'change/ABC-3-3', status, key: status === 'Open' ? '!4300' : null }, status);
    assert.equal(mrsOf(s).length, 3, `${status}: no second plan`);
    assert.ok(mrsOf(s).every(m => m['planned-by'] == null), status);
    assert.match(s.read(), new RegExp(`Step added: make it on MR 3 \\(example-corpus, branch change/ABC-3-3, ${status}\\), this ticket's merge request there still to merge \\(Generate Solution\\)`), status);
  }
});

test('ASS-492: a missing change not shown to be the ticket\'s own work — Classify not saying own-branch, no repository named, or one the project does not list — exit 3, nothing planned or written', async () => {
  const cases = [
    [{ ...MISSING, 'own-branch': false }, /Classify did not put the cause in the ticket's own branch/],
    [{ ...MISSING, 'missing-change-repository': undefined }, /named no failing repository, file and job or assertion, nor a missing change and its repository/],
    [{ ...MISSING, 'missing-change-repository': 'https://gitlab.com/g/elsewhere' }, /https:\/\/gitlab\.com\/g\/elsewhere, where the missing change goes, is none of p's repositories/],
  ];
  for (const [output, why] of cases) {
    const s = setup(output, { mrs: ABC_2870 });
    const e = await s.refused();
    assert.equal(e.code, 3, e.stderr);
    assert.match(JSON.parse(e.stdout)['own-branch-why'], why);
    assert.equal(mrsOf(s).length, 2);
    assert.ok(!existsSync(s.plan));
  }
});
