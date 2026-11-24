// ASS-197 — merge-request:merge-in-turn, Release's Merge Pull Request on the
// harness: a ticket's branch first rebased onto the latest main and the
// project's full tests run on it, in the background, the step asked again on
// its timer; red sends it back (exit 2) with nothing merged. ASS-560: tickets
// of a project merge at the same time (no project-wide lock or turn), each
// variation's own pull requests one at a time in their planned order (its own
// lock, work/<KEY>/merge-gate-<variation>.lock); main moved under a gate
// (another ticket merged first) is base-moved: rebased and tested again.
// A real workspace: a clone of a bare origin; gh a fake that merges into it
// (merge-in-turn-fixture.js, which kills every process a test starts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from '../support/until.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './harness-fixture.js';
import { queue, git, exited, ID } from './merge-in-turn-fixture.js';

test('ASS-197 AC2/AC4: two tickets cut from an older main merge one after the other, each rebased onto the latest main (the other\'s merge in it) and its full tests run there first — the merged head is the one tested; the lock is free after each', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  q.branch('change/ABC-4-1', 'four.txt', '4\n');
  q.commit('main.txt', 'moved on\n', 'main moves on'); git(q.ws, 'push', '-q', 'origin', 'main');
  assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, running: true } });     // its own gate, started in the background
  assert.equal(q.variation('ABC-3')['ai-feedback-short'], 'merging: rebasing onto main and running the full tests');
  const three = await q.settle('ABC-3');
  assert.deepEqual([three.code, three.out.merged, three.out.branch], [0, true, 'change/ABC-3-1']);
  assert.equal(git(q.origin, 'rev-parse', 'main^2'), three.out.tested);                       // what merged is what was tested…
  git(q.origin, 'merge-base', '--is-ancestor', 'main^1', three.out.tested);                   // …rebased onto main as it was (throws if not)
  assert.ok(q.onMain('main.txt') && q.onMain('three.txt'));
  assert.equal(q.variation('ABC-3')['merge-request'][0].status, 'Merged');
  const four = await q.settle('ABC-4');
  assert.deepEqual([four.code, four.out.merged], [0, true]);
  assert.ok(q.onMain('three.txt') && q.onMain('four.txt'));
  git(q.origin, 'merge-base', '--is-ancestor', 'main^1', four.out.tested);                    // ABC-4 tested on top of ABC-3's merge
  assert.equal(readFileSync(q.runs, 'utf8').trim().split('\n').length, 2);                   // the full tests ran once for each
  assert.equal(await q.idle(), '');                                               // no holder left
  assert.deepEqual(q.ghLog().filter(l => l.startsWith('pr merge')).map(l => l.split(' ')[2]), ['3', '4']);
});

// ASS-560 AC1 (was ASS-197 AC1, a project-wide turn): another ticket's merge gate running holds nothing of this one's.
test('ASS-560 AC1: another ticket\'s gate holding its own merge-gate lock does not hold this ticket — it rebases, tests and merges at once; nothing project-wide is locked', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  const holder = await q.hold('ABC-4');                                                       // ABC-4's gate, mid-run
  try {
    assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, running: true } });
    const three = await q.settle('ABC-3');
    assert.deepEqual([three.code, three.out.merged], [0, true]);
    assert.ok(q.onMain('three.txt'));
    assert.equal(existsSync(join(q.f.dir, 'projects', 'p', 'merge.lock')), false);              // no project-wide lock…
    assert.equal(existsSync(join(q.f.dir, 'projects', 'p', 'merge-lock.json')), false);         // …nor its holder record
  } finally { holder.kill(); }
  await exited(holder);
});

