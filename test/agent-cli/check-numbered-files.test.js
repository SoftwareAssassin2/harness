// merge-request:check-numbered-files (ASS-385): grouped-build's Check Numbered
// Files, before Automated Testing, and the grouped prompts that rebase before
// they push: each numbered file (a migration, a numbered test) a merge
// request of the variation adds must be above the highest on its target
// branch and taken by no older open merge request in its repository, else it
// names the file and the free number to use (exit 1, back to Generate
// Solution). limactl is test/support/fake-limactl.js, the VM's root a folder
// holding real git checkouts (vm-fixture.js: harness, on GitHub, on main;
// example-corpus, on GitLab, on master); glab and gh are fake-forge.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { lima, git, edit } from './vm-fixture.js';
import { run, AGENT } from './harness-fixture.js';
import { fakeForge } from '../support/fake-forge.js';

const commit = (dir, files, message) => {
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', message);
};

// ABC-3 A, its VM abc-3-a running; its plan MR 1 in harness (change/ABC-3-1,
// opened as #5) and MR 2 in example-corpus (change/ABC-3-2, opened as !12).
// harness's main holds db/V1 and db/V2 when the branch is cut, then gains V4
// on origin (not yet fetched in the VM); the branch adds `adds` (by default
// db/V3__mine.sql). The forge lists no other open merge request until a test
// routes one: openOn(repo, [{ iid, branch, files }]).
function setup({ adds = { 'db/V3__mine.sql': 'mine\n' }, numbered } = {}) {
  const l = lima(), forge = fakeForge();
  l.v.instance('abc-3-a', 'Running');
  const env = { ...l.env, PATH: `${forge.path.split(':')[0]}:${l.env.PATH}` };
  if (numbered !== undefined) edit(join(l.f.dir, 'projects', 'p', 'project.json'), p => { p['numbered-files'] = numbered; });
  edit(join(l.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0].variations[0], {
      vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' },
      'merge-request': [
        { id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', base: 'main', contents: 'c', 'depends-on': [], status: 'Open', key: '#5', url: null, 'build-status': null },
        { id: 2, repository: 'https://gitlab.com/g/example-corpus.git', branch: 'change/ABC-3-2', base: 'master', contents: 'c', 'depends-on': [], status: 'Open', key: '!12', url: null, 'build-status': null },
      ],
    });
  });
  const own = l.vmFile('repos', 'harness'), origin = l.origins.harness.work;
  for (const dir of [own, origin, l.vmFile('repos', 'example-corpus')]) { git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T'); }
  commit(origin, { 'db/V1__init.sql': '1\n', 'db/V2__more.sql': '2\n' }, 'V1, V2');
  git(own, 'fetch', '-q', 'origin');
  git(own, 'checkout', '-q', '-b', 'change/ABC-3-1', 'origin/main');
  commit(own, adds, 'mine');
  commit(origin, { 'db/V4__theirs.sql': '4\n' }, 'V4 lands on main');
  const openOn = (repo, list) => {
    if (repo === 'harness') {
      forge.route('gh', /^api --paginate repos\/o\/harness\/pulls\?state=open&per_page=100$/, { out: list.map(m => ({ number: m.iid, head: { ref: m.branch } })) });
      for (const m of list) forge.route('gh', new RegExp(`^api --paginate repos/o/harness/pulls/${m.iid}/files\\?per_page=100$`), { out: m.files.map(f => ({ filename: f, status: 'added' })) });
    } else {
      forge.route('glab', /^api projects\/g%2Fexample-corpus\/merge_requests\?state=opened&per_page=100 --hostname gitlab\.com --paginate$/, { out: list.map(m => ({ iid: m.iid, source_branch: m.branch })) });
      for (const m of list) forge.route('glab', new RegExp(`^api projects/g%2Fexample-corpus/merge_requests/${m.iid}/diffs\\?per_page=100 --hostname gitlab\\.com --paginate$`), { out: m.files.map(f => ({ new_path: f, new_file: true })) });
    }
  };
  openOn('harness', [{ iid: 5, branch: 'change/ABC-3-1', files: Object.keys(adds) }]);
  openOn('example-corpus', []);
  const results = join(l.folder, 'numbered-files-check-A.md');
  const cli = () => run(AGENT, ['merge-request:check-numbered-files', 'p', 'ABC-3', 'A'], { env });
  return {
    ...l, forge, own, origin, openOn,
    check: async () => JSON.parse((await cli()).stdout),
    failure: () => cli().then(() => assert.fail('it passed'), e => e),
    results: () => readFileSync(results, 'utf8'),
    hasResults: () => existsSync(results),
  };
}

