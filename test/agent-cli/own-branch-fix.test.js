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
function setup(output = FOUND, { vm = 'abc-3-a' } = {}) {
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
      'merge-request': [{ id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', base: 'main', contents: 'c', 'depends-on': [], status: 'Open', key: null, url: null, 'build-status': null }],
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
    fix: () => l.cli('ticket:own-branch-fix', 'p', 'ABC-3', 'A', RUN),
    refused: () => l.cli('ticket:own-branch-fix', 'p', 'ABC-3', 'A', RUN).then(() => assert.fail('it passed'), e => e),
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