// ASS-560 AC1: two tickets' gates run at once — both in their full tests at the same moment — and both merge. The
// one whose main moved under it (the other merged first) is rebased and tested again (base-moved, as the engine asks
// it again), so each merged head is one tested on top of the other's merge.
test('ASS-560 AC1/AC2: two tickets of one project merge concurrently — both gates in their full tests at the same time — and both land, the later one rebased onto the earlier one\'s merge and tested again', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  q.branch('change/ABC-4-1', 'four.txt', '4\n');
  q.slow(true);
  assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, running: true } });
  assert.deepEqual(await q.step('ABC-4'), { code: 0, out: { waiting: true, running: true } });   // not behind ABC-3: its own gate
  await q.until(() => q.groups().length === 2, 'both gates in their full tests at once');
  q.slow(false);
  const [three, four] = await Promise.all([q.settleMoving('ABC-3'), q.settleMoving('ABC-4')]);
  assert.deepEqual([three.code, three.out.merged, four.code, four.out.merged], [0, true, 0, true]);
  assert.ok(q.onMain('three.txt') && q.onMain('four.txt'));
  assert.ok(three.moved + four.moved >= 1, 'the later one saw main move under it');           // both tested on the same main: one had to rebase (the forge refuses one out of date)
  const runs = readFileSync(q.runs, 'utf8').trim().split('\n').length;
  assert.equal(runs, 2 + three.moved + four.moved);                                           // the full tests again after each move
  const last = git(q.origin, 'rev-parse', 'main^2');                                          // the later merge's head: tested on top of the earlier merge
  assert.ok([three.out.tested, four.out.tested].includes(last));
  git(q.origin, 'merge-base', '--is-ancestor', 'main^1', last);
  assert.equal(await q.idle(), '');
});

// ASS-560 AC1: a ticket's own pull requests keep their planned order — the gate takes them one at a time, each after
// those it depends on, each rebased onto main with the one before it merged, tested, then merged.
test('ASS-560 AC1: one ticket\'s three pull requests (#5 ← #6 ← #7, stacked) merge in their planned order, each rebased onto main after the one before it merged and tested there; the dependents are retargeted to main', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'lib.txt', 'lib\n');
  git(q.ws, 'checkout', '-q', '-b', 'change/ABC-3-2', 'change/ABC-3-1'); q.commit('api.txt', 'api\n', 'api'); git(q.ws, 'push', '-q', 'origin', 'change/ABC-3-2');
  git(q.ws, 'checkout', '-q', '-b', 'change/ABC-3-3', 'change/ABC-3-2'); q.commit('app.txt', 'app\n', 'app'); git(q.ws, 'push', '-q', 'origin', 'change/ABC-3-3');
  git(q.ws, 'checkout', '-q', 'main');
  q.commit('main.txt', 'moved on\n', 'main moves on'); git(q.ws, 'push', '-q', 'origin', 'main');
  // Planned last first, so the order is the plan's depends-on, not the rows'.
  q.plan('ABC-3', [{ n: 7, id: 3, branch: 'change/ABC-3-3', base: 'change/ABC-3-2', dependsOn: [2] }, { n: 6, id: 2, branch: 'change/ABC-3-2', base: 'change/ABC-3-1', dependsOn: [1] }, { n: 5, id: 1, branch: 'change/ABC-3-1' }]);
  const r = await q.settle('ABC-3');
  assert.deepEqual([r.code, r.out.merged], [0, true], JSON.stringify(r));
  assert.deepEqual(q.ghLog().filter(l => l.startsWith('pr merge')).map(l => l.split(' ')[2]), ['5', '6', '7']);
  assert.deepEqual(r.out['merge-requests'].map(m => m.branch), ['change/ABC-3-1', 'change/ABC-3-2', 'change/ABC-3-3']);
  assert.deepEqual(q.variation('ABC-3')['merge-request'].map(m => m.status), ['Merged', 'Merged', 'Merged']);
  assert.ok(['main.txt', 'lib.txt', 'api.txt', 'app.txt'].every(q.onMain));
  // Each tested head sits on main with the one before it merged: #6's on #5's merge, #7's on #6's.
  const merges = git(q.origin, 'rev-list', '--first-parent', 'main').split('\n').slice(0, 3).reverse();   // #5's, #6's, #7's merge commits
  r.out['merge-requests'].forEach((m, i) => {
    assert.equal(git(q.origin, 'rev-parse', `${merges[i]}^2`), m.tested, m.branch);
    if (i > 0) git(q.origin, 'merge-base', '--is-ancestor', merges[i - 1], m.tested);           // throws if not
  });
  assert.equal(readFileSync(q.runs, 'utf8').trim().split('\n').length, 3);                     // the full tests once for each
  assert.ok(q.ghLog().some(l => /^pr edit 6 .*--base main/.test(l)) && q.ghLog().some(l => /^pr edit 7 .*--base main/.test(l)));
  assert.equal(await q.idle(), '');
});