test('ASS-385 AC3: a migration the branch adds at or below the target branch\'s highest (master moved on since) fails the step, naming the file and the free number, one above the highest; written to the ticket folder', async () => {
  const s = setup();
  const e = await s.failure();
  assert.equal(e.code, 1, e.stderr);
  assert.match(e.stderr, /1 numbered file\(s\) the ticket's merge requests add collide/);
  assert.match(e.stderr, /- harness MR 1 \(#5\) \(change\/ABC-3-1\): db\/V3__mine\.sql → db\/V5__mine\.sql — migration 3 is at or below the highest on main, 4; free number 5 from one above the highest on main and in the other open merge requests/);
  const out = JSON.parse(e.stdout);
  assert.deepEqual(out.collisions.map(c => [c.file, c['renumber-to'], c['rename-to'], c['free-number-from']]), [['db/V3__mine.sql', 5, 'db/V5__mine.sql', 'fallback']]);
  assert.match(s.results(), /^# Numbered files check — ABC-3 A, /);
  assert.match(s.results(), /## ✗ 1 numbered file\(s\) collide: renumber each \(git mv, and every reference to it, the recorded automated tests included\), then push/);
  // Renumbered as it says: clear.
  git(s.own, 'mv', 'db/V3__mine.sql', 'db/V5__mine.sql'); git(s.own, 'commit', '-q', '-m', 'renumber');
  s.openOn('harness', [{ iid: 5, branch: 'change/ABC-3-1', files: ['db/V5__mine.sql'] }]);
  assert.deepEqual(await s.check(), { checked: 1, collisions: [] });
  assert.match(s.results(), /## ✓ 1 numbered file\(s\) the ticket's merge requests add: none collides/);
});

test('ASS-385 AC3: a number another open merge request opened before this one adds collides — the free number skips every number the others hold; one opened after it does not (the older keeps it); this one itself is never another', async () => {
  const s = setup({ adds: { 'db/V5__mine.sql': 'mine\n' } });
  s.openOn('harness', [
    { iid: 3, branch: 'change/OTHER-1', files: ['db/V5__older.sql', 'db/V6__older.sql', 'README.md'] },
    { iid: 5, branch: 'change/ABC-3-1', files: ['db/V5__mine.sql'] },
    { iid: 9, branch: 'change/OTHER-2', files: ['db/V7__newer.sql'] },
  ]);
  const e = await s.failure();
  assert.equal(e.code, 1, e.stderr);
  assert.match(e.stderr, /db\/V5__mine\.sql → db\/V8__mine\.sql — migration 5 is also added by #3, opened before this one; free number 8/);
  // Only a newer one shares the number: clear.
  s.openOn('harness', [{ iid: 5, branch: 'change/ABC-3-1', files: ['db/V5__mine.sql'] }, { iid: 9, branch: 'change/OTHER-2', files: ['db/V5__newer.sql'] }]);
  assert.deepEqual(await s.check(), { checked: 1, collisions: [] });
  // Not yet opened (no key): every open one is older.
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => { j.features[0].variations[0]['merge-request'][0].key = null; });
  assert.match((await s.failure()).stderr, /db\/V5__mine\.sql → db\/V6__mine\.sql — migration 5 is also added by #9/);
});

test('ASS-385 AC3: when a file collides, it and the branch\'s later ones in its folder are renumbered in order, the earlier kept; each folder is a sequence of its own; a renumbered name keeps its digits\' width', async () => {
  const s = setup({ adds: { 'db/V3__a.sql': 'a\n', 'db/V9__b.sql': 'b\n', 'other/V2__c.sql': 'c\n', 'db/0003_x.sql': 'not a migration\n' } });
  const out = JSON.parse((await s.failure()).stdout);
  assert.deepEqual(out.collisions.map(c => [c.file, c['rename-to']]), [['db/V3__a.sql', 'db/V5__a.sql'], ['db/V9__b.sql', 'db/V6__b.sql']]);
  assert.equal(out.checked, 3, 'other/V2 is the first in its own folder: clear');
  const t = setup({ adds: { 'tests/0003_t.sql': 'x\n' }, numbered: [{ kind: 'test', glob: 'tests/*.sql' }] });
  commit(t.origin, { 'tests/0004_on_main.sql': '4\n' }, 'test 4');
  assert.deepEqual(JSON.parse((await t.failure()).stdout).collisions.map(c => c['rename-to']), ['tests/0005_t.sql']);
});

test('ASS-385 AC1, AC4: a kind declared with a command takes its free number from it, run in the repository\'s checkout in the VM with the VM\'s forge credentials; a command that fails falls back, saying so', async () => {
  const s = setup({ numbered: [{ kind: 'migration', glob: 'db/V*__*.sql', command: 'echo "token=${GITLAB_TOKEN:-none} in=$(basename "$PWD")" >&2; echo "next free: V42"' }] });
  mkdirSync(s.vmFile('run', 'harness'), { recursive: true });
  writeFileSync(s.vmFile('run', 'harness', 'env'), 'GITLAB_TOKEN=glpat-from-the-vm\n');
  const e = await s.failure();
  assert.match(e.stderr, /db\/V3__mine\.sql → db\/V42__mine\.sql — migration 3 is at or below the highest on main, 4; free number 42 from `echo /);
  assert.equal(JSON.parse(e.stdout).collisions[0]['free-number-from'], 'command');
  assert.ok(s.v.calls().some(c => c.vm === 'abc-3-a' && c.workdir === '/repos/harness' && c.argv.join(' ').includes('next')), 'run in the VM, in /repos/harness');
  // The command's own stderr shows it ran with the VM's token; prove it through a command that fails, whose output the results keep.
  edit(join(s.f.dir, 'projects', 'p', 'project.json'), p => { p['numbered-files'][0].command = 'echo "token=$GITLAB_TOKEN" >&2; exit 2'; });
  const f = await s.failure();
  assert.match(f.stderr, /db\/V3__mine\.sql → db\/V5__mine\.sql .*from one above the highest on main/);
  assert.match(s.results(), /⚠ harness: `echo "token=\$GITLAB_TOKEN" >&2; exit 2` gave no number \(exit\/output: token=glpat-from-the-vm/);
});

test('ASS-385 AC4: a GitLab repository\'s other open merge requests are read through glab api on the host; a forge that fails the call exits 3 (Blocked), naming the repository', async () => {
  const s = setup({ adds: { 'db/V5__mine.sql': 'mine\n' } });
  const corpus = s.vmFile('repos', 'example-corpus');
  git(corpus, 'checkout', '-q', '-b', 'change/ABC-3-2');
  commit(corpus, { 'sql/V1__corpus.sql': 'c\n' }, 'corpus');
  s.openOn('example-corpus', [{ iid: 7, branch: 'change/OTHER-3', files: ['sql/V1__other.sql'] }, { iid: 12, branch: 'change/ABC-3-2', files: ['sql/V1__corpus.sql'] }]);
  const e = await s.failure();
  assert.match(e.stderr, /- example-corpus MR 2 \(!12\) \(change\/ABC-3-2\): sql\/V1__corpus\.sql → sql\/V2__corpus\.sql — migration 1 is also added by !7, opened before this one/);
  assert.doesNotMatch(e.stderr, /harness MR 1/);
  assert.ok(s.forge.log('glab').some(l => l.startsWith('api projects/g%2Fexample-corpus/merge_requests/7/diffs')));
  s.forge.route('glab', /merge_requests\?state=opened/, { exit: 1 });
  const f = await s.failure();
  assert.equal(f.code, 3, f.stderr);
  assert.match(f.stderr, /could not check every repository: example-corpus: could not read its open merge requests from the forge/);
});

test('ASS-385 AC1: no rule declared checks Flyway versioned migrations by the fallback; [] declares none and checks nothing — not even the VM reached; a malformed declaration exits 3, naming the problem', async () => {
  const s = setup({ adds: { 'db/V5__mine.sql': 'mine\n', 'db/R__views.sql': 'r\n' } });
  assert.deepEqual(await s.check(), { checked: 1, collisions: [] });
  const t = setup({ numbered: [] });
  assert.deepEqual(await t.check(), { checked: 0, collisions: [] });
  assert.match(t.results(), /Nothing to check: p declares no numbered files/);
  assert.deepEqual(t.v.calls().filter(c => c.vm === 'abc-3-a'), []);
  for (const [numbered, message] of [
    [{ kind: 'migration' }, /"numbered-files" must be a list/],
    [[{ glob: '*.sql' }], /numbered-files\[0\]: "kind" must be a name/],
    [[{ kind: 'm' }], /numbered-files\[0\]: "glob" must be a non-empty string/],
    [[{ kind: 'm', glob: '*.sql', command: '' }], /numbered-files\[0\]: "command" must be a non-empty string/],
    [[{ kind: 'm', glob: '*.sql', comand: 'x' }], /numbered-files\[0\]: unknown key "comand"/],
    [[{ kind: 'm', glob: 'a/*.sql' }, { kind: 'm', glob: 'b/*.sql' }], /names the kind "m" twice/],
  ]) {
    const u = setup({ numbered });
    const e = await u.failure();
    assert.equal(e.code, 3, String(message));
    assert.match(e.stderr, message);
  }
});

test('ASS-385: the results file is the harness\'s own: an agent cannot write it through work:write', async () => {
  const s = setup();
  const e = await run(AGENT, ['work:write', 'p', 'ABC-3', 'A', 'numbered-files-check.md'], { env: s.env }).then(() => null, error => error);
  assert.match(e?.stderr ?? '', /is the harness's own: not written/);
});
