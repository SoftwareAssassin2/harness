// ASS-390 — the commands grouped-blocked's new steps run: ticket:recheck-block
// (Check First: the blocked step's failing check re-run before any agent),
// ticket:dependency-wait (a block that only waits for a dependency merge
// request goes back to Build's Await Sequential Merge), merge-request:create-fix
// (Repair Project's separate fix merge request), ticket:wait-on
// --merge-request and ticket:fix-landed on it (the wait on that merge
// request, its Health saying it needs approval), and ticket:fix-attempts'
// count of them. Each logs what it found and did in the variation's change
// log (work.bash blocked_log). The forge is test/support/fake-forge.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeForge } from '../support/fake-forge.js';

const RUN = '77777777-7777-4777-8777-777777777777';
const APP = 'https://gitlab.com/g/app', IMAGES = 'https://gitlab.com/g/images';
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(json)); };
const outcome = promise => promise.then(r => ({ code: 0, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }), e => ({ code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr }));

// ABC-3 A of project p on engine `dev` (Plan, Build — a group running sub-build, whose check is
// `check` and Await Sequential Merge — Test, Done), blocked from build/<blockedAt>; its work folder made;
// p's repositories app and images; the Blocked run RUN holding `output`.
function setup({ check = './agent.sh ticket:set-paused {project} {ticket} {variation} false', blockedAt = 'check', output = {}, buildEngine = true } = {}) {
  const f = fixture(), forge = fakeForge();
  const at = (...rest) => join(f.dir, ...rest);
  const group = (id, sequence, engine) => ({ id, sequence, 'return-to-state': id, action: { type: 'state-engine', engine }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'done' }] });
  write(at('engines', 'dev', 'state-engine.json'), { steps: [
    { id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, 'follow-return-to-state': true, action: { type: 'human' } },
    { id: 'blocked', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'grouped-blocked' }, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }] },
    { id: 'committed', sequence: 1, action: { type: 'none' } },
    group('plan', 2, 'sub-plan'), group('build', 3, 'sub-build'), group('test', 4, 'sub-test'),
    { id: 'done', sequence: 5, 'is-done': true, action: { type: 'none' } },
  ] });
  write(at('engines', 'sub-plan', 'state-engine.json'), { steps: [{ id: 'write-plan', sequence: 1, action: { type: 'prompt', prompt: 'p' } }, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }] });
  write(at('engines', 'sub-build', 'state-engine.json'), { steps: [
    { id: 'generate', sequence: 1, action: { type: 'prompt', prompt: 'generate-solution-grouped' } },
    ...(buildEngine ? [{ id: 'await-dependencies', sequence: 2, action: { type: 'script', command: './agent.sh merge-request:await-dependencies {project} {ticket} {variation}' } }] : []),
    { id: 'check', sequence: 3, action: { type: 'script', command: check } },
    { id: 'merge', sequence: 4, action: { type: 'script', command: './agent.sh merge-request:merge {project} {ticket} {variation}' } },
    { id: 'done', sequence: 5, 'is-done': true, action: { type: 'none' } },
    { id: 'blocked', sequence: 6, 'is-done': true, action: { type: 'none' } },
  ] });
  write(at('engines', 'sub-test', 'state-engine.json'), { steps: [{ id: 'test', sequence: 1, action: { type: 'prompt', prompt: 't' } }, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }] });
  edit(at('projects', 'p', 'project.json'), p => { p['execution-state-engine'] = 'dev'; p.repositories = [{ url: APP }, { url: IMAGES }]; });
  const c = (from, to, sub) => ({ 'state-engine': 'dev', 'from-state': from, 'to-state': to, timestamp: '2026-11-12T09:00:00Z', 'agent-dispatch-log': [], ...(sub ? { 'sub-state-change': sub } : {}) });
  const s = (from, to) => c('build', 'build', { 'state-engine': 'sub-build', 'from-state': from, 'to-state': to });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => {
    Object.assign(sprint.features[0].variations[0], { 'harness-status': { state: 'blocked', 'state-engine': 'dev' },
      'state-changes': [c('committed', 'plan'), c('plan', 'build'), s(null, 'generate'), s('generate', blockedAt), s(blockedAt, 'blocked'), c('build', 'blocked')] });
  });
  const a = JSON.parse(readFileSync(at('assignments.json'), 'utf8'));
  a['transient-state-engines'].push({ id: RUN, project: 'p', 'state-engine': 'grouped-blocked', state: 'x', parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'dev', state: 'blocked' }, 'is-done': false, 'structured-output': output });
  writeFileSync(at('assignments.json'), JSON.stringify(a));
  mkdirSync(at('projects', 'p', 'work', 'ABC-3'), { recursive: true });
  const env = { ...f.env, PATH: forge.path };
  const agent = (...args) => run(AGENT, args, { env });
  const log = () => (existsSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md')) ? readFileSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md'), 'utf8') : '');
  const variation = () => JSON.parse(readFileSync(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8')).features[0].variations[0];
  const setVariation = fields => edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => Object.assign(sprint.features[0].variations[0], fields));
  return { ...f, forge, env, agent, log, variation, setVariation, at };
}