// ASS-560 AC1: a dependent is never merged before what it depends on — red on the first, nothing after it merges.
test('ASS-560 AC1: red on a ticket\'s first pull request merges none of those that depend on it', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'broken', 'x\n');
  q.branch('change/ABC-3-2', 'two.txt', '2\n');
  q.plan('ABC-3', [{ n: 6, id: 2, branch: 'change/ABC-3-2', base: 'change/ABC-3-1', dependsOn: [1] }, { n: 5, id: 1, branch: 'change/ABC-3-1' }]);
  const r = await q.settle('ABC-3');
  assert.equal(r.code, 2);
  assert.equal(q.ghLog().some(l => l.startsWith('pr merge')), false);
  assert.equal(q.onMain('two.txt'), false);
  assert.equal(await q.idle(), '');
});

// ASS-560 AC6: the harness's own pre-merge rebase and full tests, per ticket: main moving during the run (another
// ticket landed) means what was tested is not what would merge — so nothing is pushed or merged, the step says
// base-moved (exit 0: the engine's way back into Merge Pull Request, a visit), and the next ask rebases onto the new
// main and runs the tests again before it merges.
test('ASS-560 AC2/AC6: main moving while the gate runs its full tests — another ticket landed — says base-moved with nothing pushed or merged, saying why; asked again, it rebases onto the new main, runs the tests again and merges that', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  const head = git(q.origin, 'rev-parse', 'change/ABC-3-1');
  q.slow(true);
  await q.step('ABC-3');
  await q.until(() => q.groups().length > 0, 'the gate in its full tests');
  q.commit('landed.txt', 'another ticket\n', 'another ticket lands'); git(q.ws, 'push', '-q', 'origin', 'main');
  const now = git(q.origin, 'rev-parse', 'main');
  q.slow(false);
  const moved = await q.settle('ABC-3');
  assert.deepEqual([moved.code, moved.out['base-moved'], moved.out.waiting], [0, true, true], JSON.stringify(moved));   // waiting too: an engine without the exit never reads it as merged
  assert.equal(q.variation('ABC-3')['ai-feedback-short'], moved.out['ai-feedback-short']);
  assert.match(moved.out['ai-feedback-long'], /main moved from \w+ to \w+ on origin while the gate ran \(before change\/ABC-3-1 was pushed\) — another ticket merged first/);
  assert.deepEqual([moved.out['base-moved'], moved.out.now], [true, now]);
  assert.match(moved.out['ai-feedback-short'], /merge gate: main moved while it ran \(another ticket merged first\); rebasing and testing again/);
  assert.match(moved.out['ai-feedback-long'], /max-visits/);
  assert.deepEqual([git(q.origin, 'rev-parse', 'change/ABC-3-1'), git(q.origin, 'rev-parse', 'main')], [head, now]);   // nothing pushed or merged
  assert.equal(q.ghLog().some(l => l.startsWith('pr merge')), false);
  const merged = await q.settle('ABC-3');                                                       // the engine's base-moved exit: the step again
  assert.deepEqual([merged.code, merged.out.merged, merged.out['ai-feedback-short']], [0, true, null]);   // null: nothing stale left to say
  assert.equal(readFileSync(q.runs, 'utf8').trim().split('\n').length, 2);                     // the full tests ran again…
  git(q.origin, 'merge-base', '--is-ancestor', now, merged.out.tested);                        // …on the new main, and that is what merged
  assert.equal(git(q.origin, 'rev-parse', 'main^2'), merged.out.tested);
  assert.equal(await q.idle(), '');
});

