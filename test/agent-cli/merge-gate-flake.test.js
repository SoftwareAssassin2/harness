// ASS-394 — the merge gate (merge-request:merge-in-turn) on a red test run:
// the failing tests run again once (a pass is a flake: it merges); failing
// again, the same tests run on the latest master — failing there too, they
// are master's: the ticket is not sent back (no exit, no visit charged), it
// waits for master to move, and each such test is raised once in the project
// (here the harness project's own backlog, off-board), never twice; passing
// there, the failure is the ticket's, red as before. A real workspace and a
// fake gh (merge-in-turn-fixture.js); the project's tests are node --test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { queue, git } from './merge-in-turn-fixture.js';

// Project p as the harness project, its issues its own off-board backlog (ASS-n).
function asHarness(q) {
  const pj = join(q.f.dir, 'projects', 'p', 'project.json'), hj = join(q.f.dir, 'harness.json');
  writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), 'work-sources': [{ name: 'Harness', type: 'off-board', folder: 'harness', 'key-prefix': 'ASS' }] }));
  writeFileSync(hj, JSON.stringify({ ...JSON.parse(readFileSync(hj, 'utf8')), 'harness-project': 'p' }));
}

// The project's full tests become node --test files under t/, on main; each test run logs where it ran.
function nodeTests(q, files) {
  mkdirSync(join(q.ws, 't'), { recursive: true });
  const ran = join(q.dir, 'ran.log');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(q.ws, 't', name), `import { test } from 'node:test';\nimport { existsSync, writeFileSync, appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(ran)}, process.cwd() + '\\n');\n${body}\n`);
  }
  q.commit('check.sh', "#!/bin/sh\nexec node --test --test-force-exit 't/*.test.js'\n", 'node tests');
  git(q.ws, 'push', '-q', 'origin', 'main');
  return () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n') : []);
}

const tickets = q => (existsSync(join(q.dir, 'off-board', 'harness')) ? readdirSync(join(q.dir, 'off-board', 'harness')).filter(n => n.endsWith('.md')).sort() : []);

// Asked as the timer does until the gate has a verdict: merged, red, or waiting for master.
async function verdict(q, key, ms = 120_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const r = await q.step(key);
    if (!(r.code === 0 && r.out.waiting && !r.out['master-red'])) return r;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error(`${key}: the gate never finished`);
}

test('ASS-394 AC1/AC4: a failing test that passes when run again is a flake — the gate passes and merges, nothing raised', { timeout: 180_000 }, async t => {
  const q = queue(t);
  asHarness(q);
  const flag = join(q.dir, 'flaked');
  const ran = nodeTests(q, {
    'flaky.test.js': `test('flaky once', () => { if (!existsSync(${JSON.stringify(flag)})) { writeFileSync(${JSON.stringify(flag)}, ''); throw new Error('a race'); } });`,
    'fine.test.js': "test('fine', () => {});",
  });
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  const r = await verdict(q, 'ABC-3');
  assert.deepEqual([r.code, r.out.merged], [0, true], r.err);
  assert.ok(q.onMain('three.txt'));
  const log = q.read('work', 'ABC-3', 'merge-gate-A.log');
  assert.match(log, /the failing tests run again: node --test --test-force-exit t\/flaky\.test\.js/);
  assert.match(log, /pass when run again: a flake/);
  assert.equal(ran().length, 3);                                   // both files, then the flaky one alone; never master
  assert.deepEqual(tickets(q), []);
  assert.equal(q.read('master-test-failures.json'), '');
  assert.equal(await q.idle(), '');
});