test('ASS-390 AC4: ticket:recheck-block re-runs the script step the ticket was blocked at — passing now, needs-fix false and "Passed on re-check; nothing to fix" in the change log; still failing, exit 3 with its last lines', async () => {
  const pass = setup();
  const ok = await outcome(pass.agent('ticket:recheck-block', 'p', 'ABC-3', 'A'));
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.out, { 'needs-fix': false, rechecked: true, 'recheck-passed': true, summary: 'Passed on re-check; nothing to fix', recheck: { at: 'build/check', command: './agent.sh ticket:set-paused p ABC-3 A false', exit: 0 } });
  assert.match(pass.log(), /^### \S+ Blocked, Check First\nPassed on re-check; nothing to fix\. Re-ran `\.\/agent\.sh ticket:set-paused p ABC-3 A false` \(the step build\/check, where it was blocked\): exit 0/m);
  const fail = setup({ check: './agent.sh ticket:set-paused {project} {ticket} Z false' });
  const still = await outcome(fail.agent('ticket:recheck-block', 'p', 'ABC-3', 'A'));
  assert.equal(still.code, 3);
  assert.deepEqual([still.out.rechecked, still.out.recheck.at, still.out.recheck.exit], [true, 'build/check', 1]);
  assert.match(still.out.recheck.output, /no ABC-3 variation Z|Z/);
  assert.match(fail.log(), /Re-checked the step build\/check: `\.\/agent\.sh ticket:set-paused p ABC-3 Z false` still fails \(exit 1\)\. On to Troubleshoot\./);
});

test('ASS-390 AC4: nothing to re-run — an agent\'s step, a command that changes something outside the ticket, one needing a run\'s value — exit 3, saying why, nothing run; a stay through Blocked for Human still finds the step that failed', async () => {
  const cases = [
    [{ blockedAt: 'generate' }, /build\/generate is no script step \(its action is prompt\)/],
    [{ blockedAt: 'merge' }, /merge-request:merge changes something outside the ticket/],
    [{ check: './agent.sh merge-request:check {project} {ticket} {variation} --only {merge-request-ids}' }, /needs \{merge-request-ids\}/],
  ];
  for (const [options, why] of cases) {
    const s = setup(options);
    const r = await outcome(s.agent('ticket:recheck-block', 'p', 'ABC-3', 'A'));
    assert.equal(r.code, 3, r.stderr);
    assert.equal(r.out.rechecked, false);
    assert.match(r.out['recheck-why'], why);
    assert.match(s.log(), /Not re-checked: .*On to Troubleshoot\./);
  }
  const s = setup();
  const back = (from, to) => ({ 'state-engine': 'dev', 'from-state': from, 'to-state': to, timestamp: '2026-11-12T10:00:00Z', 'agent-dispatch-log': [] });
  s.setVariation({ 'state-changes': [...s.variation()['state-changes'], back('blocked', 'blocked-for-human'), back('blocked-for-human', 'blocked')] });
  assert.equal((await outcome(s.agent('ticket:recheck-block', 'p', 'ABC-3', 'A'))).out.recheck.at, 'build/check', 'Have AI Try Again re-checks the step that failed');
  assert.equal((await outcome(s.agent('ticket:recheck-block', 'p', 'ABC-3', 'Z'))).code, 1);
});

// The variation's merge requests: MR 2 in app depends on MR 1 in images (Open, !12), as Await Sequential Merge waits on.
const PLANNED = [
  { id: 1, repository: IMAGES, branch: 'change/ABC-3-1', contents: 'publish the image', 'depends-on': [], status: 'Open', key: '!12', url: `${IMAGES}/-/merge_requests/12`, 'build-status': 'Pending' },
  { id: 2, repository: APP, branch: 'change/ABC-3-2', contents: 'pin the image', 'depends-on': [1], status: 'Open', key: '!7', url: `${APP}/-/merge_requests/7`, 'build-status': 'Pending' },
];