// ASS-560 AC2: a merge the forge refuses because main moved meanwhile is the same base move, not a failure (to Blocked).
test('ASS-560 AC2: a merge refused after main moved (another ticket landed between the check and the merge) is a base move, not a failure (exit 1)', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  // The forge moves main and refuses, as a non-fast-forward would be refused.
  const gh = join(q.dir, 'bin', 'gh');
  writeFileSync(gh, readFileSync(gh, 'utf8').replace('"pr merge") ', `"pr merge") w="$(mktemp -d)"; git clone -q ${JSON.stringify(q.origin)} "$w" && echo x > "$w/race.txt" && git -C "$w" add . && git -C "$w" -c user.name=T -c user.email=t@example.com commit -qm race && git -C "$w" push -q origin main; exit 1 ;;
  "pr merge-unused") `));
  const r = await q.settle('ABC-3');
  assert.deepEqual([r.code, r.out['base-moved']], [0, true], JSON.stringify(r));
  assert.match(r.out['ai-feedback-long'], /the merge of change\/ABC-3-1 refused/);
});

// ASS-257: it once waited only ~10 s for the gate to reach its full tests; under
// load (npm test and other builders' runs at once) the gate took longer, the
// test failed with the full tests still hanging, and that gate hung on for good.
// Now its waits are bounded by its own time limit, and whatever ends it, the
// fixture lifts the hang and kills every gate's process group.
// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard; a fixed one a loaded Mac outlasts.
test('ASS-197 AC3 (ASS-560: the variation\'s own lock): a holder that crashes leaves no lock behind — the kernel drops it — so the next ask takes it, its stale holder record overwritten; a gate killed mid-run is simply run again', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  const holder = await q.hold('ABC-3');
  assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, running: true } });   // its own gate running: one at a time
  assert.equal(q.variation('ABC-3')['ai-feedback-short'], 'merging: rebasing onto main and running the full tests');
  holder.kill('SIGKILL');                                                                    // crashed: its holder record still says pid 1
  await exited(holder);
  assert.match(q.readHolder('ABC-3'), /"pid": ?1\b/);
  q.slow(true);                                                                              // the full tests hang…
  assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, running: true } });
  let gate;
  await q.until(() => (gate = q.readHolder('ABC-3').match(/"ticket": "ABC-3"[\s\S]*"pid": (\d+)/)) && Number(gate[1]) > 1 && q.groups().length > 0, 'the gate running its full tests');
  assert.deepEqual(q.groups(), [Number(gate[1])]);                                           // the gate is its tests' process group
  process.kill(Number(gate[1]), 'SIGKILL');                                                  // …and its gate crashes mid-run
  q.slow(false);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(q.onMain('three.txt'), false);
  const again = await q.settle('ABC-3');                                                     // asked again: the lock is free, so the gate runs afresh
  assert.equal(again.out.merged, true);
  assert.ok(q.onMain('three.txt'));
  assert.equal(readFileSync(q.runs, 'utf8').trim().split('\n').length, 2);
  assert.equal(await q.idle(), '');                                                          // the second gate has ended, no holder left
});