test('ASS-394 AC2/AC4: a test failing again and on master too is master\'s — no exit (no visit, nothing back to Build), the ticket waits for master; raised once in the harness backlog, never twice for the same test; once master moves the gate runs again', { timeout: 300_000 }, async t => {
  const q = queue(t);
  asHarness(q);
  const broken = join(q.dir, 'master-broken');
  writeFileSync(broken, '');
  const ran = nodeTests(q, {
    'racy.test.js': `test('racy on master', () => { if (existsSync(${JSON.stringify(broken)})) throw new Error('a race'); });`,
    'fine.test.js': "test('fine', () => {});",
  });
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  q.branch('change/ABC-4-1', 'four.txt', '4\n');
  const main = git(q.origin, 'rev-parse', 'main');

  const three = await verdict(q, 'ABC-3');
  assert.deepEqual(three, { code: 0, out: { waiting: true, behind: null, 'master-red': true, tests: ['t/racy.test.js: racy on master'], tickets: ['ASS-1'] } });
  assert.equal(q.onMain('three.txt'), false);
  assert.equal(git(q.origin, 'rev-parse', 'main'), main);
  assert.doesNotMatch(q.read('work', 'ABC-3', 'execution-plan-A.md'), /merge gate/);   // not sent back to Build
  assert.match(q.variation('ABC-3')['ai-feedback-short'], /^waiting for master: .*ASS-1/);
  const runs = ran();
  assert.equal(runs.length, 4);                                    // both files, the racy one again, then on master
  assert.notEqual(runs[3], runs[2]);                               // master's run in a checkout of its own
  assert.deepEqual(tickets(q), ['ASS-1.md']);
  const raised = readFileSync(join(q.dir, 'off-board', 'harness', 'ASS-1.md'), 'utf8');
  assert.match(raised, /^type: Bug$/m);
  assert.match(raised, /^# Fails on master: t\/racy\.test\.js: racy on master$/m);
  assert.match(raised, /## Acceptance criteria\n\n1\. AC1: t\/racy\.test\.js: racy on master passes on master/);
  assert.equal(JSON.parse(q.read('master-test-failures.json'))['t/racy.test.js: racy on master'].ticket, 'ASS-1');

  // Asked again with master where it was: still waiting, the gate not run again.
  assert.deepEqual((await q.step('ABC-3')).out['master-red'], true);
  assert.equal(ran().length, 4);

  // Another ticket meets the same test: it waits too, and no second ticket is raised.
  const four = await verdict(q, 'ABC-4');
  assert.deepEqual([four.code, four.out['master-red'], four.out.tickets], [0, true, ['ASS-1']]);
  assert.deepEqual(tickets(q), ['ASS-1.md']);

  // Master fixed and moved on: the waiting ticket's gate runs again, and merges.
  rmSync(broken);
  q.commit('main.txt', 'fixed\n', 'master fixed'); git(q.ws, 'push', '-q', 'origin', 'main');
  const again = await verdict(q, 'ABC-3');
  assert.deepEqual([again.code, again.out.merged], [0, true], again.err);
  assert.ok(q.onMain('three.txt'));
  assert.equal(existsSync(join(q.f.dir, 'projects', 'p', 'work', 'ABC-3', 'merge-gate-wait-A.json')), false);
  assert.equal(await q.idle(), '');
});

test('ASS-394 AC3/AC4: a test failing again that passes on master is the ticket\'s — red (exit 2, back to Build) as before, nothing raised', { timeout: 180_000 }, async t => {
  const q = queue(t);
  asHarness(q);
  const ran = nodeTests(q, {
    'real.test.js': "test('the branch breaks it', () => { if (existsSync('broken')) throw new Error('broken'); });",
  });
  q.branch('change/ABC-3-1', 'broken', 'x\n');
  const head = git(q.origin, 'rev-parse', 'change/ABC-3-1');
  const r = await verdict(q, 'ABC-3');
  assert.equal(r.code, 2);
  assert.match(r.err, /fails on change\/ABC-3-1 rebased onto main .*not on master: t\/real\.test\.js: the branch breaks it/);
  assert.equal(git(q.origin, 'rev-parse', 'change/ABC-3-1'), head);
  assert.equal(q.onMain('broken'), false);
  assert.match(q.read('work', 'ABC-3', 'execution-plan-A.md'), /the merge gate sent it back to Build/);
  assert.equal(ran().length, 3);                                   // on the branch, again, and on master
  assert.deepEqual(tickets(q), []);
  assert.equal(q.read('master-test-failures.json'), '');
  assert.equal(await q.idle(), '');
});
