// ASS-509: ticket:catch-up-base — grouped-blocked's Bring the Base In. A
// ticket branch behind origin/<base> (a repository check reading files the
// base added since as deleted) is rebased onto it and pushed, a numbered file
// whose number the base took is renamed and pushed, and the blocked step's
// check is re-run: passing, the ticket resumes where it was blocked, never
// asking the operator; a rebase that conflicts goes to Generate Solution with
// the conflict in the plan, the branch left as it was. limactl is
// test/support/fake-limactl.js, the VM's root a folder holding real git
// checkouts whose origin is a local repository (vm-fixture.js); gh is
// fake-forge.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { lima, git, edit } from './vm-fixture.js';
import { run, AGENT } from './harness-fixture.js';
import { fakeForge } from '../support/fake-forge.js';

const RUN = '77777777-7777-4777-8777-777777777777';
const HUB = 'https://github.com/o/harness';
const commit = (dir, files, message) => {
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', message);
};
const BEHIND = {
  'needs-fix': true, summary: 'repeatable files on main read as deleted on the branch', 'root-cause': 'the branch was cut before main added db/R__report.sql',
  evidence: ['check-repeatable-not-deleted: db/R__report.sql exists at origin/main and is deleted here'],
  issue: 'behind-base', reasoning: 'the files are main\'s, not the ticket\'s', 'ticket-branch-repository': HUB, 'ticket-branch': 'change/ABC-3-1',
};

// ABC-3 A, its VM abc-3-a, blocked at `check` (automated-tests:verify-success) of p's `dev` engine; its merge
// request in harness on change/ABC-3-1 (base main), pushed, a commit adding `adds`; main then gains `lands`
// (db/R__report.sql by default) on origin, not yet fetched in the VM. The recorded test checks `test`. The merge
// request is not opened on the forge yet (its branch rebased), unless `opened` gives its key (the base merged in).
function setup({ output = BEHIND, adds = { 'src/feature.js': 'mine\n' }, lands = { 'db/R__report.sql': 'report\n' }, check = 'test -f db/R__report.sql', numbered = [], opened = null } = {}) {
  const l = lima(), forge = fakeForge();
  l.v.instance('abc-3-a', 'Running');
  const env = { ...l.env, PATH: `${forge.path.split(':')[0]}:${l.env.PATH}`, NUMBERED_FILES_RETRY_SLEEPS: '0 0' };
  const at = (...rest) => join(l.f.dir, ...rest);
  const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(json)); };
  write(at('engines', 'dev', 'state-engine.json'), { steps: [
    { id: 'blocked', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'grouped-blocked' }, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }] },
    { id: 'committed', sequence: 1, action: { type: 'none' } },
    { id: 'build', sequence: 2, 'return-to-state': 'build', action: { type: 'state-engine', engine: 'sub-build' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'check' }] },
    { id: 'check', sequence: 3, action: { type: 'script', command: './agent.sh automated-tests:verify-success {project} {ticket} {variation}' }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 4, 'is-done': true, action: { type: 'none' } },
  ] });
  write(at('engines', 'sub-build', 'state-engine.json'), { steps: [
    { id: 'generate-solution', sequence: 1, action: { type: 'prompt', prompt: 'generate-solution-grouped' } },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] });
  edit(at('projects', 'p', 'project.json'), p => { p['execution-state-engine'] = 'dev'; if (numbered !== null) p['numbered-files'] = numbered; });
  const c = (from, to) => ({ 'state-engine': 'dev', 'from-state': from, 'to-state': to, timestamp: '2026-11-18T01:00:00Z', 'agent-dispatch-log': [] });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0].variations[0], {
      vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-11-18T00:00:00Z' },
      'state-changes': [c('committed', 'build'), c('build', 'check'), c('check', 'blocked')],
      'merge-request': [{ id: 1, repository: HUB, branch: 'change/ABC-3-1', base: 'main', contents: 'c', 'depends-on': [], status: opened ? 'Open' : 'Not Created', key: opened, url: null, 'build-status': null }],
    });
  });
  const a = JSON.parse(readFileSync(at('assignments.json'), 'utf8'));
  a['transient-state-engines'].push({ id: RUN, project: 'p', 'state-engine': 'grouped-blocked', state: 'catch-up-base', parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'dev', state: 'blocked' }, 'is-done': false, 'structured-output': output });
  writeFileSync(at('assignments.json'), JSON.stringify(a));
  const own = l.vmFile('repos', 'harness'), origin = l.origins.harness.work;
  for (const dir of [own, origin]) { git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T'); }
  git(own, 'checkout', '-q', '-b', 'change/ABC-3-1');
  commit(own, adds, 'mine');
  git(own, 'push', '-q', 'origin', 'change/ABC-3-1');
  git(own, 'branch', '-q', '--set-upstream-to', 'origin/change/ABC-3-1');
  commit(origin, lands, 'main moves on');
  writeFileSync(join(l.folder, 'automated-tests-A.json'), JSON.stringify([{ list: 'cd harness && echo listed', run: `cd harness && ${check}` }]));
  forge.route('gh', /^api --paginate repos\/o\/harness\/pulls\?state=open&per_page=100$/, { out: [{ number: 5, head: { ref: 'change/ABC-3-1' } }] });
  forge.route('gh', /^api --paginate repos\/o\/harness\/pulls\/5\/files\?per_page=100$/, { out: Object.keys(adds).map(f => ({ filename: f, status: 'added' })) });
  const cli = () => run(AGENT, ['ticket:catch-up-base', 'p', 'ABC-3', 'A', RUN], { env });
  return {
    ...l, own, origin, env, forge,
    fix: async () => JSON.parse((await cli()).stdout),
    refused: () => cli().then(() => assert.fail('it passed'), e => e),
    plan: () => (existsSync(join(l.folder, 'execution-plan-A.md')) ? readFileSync(join(l.folder, 'execution-plan-A.md'), 'utf8') : ''),
    log: () => readFileSync(join(l.folder, 'change-log-A.md'), 'utf8'),
    onOrigin: path => git(origin, 'ls-tree', '-r', '--name-only', 'change/ABC-3-1').split('\n').includes(path),
  };
}