test('ASS-197 AC2: red — the full tests fail on the rebased branch — exits 2 with nothing merged or pushed, the reason in execution-plan.md and the tests\' output kept; the lock is free', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'broken', 'x\n');
  q.commit('main.txt', 'moved on\n', 'main moves on'); git(q.ws, 'push', '-q', 'origin', 'main');
  const head = git(q.origin, 'rev-parse', 'change/ABC-3-1'), main = git(q.origin, 'rev-parse', 'main');
  await q.step('ABC-3');
  const red = await q.settle('ABC-3');
  assert.equal(red.code, 2);
  assert.match(red.err, /\.\/check\.sh fails on change\/ABC-3-1 rebased onto main/);
  assert.deepEqual([git(q.origin, 'rev-parse', 'change/ABC-3-1'), git(q.origin, 'rev-parse', 'main')], [head, main]);
  assert.equal(q.ghLog().some(l => l.startsWith('pr merge')), false);
  assert.match(q.read('work', 'ABC-3', 'execution-plan-A.md'), /merge gate.*\.\/check\.sh fails on change\/ABC-3-1 rebased onto main.*merge-gate-A\.log/);
  assert.ok(existsSync(join(q.f.dir, 'projects', 'p', 'work', 'ABC-3', 'merge-gate-A.log')));
  assert.equal(await q.idle(), '');
});

test('ASS-197 AC2: red — the branch does not rebase onto main — exits 2 naming the conflicting files, nothing tested, merged or pushed', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'README.md', 'mine\n');
  q.commit('README.md', 'theirs\n', 'main moves on'); git(q.ws, 'push', '-q', 'origin', 'main');
  const head = git(q.origin, 'rev-parse', 'change/ABC-3-1');
  await q.step('ABC-3');
  const red = await q.settle('ABC-3');
  assert.equal(red.code, 2);
  assert.match(red.err, /change\/ABC-3-1 does not rebase onto main: conflicts in README\.md/);
  assert.equal(existsSync(q.runs), false);
  assert.equal(git(q.origin, 'rev-parse', 'change/ABC-3-1'), head);
  assert.match(q.read('work', 'ABC-3', 'execution-plan-A.md'), /conflicts in README\.md/);
});

test('ASS-197: a gate that cannot do its work (here, the branch is not on origin) fails the step (exit 1, to Blocked) saying why, nothing merged; the lock is free', async t => {
  const q = queue(t);
  const r = await q.settle('ABC-3');
  assert.equal(r.code, 1);
  assert.match(r.err, /could not fetch main and change\/ABC-3-1 from origin/);
  assert.equal(q.ghLog().some(l => l.startsWith('pr merge')), false);
  assert.equal(await q.idle(), '');
});

// ASS-257: a test of the merge queue that ends with a gate still running — its
// full tests hanging — however it ends (passing, failing, or past its time
// limit) leaves no process behind: every gate's process group is killed. Each
// ending is a child `node --test` run (as npm test runs it) of a test that
// starts a gate, leaves it hanging and records the gate's process group.
// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard; a fixed one a loaded Mac outlasts.
// ASS-549: the gate hangs on a hang file of this test's too (queue's `hang`), which the inner test's cleanup does not
// lift: lifting only the slow hang let the gate finish by itself, so the test passed with the kill switched off. Now
// a gate still hanging after the inner run can only be gone by the kill; the hang file is removed after the check (and a
// failure names what is left in the group).
test('ASS-257 AC2: a merge-queue test that passes, fails or runs past its time limit with a gate hanging in its full tests leaves no process behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mit-end-'));
  const fixtureModule = new URL('./merge-in-turn-fixture.js', import.meta.url).href;
  const hang = join(dir, 'hang');
  for (const ending of ['passes', 'fails', 'times out']) {
    const out = join(dir, `${ending.replace(' ', '-')}.json`), file = join(dir, `${ending.replace(' ', '-')}.test.js`);
    writeFileSync(file, `import { test } from 'node:test';
import { writeFileSync, existsSync } from 'node:fs';
import { queue } from ${JSON.stringify(fixtureModule)};
test('a gate left hanging', async t => {
  const q = queue(t, { hang: ${JSON.stringify(hang)} });
  q.branch('change/ABC-3-1', 'three.txt', '3\\n');
  q.slow(true);
  await q.step('ABC-3');
  await q.until(() => q.groups().length > 0 && existsSync(q.runs), 'the gate in its full tests');
  writeFileSync(${JSON.stringify(out)}, JSON.stringify(q.groups()));
  ${ending === 'fails' ? "throw new Error('fails');" : ending === 'times out' ? "await t.test('past its time limit', { timeout: 1000 }, () => new Promise(() => {}));" : ''}
});
`);
    writeFileSync(hang, '');
    try {
      const { NODE_TEST_CONTEXT, ...env } = process.env;                                  // a run of its own, not a part of this one
      // ASS-545: the time limit runs out in a subtest started once the gate hangs in its full tests — the test's own 15 s
      // limit, from its start, ran out before the gate got there on a loaded Mac; the 300 s here is a hang guard only.
      const r = await run(process.execPath, ['--test', '--test-force-exit', file], { env, timeout: 300_000 }).then(() => 0, e => e.code);
      assert.equal(r, ending === 'passes' ? 0 : 1, ending);
      const groups = JSON.parse(readFileSync(out, 'utf8'));
      assert.ok(groups.length > 0 && groups.every(g => g > 1), ending);
      // ASS-545: waited for (until(): LOADED_MS a hang guard only), not 5 s a loaded Mac's kills outlasted.
      await until(() => groups.every(g => living(g).length === 0)).catch(() => {});
      assert.deepEqual(groups.flatMap(living), [], `${ending}: the gate's processes are gone`);
    } finally { rmSync(hang, { force: true }); }
  }
});