test('ASS-390 AC5: ticket:dependency-wait — Classify\'s dependency shown in the variation\'s merge requests: resume-at Build, resume-sub-at Await Sequential Merge, the feedback cleared, the change log saying so', async () => {
  for (const named of ['!12', '1', `${IMAGES}/-/merge_requests/12`, undefined]) {
    const s = setup({ blockedAt: 'check', output: { issue: 'dependency', reasoning: 'R', ...(named ? { 'dependency-merge-request': named } : {}) } });
    s.setVariation({ 'merge-request': PLANNED });
    const r = await outcome(s.agent('ticket:dependency-wait', 'p', 'ABC-3', 'A', RUN));
    assert.equal(r.code, 0, `${named}: ${r.stderr}`);
    assert.deepEqual([r.out['awaits-dependency'], r.out.dependency.key, r.out.dependency['waited-by'], r.out['resume-at'], r.out['resume-sub-at'], r.out['resume-source']], [true, '!12', 2, 'build', 'await-dependencies', 'declared'], named);
    assert.match(r.out['resume-why'], /dependency route \(ASS-390\) declares resume-at await-dependencies \(in build\)/);
    assert.deepEqual([r.out['ai-feedback-short'], r.out['ai-feedback-long']], [null, null]);
    assert.match(s.log(), /Blocked, Wait for the Dependency Merge Request\nThe block only waits for the dependency merge request !12 \(https:\/\/gitlab\.com\/g\/images, Open\), which MR 2 depends on, to merge: nothing changed; the ticket resumes at build's Await Sequential Merge/);
  }
});

test('ASS-390 AC5: ticket:dependency-wait — not shown (none waiting, the named one not among them, merged already, no Await Sequential Merge to resume at): exit 3, why as ai-feedback, for Blocked for Human', async () => {
  const cases = [
    [[], { 'dependency-merge-request': '!12' }, true, /has no merge request recorded/],
    [PLANNED.map(m => (m.id === 1 ? { ...m, status: 'Merged' } : m)), {}, true, /none of its merge requests depends on an unmerged one in another repository/],
    [PLANNED, { 'dependency-merge-request': '!99' }, true, /!99 is not one of its unmerged dependency merge requests in another repository \(!12\)/],
    [PLANNED, {}, false, /Await Sequential Merge is no step it can resume at/],
  ];
  for (const [mrs, named, buildEngine, why] of cases) {
    const s = setup({ output: { issue: 'dependency', reasoning: 'R', ...named }, buildEngine });
    s.setVariation({ 'merge-request': mrs });
    const r = await outcome(s.agent('ticket:dependency-wait', 'p', 'ABC-3', 'A', RUN));
    assert.equal(r.code, 3, r.stderr);
    assert.equal(r.out['awaits-dependency'], false);
    assert.match(r.out['dependency-why'], why);
    assert.equal(r.out['ai-feedback-short'], 'Not shown to wait only for a dependency merge request');
    assert.match(s.log(), /Classify said the block only waits for a dependency merge request to merge, but .*Handed to the operator\./);
  }
  const s = setup();
  assert.equal((await outcome(s.agent('ticket:dependency-wait', 'p', 'ABC-3', 'A', '88888888-8888-4888-8888-888888888888'))).code, 1, 'an unknown run');
});

// The forge's answers for app's fix merge request !41 on change/ABC-3-fix-1.
const fixMr = (v = {}) => ({ iid: 41, state: 'opened', draft: false, title: 'ABC-3: Rename the seed column (fix 1, unblocks ABC-3)', target_branch: 'master', has_conflicts: false, detailed_merge_status: 'mergeable', blocking_discussions_resolved: true, merge_when_pipeline_succeeds: false, head_pipeline: { status: 'success' }, web_url: `${APP}/-/merge_requests/41`, ...v });
function forgeFor(s) {
  s.forge.route('glab', /^api projects\/g%2Fapp --hostname gitlab.com$/, { out: { default_branch: 'master' } });
  s.forge.route('glab', /merge_requests\?state=opened&source_branch=change%2FABC-3-fix-1 --hostname gitlab.com$/, { out: [] });
  s.forge.route('glab', /repository\/branches\/change%2FABC-3-fix-1 --hostname gitlab.com$/, { out: {} });
  s.forge.route('glab', /repository\/compare\?from=master&to=change%2FABC-3-fix-1 --hostname gitlab.com$/, { out: { diffs: [{ new_path: 'db/seed.sql' }] } });
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests --hostname gitlab.com -X POST/, { out: { iid: 41, web_url: `${APP}/-/merge_requests/41` } });
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/41 --hostname gitlab.com$/, { out: fixMr({ draft: true, title: 'Draft: ABC-3: Rename the seed column (fix 1, unblocks ABC-3)' }) });
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/41 --hostname gitlab.com -X PUT/, { out: {} });
}
const WHY = 'The seed script still writes the column master renamed, so the ticket\'s tests cannot seed; the fix renames it there.';