test('ASS-509 AC2/AC7: a branch behind its base (repeatable files on main only) is rebased onto the latest origin/main and pushed, the blocked check re-run and passing — the ticket resumes where it was blocked, no operator', async () => {
  const s = setup();
  const out = await s.fix();
  assert.equal(out['own-branch-fix'], true);
  assert.equal(out['own-branch-source'], 'behind-base');
  assert.equal(out['resume-at'], undefined, 'no resume-at: back to the step it was blocked at');
  assert.deepEqual([out['ai-feedback-short'], out['ai-feedback-long']], [null, null]);
  assert.deepEqual(out['caught-up'].map(r => [r.repository, r.branch, r.base, r.status, r.behind]), [['harness', 'change/ABC-3-1', 'main', 'rebased', 2]]);
  assert.match(out['caught-up'][0].detail, /--force-with-lease/);
  assert.ok(s.onOrigin('db/R__report.sql') && s.onOrigin('src/feature.js'), 'origin\'s branch holds main\'s file and the ticket\'s own');
  assert.equal(git(s.origin, 'rev-list', '--count', 'change/ABC-3-1..main'), '0', 'nothing of main\'s missing');
  assert.deepEqual([out.recheck?.at, out.recheck?.exit], ['check', 0]);
  assert.equal(git(s.own, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3-1');
  assert.match(s.log(), /Blocked, Bring the Base In\nBrought origin\/<base> into the ticket's branches \(Classify: behind-base, harness\):\n- harness change\/ABC-3-1: rebased/);
  assert.match(s.log(), /Passed on re-check; nothing to fix/);
  assert.equal(s.plan(), '', 'no plan change: nothing for Generate Solution');
});

test('ASS-509 AC2/AC7: a rebase that conflicts is not forced — the branch left as it was, the conflict in the plan\'s Own-branch fix section, back to Generate Solution\'s group, not the operator', async () => {
  const s = setup({ adds: { 'README.md': 'the ticket\'s\n' }, lands: { 'README.md': 'main\'s\n' } });
  const before = git(s.origin, 'rev-parse', 'change/ABC-3-1'), local = git(s.own, 'rev-parse', 'HEAD');
  const out = await s.fix();
  assert.deepEqual([out['own-branch-fix'], out['own-branch-source'], out['resume-at'], out['plan-revised']], [true, 'behind-base-conflict', 'build', 'execution-plan-A.md']);
  assert.equal(out['caught-up'][0].status, 'conflict');
  assert.match(out['caught-up'][0].detail, /conflicts in README\.md/);
  assert.equal(git(s.origin, 'rev-parse', 'change/ABC-3-1'), before, 'nothing pushed');
  assert.equal(git(s.own, 'rev-parse', 'HEAD'), local, 'the local branch as it was');
  assert.equal(git(s.own, 'status', '--porcelain'), '', 'no rebase left half-done');
  assert.match(s.plan(), /^## Own-branch fix \(\d{4}-\d\d-\d\d, Blocked, variation A, attempt 1\)\n/);
  assert.match(s.plan(), /Bring the base in first — Blocked could not do it mechanically, and left each branch as it was:\n- harness change\/ABC-3-1: rebasing change\/ABC-3-1 onto origin\/main .* conflicts in README\.md\n/);
  assert.match(s.plan(), /Step added: in each, git fetch origin and bring the latest origin\/<base> in/);
});

test('ASS-509 AC3/AC7: a numbered file whose number main took is renamed to the next free one — every reference on the branch, the recorded automated tests — pushed, the check re-run, and the ticket resumes', async () => {
  const s = setup({
    output: { ...BEHIND, issue: 'numbered-file-taken', summary: 'V2 is taken on main' },
    adds: { 'db/V2__events.sql': 'events\n', 'db/plan.txt': 'apply V2__events.sql\n' },
    lands: { 'db/V2__other.sql': 'theirs\n' },
    check: 'test -f db/V2__events.sql && test -f db/V2__other.sql',
    numbered: null,   // the default rule: Flyway's V<n>__ migrations
  });
  const out = await s.fix();
  assert.deepEqual([out['own-branch-fix'], out['own-branch-source']], [true, 'numbered-file'], JSON.stringify(out));
  assert.deepEqual(out.renumbered.map(r => [r.file, r['rename-to'], r.status]), [['db/V2__events.sql', 'db/V3__events.sql', 'renumbered']]);
  assert.deepEqual(out.renumbered[0].references.toSorted(), ['automated-tests-A.json', 'db/plan.txt']);
  assert.ok(s.onOrigin('db/V3__events.sql') && !s.onOrigin('db/V2__events.sql') && s.onOrigin('db/V2__other.sql'), 'renamed, on top of main');
  assert.equal(git(s.origin, 'show', 'change/ABC-3-1:db/plan.txt'), 'apply V3__events.sql');
  assert.match(git(s.origin, 'log', '-1', '--format=%s', 'change/ABC-3-1'), /^ABC-3: renumber V2__events\.sql to V3__events\.sql, its number taken \(2 is at or below the highest on main, 2\)$/);
  assert.match(readFileSync(join(s.folder, 'automated-tests-A.json'), 'utf8'), /test -f db\/V3__events\.sql/, 'the recorded test names the new file');
  assert.doesNotMatch(readFileSync(join(s.folder, 'automated-tests-A.json'), 'utf8'), /V2__events\.sql/);
  assert.match(s.log(), /Renumbered the numbered files whose number is taken:\n- harness change\/ABC-3-1: db\/V2__events\.sql → db\/V3__events\.sql/);
  assert.equal(out.recheck?.exit, 0);
});

test('ASS-509: brought up to date but the check still fails — exit 4, on to Troubleshoot; nothing to bring in — exit 3, Classify\'s finding not borne out, for the operator', async () => {
  const s = setup({ check: 'test ! -f src/feature.js' });
  const e = await s.refused();
  assert.equal(e.code, 4, e.stderr);
  const out = JSON.parse(e.stdout);
  assert.deepEqual([out['own-branch-fix'], out['base-caught-up'], out['caught-up'][0].status, out.recheck?.exit], [false, true, 'rebased', 1]);
  const again = await s.refused();
  assert.equal(again.code, 3, again.stderr);
  const none = JSON.parse(again.stdout);
  assert.equal(none['caught-up'][0].status, 'up-to-date');
  assert.match(none['ai-feedback-short'], /^Not borne out: nothing to bring in, no numbered file taken/);
  assert.match(none['ai-feedback-long'], /Classify said behind-base, but each of ABC-3 A's branches has every commit of its origin\/<base>/);
});

test('ASS-509: a push the forge refuses puts the branch back as it was — exit 5, the operator told what failed', async () => {
  const s = setup();
  const before = git(s.own, 'rev-parse', 'HEAD');
  git(s.own, 'remote', 'set-url', '--push', 'origin', '/nonexistent/origin');
  const e = await s.refused();
  assert.equal(e.code, 5, e.stderr);
  const out = JSON.parse(e.stdout);
  assert.equal(out['caught-up'][0].status, 'push-failed');
  assert.match(out['ai-feedback-short'], /^Not brought up to date: push-failed/);
  assert.equal(git(s.own, 'rev-parse', 'HEAD'), before, 'the local branch put back');
});

// Review findings on the first cut (ASS-509).
test('ASS-509 AC2: a merge request opened on the forge is never rewritten — origin/<base> merged in and pushed plainly, its commits kept', async () => {
  const s = setup({ opened: '#5' });
  const before = git(s.origin, 'rev-parse', 'change/ABC-3-1');
  const out = await s.fix();
  assert.deepEqual([out['own-branch-fix'], out['caught-up'][0].status], [true, 'merged']);
  assert.match(out['caught-up'][0].detail, /plain push: its merge request #5 is open on the forge, so never rewritten/);
  git(s.origin, 'merge-base', '--is-ancestor', before, 'change/ABC-3-1');   // throws when the old head was rewritten away
  assert.ok(s.onOrigin('db/R__report.sql'));
  assert.equal(git(s.own, 'rev-parse', 'HEAD'), git(s.origin, 'rev-parse', 'change/ABC-3-1'), 'the local branch moved to what was pushed');
});

test('ASS-509 (ASS-423): an opened merge request whose branch the forge deleted (merged) is never pushed again; nor is a branch with nothing of its own beyond the base', async () => {
  const s = setup({ opened: '#5' });
  git(s.origin, 'branch', '-q', '-D', 'change/ABC-3-1');   // merged on the forge, its source branch removed
  const e = await s.refused();
  assert.equal(e.code, 3, e.stderr);
  const out = JSON.parse(e.stdout);
  assert.equal(out['caught-up'][0].status, 'skipped');
  assert.match(out['caught-up'][0].detail, /is gone from origin .*never pushed again/);
  assert.equal(git(s.origin, 'branch', '--list', 'change/ABC-3-1'), '', 'not recreated');
  const t = setup();
  git(t.own, 'reset', '-q', '--hard', 'HEAD~1'); git(t.own, 'push', '-q', '-f', 'origin', 'HEAD:change/ABC-3-1');   // the branch holds nothing of its own
  const none = JSON.parse((await t.refused()).stdout);
  assert.equal(none['caught-up'][0].status, 'skipped');
  assert.match(none['caught-up'][0].detail, /no commit of its own beyond origin\/main/);
});

test('ASS-509: a run killed part way (a merge left in progress on a detached HEAD) is settled first — aborted, put back on the branch — then brought up to date', async () => {
  const s = setup();
  const tip = git(s.own, 'rev-parse', 'HEAD');
  git(s.own, 'checkout', '-q', '-b', 'scratch', 'HEAD~1');
  commit(s.own, { 'src/feature.js': 'other\n' }, 'other');
  git(s.own, 'checkout', '-q', '--detach', tip);
  assert.throws(() => git(s.own, 'merge', 'scratch'));   // conflicts: left mid-merge, detached
  const out = await s.fix();
  assert.equal(out['caught-up'][0].status, 'rebased');
  assert.equal(git(s.own, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3-1');
  assert.equal(git(s.own, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('ASS-509 AC3: a rename stages only what it touched — an untracked file in the checkout is never committed or pushed; a chain (2 → 3, 3 → 4) renamed highest first; references matched on their own, never inside a longer name or under another folder', async () => {
  const s = setup({
    output: { ...BEHIND, issue: 'numbered-file-taken', summary: 'V2 is taken on main' },
    adds: { 'db/V2__events.sql': 'events\n', 'db/V3__more.sql': 'more\n', 'db/plan.txt': 'apply V2__events.sql then db/V3__more.sql; not old_V2__events.sql, V2__events.sql.bak or other/V2__events.sql\n' },
    lands: { 'db/V2__other.sql': 'theirs\n' },
    check: 'test -f db/V2__events.sql && test -f db/V3__more.sql',
    numbered: null,
  });
  writeFileSync(join(s.own, '.env.local'), 'SECRET=1\n');   // untracked, not ignored
  writeFileSync(join(s.folder, 'automated-tests-A.json'), JSON.stringify([{ list: 'cd harness && echo listed', run: 'cd harness && test -f db/V2__events.sql && test -f db/V3__more.sql && test ! -f other/V2__events.sql' }]));
  const out = await s.fix();
  assert.deepEqual(out.renumbered.map(r => [r.file, r['rename-to'], r.status]), [['db/V3__more.sql', 'db/V4__more.sql', 'renumbered'], ['db/V2__events.sql', 'db/V3__events.sql', 'renumbered']], JSON.stringify(out));
  assert.ok(!s.onOrigin('.env.local'), 'the untracked file not pushed');
  assert.ok(git(s.own, 'status', '--porcelain').includes('?? .env.local'), 'and still there, untracked');
  assert.equal(git(s.origin, 'show', 'change/ABC-3-1:db/plan.txt'), 'apply V3__events.sql then db/V4__more.sql; not old_V2__events.sql, V2__events.sql.bak or other/V2__events.sql');
  const recorded = JSON.parse(readFileSync(join(s.folder, 'automated-tests-A.json'), 'utf8'))[0].run;
  assert.equal(recorded, 'cd harness && test -f db/V3__events.sql && test -f db/V4__more.sql && test ! -f other/V2__events.sql');
  assert.deepEqual([out['own-branch-fix'], out.recheck?.exit], [true, 0]);
});