// ASS-549 (ASS-257's leak): a test ending just as its step has started a gate — before the gate has written its pid
// into the holder record — still has that gate killed: the cleanup waits for the pid. Without the wait it found no
// gate to kill, and the gate ran on (here it would hang on the hang file, which the cleanup does not lift).
test('ASS-549 / ASS-257 AC2: a merge-queue test cleaned up the moment its gate starts — its pid not yet recorded — still leaves no process behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mit-start-')), hang = join(dir, 'hang');
  writeFileSync(hang, '');
  try {
    const q = queue(null, { hang });
    q.branch('change/ABC-3-1', 'three.txt', '3\n');
    assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, running: true } });
    q.cleanup();                                                                             // at once: the gate is still starting
    const pid = Number(q.readHolder('ABC-3').match(/"pid": (\d+)/)?.[1]);
    assert.ok(pid > 1, `the cleanup waited for the gate's pid: ${q.readHolder('ABC-3')}`);
    await until(() => living(pid).length === 0).catch(() => {});
    assert.deepEqual(living(pid), [], 'the gate and all it started are gone');
    assert.deepEqual(q.groups().flatMap(living), [], 'no gate is left in its full tests');
  } finally { rmSync(hang, { force: true }); }
});

// The live processes of process group g, as "<pid> <state> <command>" (zombies, exited and only not yet reaped, left out).
function living(g) {
  let ps;
  try { process.kill(-g, 0); } catch { return []; }                                          // no member at all
  try { ps = execFileSync('ps', ['-A', '-o', 'pgid=,pid=,stat=,command='], { encoding: 'utf8' }); } catch { return [`${g} ? (ps failed)`]; }
  return ps.split('\n').map(l => l.trim().split(/\s+/)).filter(([pgid, , stat]) => Number(pgid) === g && stat && !stat.startsWith('Z'))
    .map(([, pid, stat, ...command]) => `${pid} ${stat} ${command.join(' ')}`);
}

// ASS-318: the gate's fetch (merge-in-turn.sh:75) wrote the shared tracking
// refs refs/remotes/origin/<main|branch>, which the plain `git fetch origin`
// another ticket's start runs in the same workspace (code/create-branch.sh:20)
// writes too: the two raced for the same ref lock, git refused the gate's
// ("cannot lock ref ...: is at X but expected Y"), and the gate ended failed —
// exit 1, to Blocked — on a branch with nothing wrong with it (seen on
// ASS-315). The command below is read out of the script itself, so the race is
// run against whatever the gate really fetches, options and all, rather than
// against a copy of it that can drift. Note that naming refspecs on the
// command line is not enough on its own: git also updates the matching
// refs/remotes/origin/* opportunistically (its remote's refmap), and those
// updates race just the same.
const GATE = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'merge-request', 'merge-in-turn.sh');