test('ASS-390 AC2: merge-request:create-fix opens Repair Project\'s fix merge request on change/<KEY>-fix-<n> against the default branch — titled and described with the ticket it unblocks and why, out of draft — records it on the variation and logs it; never the ticket\'s own branch', async () => {
  const s = setup();
  forgeFor(s);
  const withStdin = (args, input) => new Promise(resolve => {
    const child = execFile(AGENT, ['merge-request:create-fix', 'p', 'ABC-3', 'A', ...args], { env: s.env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, out: stdout ? JSON.parse(stdout) : null, stderr }));
    child.stdin.end(input);
  });
  const r = await withStdin([APP, 'change/ABC-3-fix-1', 'Rename the seed column'], WHY);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out, { 'fix-merge-request': `${APP}/-/merge_requests/41`, key: '!41', branch: 'change/ABC-3-fix-1', repository: APP, base: 'master', created: true });
  const all = s.forge.log('glab').join('\n'), posted = all.slice(all.indexOf('api projects/g%2Fapp/merge_requests --hostname gitlab.com -X POST'));
  assert.match(posted, /-f source_branch=change\/ABC-3-fix-1 -f target_branch=master -f title=Draft: ABC-3: Rename the seed column \(fix 1, unblocks ABC-3\) -f description=Unblocks ABC-3: /);
  assert.ok(posted.includes(`ABC-3's own branches are not changed; ABC-3 waits for this to merge.\n\n${WHY}`), posted);
  assert.ok(s.forge.log('glab').some(l => /merge_requests\/41 --hostname gitlab.com -X PUT -f title=ABC-3: Rename the seed column/.test(l)), 'taken out of draft');
  const [row] = s.variation()['fix-merge-requests'];
  assert.deepEqual({ ...row, 'opened-at': undefined }, { n: 1, repository: APP, branch: 'change/ABC-3-fix-1', base: 'master', key: '!41', url: `${APP}/-/merge_requests/41`, status: 'Open', title: 'Rename the seed column', 'opened-at': undefined });
  assert.match(s.log(), /Blocked, Repair Project\nOpened the fix merge request !41 \(https:\/\/gitlab\.com\/g\/app\/-\/merge_requests\/41\) on change\/ABC-3-fix-1 in https:\/\/gitlab\.com\/g\/app, against master: "Rename the seed column"\. ABC-3 waits for it to merge; its own branches are not changed\. Why:\nThe seed script/);
  // Refused, nothing recorded: the ticket's own branch, another project's repository, no why.
  for (const [args, input, message] of [[[APP, 'change/ABC-3-1', 'T'], WHY, /no fix branch of ABC-3 A/], [['https://gitlab.com/g/other', 'change/ABC-3-fix-2', 'T'], WHY, /not one of p's repositories/], [[APP, 'change/ABC-3-fix-2', 'T'], ' ', /no description on stdin/]]) {
    const e = await withStdin(args, input);
    assert.equal(e.code, 1, args.join(' '));
    assert.match(e.stderr, message);
  }
  assert.equal(s.variation()['fix-merge-requests'].length, 1);
});