// The gate's fetch as it runs it: the command from the script (continuation
// lines joined, its `|| ends failed ...` and fd-6 close dropped), with the
// workspace, main and the branch filled in.
const gateFetch = (workspace, main, branch) => {
  const lines = readFileSync(GATE, 'utf8').split('\n');
  const start = lines.findIndex(l => !/^\s*#/.test(l) && /\bgit\b.*\bfetch\b.*\borigin\b/.test(l));
  assert.ok(start >= 0, 'the gate fetches from origin in merge-in-turn.sh');
  let command = '';
  for (let i = start; i < lines.length; i++) {
    command += `${lines[i].replace(/\\$/, '')} `;
    if (!/\\$/.test(lines[i])) break;
  }
  command = command.split('||')[0].replaceAll('6>&-', '').trim();
  assert.match(command, /\$main[\s\S]*\$branch/, `the gate's fetch names main and the branch: ${command}`);
  return command.replaceAll('"$workspace"', JSON.stringify(workspace)).replaceAll('$ns', 'refs/merge-gate/ASS-318/A').replaceAll('$main', main).replaceAll('$branch', branch);
};

// Where that fetch writes what it fetches: its <from>:<to> refspec pairs.
const fetched = command => [...command.replaceAll('"', '').matchAll(/\+?(refs\/heads\/\S+?):(\S+)/g)].map(m => ({ from: m[1], to: m[2] }));

// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard; a fixed one a loaded Mac outlasts.
test('ASS-318 AC1: the gate\'s fetch of main and the branch survives a plain `git fetch origin` at the same time in the same workspace — it no longer races the shared tracking refs, so a green branch is not sent to Blocked', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mit-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git'), seed = join(dir, 'seed'), ws = join(dir, 'workspace');
  const branch = 'change/ASS-318-1';                                                           // a real ticket branch's shape: a slash in it
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', '--quiet', origin, seed], { stdio: 'ignore' });
  const commit = text => { writeFileSync(join(seed, 'f.txt'), `${text}\n`); git(seed, 'add', '.'); execFileSync('git', ['-C', seed, 'commit', '-q', '-m', text], { env: { ...process.env, ...ID } }); };
  commit('first'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', branch); commit('branch'); git(seed, 'push', '-q', 'origin', branch);
  execFileSync('git', ['clone', '--quiet', origin, ws], { stdio: 'ignore' });                  // the shared operator workspace
  const command = gateFetch(ws, 'main', branch);
  const refs = fetched(command);
  assert.equal(refs.length, 2, `the gate fetches main and the branch into refs of its own: ${command}`);
  // A command's exit and what it said; both are started before either is awaited, so they run at once.
  const started = cmd => {
    const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    return () => exited(child).then(() => ({ code: child.exitCode, err: err.trim() }));
  };
  const failures = [];
  for (let round = 1; round <= 40; round++) {                                                  // a real ref move every round: a no-op fetch cannot race
    git(seed, 'checkout', '-q', 'main'); commit(`main ${round}`); git(seed, 'push', '-q', 'origin', 'main');
    git(seed, 'checkout', '-q', branch); commit(`branch ${round}`); git(seed, 'push', '-q', 'origin', branch);
    const gate = started(command), other = started(`git -C ${JSON.stringify(ws)} fetch origin`);  // the gate's fetch, and another ticket's plain one
    const [result] = await Promise.all([gate(), other()]);
    if (result.code !== 0) failures.push(`round ${round}: exit ${result.code}: ${result.err}`);
  }
  assert.deepEqual(failures, [], `the gate's fetch failed in ${failures.length} of 40 rounds`);
  for (const { from, to } of refs) assert.equal(git(ws, 'rev-parse', to), git(origin, 'rev-parse', from), to);  // and it did advance the refs it fetched
});