test('ASS-390 AC6: ticket:wait-on --merge-request waits on a fix merge request create-fix recorded; ticket:fix-landed polls it — open: 1, the Health naming it and saying it needs approval; merged: 0, landed, the feedback cleared; closed unmerged: 3, a question for the operator', async () => {
  const s = setup();
  forgeFor(s);
  const URL = `${APP}/-/merge_requests/41`;
  s.setVariation({ 'fix-merge-requests': [{ n: 1, repository: APP, branch: 'change/ABC-3-fix-1', base: 'master', key: '!41', url: URL, status: 'Open', title: 'T', 'opened-at': '2026-11-12T10:00:00Z' }] });
  for (const bad of ['-', `${APP}/-/merge_requests/99`]) {
    const r = await outcome(s.agent('ticket:wait-on', 'p', 'ABC-3', 'A', '--merge-request', bad));
    assert.equal(r.code, 1, bad);
    assert.match(r.out['ai-feedback-short'], /No fix merge request to wait on|cannot be waited on/);
  }
  const waited = await outcome(s.agent('ticket:wait-on', 'p', 'ABC-3', 'A', '--merge-request', URL));
  assert.equal(waited.code, 0, waited.stderr);
  assert.deepEqual(s.variation()['waits-on'], { 'merge-request': URL, key: '!41', repository: APP, branch: 'change/ABC-3-fix-1' });
  assert.ok(s.variation()['wait-began']?.at);
  assert.match(s.log(), /Blocked, Wait on the Fix Merge Request\nWaits for the fix merge request !41/);
  const landed = () => outcome(s.agent('ticket:fix-landed', 'p', 'ABC-3', 'A'));
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/41 --hostname gitlab.com$/, { out: fixMr() });
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/41\/approvals --hostname gitlab.com$/, { out: { approvals_left: 1 } });
  const open = await landed();
  assert.equal(open.code, 1, open.stderr);
  assert.deepEqual([open.out.status, open.out.landed], ['Open', false]);
  assert.equal(s.variation()['ai-feedback-short'], 'Waits on fix MR !41 in g/app: needs approval');
  assert.match(s.variation()['ai-feedback-long'], /fix merge request !41 \(https:\/\/gitlab\.com\/g\/app\/-\/merge_requests\/41\) to unblock ABC-3.*needs a person's approval to merge \(now: 1 approval\)/);
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/41 --hostname gitlab.com$/, { out: fixMr({ state: 'merged', merged_at: '2026-11-12T11:00:00Z' }) });
  const merged = await landed();
  assert.equal(merged.code, 0, merged.stderr);
  assert.deepEqual(merged.out, { 'waits-on': s.variation()['waits-on'], status: 'Merged', landed: true, 'fix-merge-request': URL, 'ai-feedback-short': null, 'ai-feedback-long': null });
  assert.equal(s.variation()['fix-merge-requests'][0].status, 'Merged');
  assert.match(s.log(), /Blocked, Await the Fix Merge Request\nThe fix merge request !41 \(.*\) merged: ABC-3 resumes\./);
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/41 --hostname gitlab.com$/, { out: fixMr({ state: 'closed' }) });
  const closed = await landed();
  assert.equal(closed.code, 3);
  assert.equal(closed.out['ai-feedback-short'], 'Fix MR !41 in g/app was closed unmerged');
  assert.match(closed.out['ai-feedback-long'], /closed without merging\. Reopen and merge it, or fix the block another way/);
  s.forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/41 --hostname gitlab.com$/, { exit: 1 });
  assert.equal((await landed()).code, 1, 'a forge that cannot be read: still waiting');
});

test('ASS-390: ticket:fix-attempts counts a fix merge request\'s wait, and the passes on re-check and dependency waits in a row, toward the budget of 3, saying which', async () => {
  const s = setup();
  const top = (from, to) => ({ 'state-engine': 'dev', 'from-state': from, 'to-state': to });
  const sub = (from, to) => ({ ...top('blocked', 'blocked'), 'sub-state-change': { 'state-engine': 'grouped-blocked', 'from-state': from, 'to-state': to } });
  const stay = [top('build', 'blocked'), sub(null, 'count-attempts')];
  const attempts = () => outcome(s.agent('ticket:fix-attempts', 'p', 'ABC-3', 'A'));
  const rechecked = { 'needs-fix': false, rechecked: true, 'recheck-passed': true, 'ended-at': 'done' }, waited = { 'awaits-dependency': true, 'ended-at': 'done' }, human = { 'ended-at': 'blocked-for-human' };
  s.setVariation({ 'state-changes': [...stay, sub('wait-on-fix-merge-request', 'await-fix-merge-request')], blocks: [] });
  assert.deepEqual((await attempts()).out, { 'fix-attempts': 1 });
  s.setVariation({ 'state-changes': stay, blocks: [human, rechecked, waited] });
  assert.deepEqual((await attempts()).out, { 'fix-attempts': 2, 'passed-on-recheck': 1, 'dependency-waits': 1 });
  s.setVariation({ 'state-changes': stay, blocks: [rechecked, rechecked, rechecked] });
  const three = await attempts();
  assert.equal(three.code, 3);
  assert.deepEqual([three.out['fix-attempts'], three.out['passed-on-recheck'], three.out['ai-feedback-short']], [3, 3, '3 fix attempts failed']);
  assert.match(three.out['ai-feedback-long'], /^The blocked step passed on re-check 3 times and failed again \(Check First, ASS-390\), and the block came back\. Read them and change-log-A\.md/);
  s.setVariation({ 'state-changes': stay, blocks: [{ 'needs-fix': false, 'ended-at': 'done' }, { 'needs-fix': false, rechecked: true, 'ended-at': 'done' }] });
  assert.deepEqual((await attempts()).out, { 'fix-attempts': 0 }, 'nothing wrong found by Troubleshoot is no attempt, as before — after a re-check that failed too');
});
