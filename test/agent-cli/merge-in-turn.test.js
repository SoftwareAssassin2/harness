// ASS-197 — merge-request:merge-in-turn, Release's Merge Pull Request on the
// harness: one ticket of a project merges at a time (the merge lock, a flock
// on data/projects/<p>/merge.lock), its branch first rebased onto the latest
// main and the project's full tests run on it, in the background, the step
// asked again on its timer; red sends it back (exit 2) with nothing merged.
// A real workspace: a clone of a bare origin; gh a fake that merges into it
// (merge-in-turn-fixture.js, which kills every process a test starts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, behind: 'ABC-3' } });     // its own gate, started in the background
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

test('ASS-197 AC1: while another ticket holds the project\'s merge lock, the step waits — "waiting to merge behind <key>" on the board, nothing rebased, tested or merged — and goes on once it is free', async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  const holder = await q.hold('ABC-4');
  try {
    for (let i = 0; i < 2; i++) assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, behind: 'ABC-4' } });
    assert.equal(q.variation('ABC-3')['ai-feedback-short'], 'waiting to merge behind ABC-4');
    assert.equal(existsSync(q.runs), false);
    assert.equal(q.onMain('three.txt'), false);
  } finally { holder.kill(); }
  await exited(holder);
  assert.equal((await q.settle('ABC-3')).out.merged, true);
});

// ASS-257: it once waited only ~10 s for the gate to reach its full tests; under
// load (npm test and other builders' runs at once) the gate took longer, the
// test failed with the full tests still hanging, and that gate hung on for good.
// Now its waits are bounded by its own time limit, and whatever ends it, the
// fixture lifts the hang and kills every gate's process group.
test('ASS-197 AC3: a holder that crashes leaves no lock behind — the kernel drops it — so the next ticket takes it, its stale holder record overwritten; a gate killed mid-run is simply run again', { timeout: 180_000 }, async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\n');
  const holder = await q.hold('ABC-4');
  holder.kill('SIGKILL');                                                                    // crashed: merge-lock.json still names ABC-4
  await exited(holder);
  assert.match(q.read('merge-lock.json'), /ABC-4/);
  q.slow(true);                                                                              // the full tests hang…
  assert.deepEqual(await q.step('ABC-3'), { code: 0, out: { waiting: true, behind: 'ABC-3' } });
  let gate;
  await q.until(() => (gate = q.read('merge-lock.json').match(/"ticket": "ABC-3"[\s\S]*"pid": (\d+)/)) && q.groups().length > 0, 'the gate running its full tests');
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
test('ASS-257 AC2: a merge-queue test that passes, fails or runs past its time limit with a gate hanging in its full tests leaves no process behind', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mit-end-'));
  const fixtureModule = new URL('./merge-in-turn-fixture.js', import.meta.url).href;
  for (const ending of ['passes', 'fails', 'times out']) {
    const out = join(dir, `${ending.replace(' ', '-')}.json`), file = join(dir, `${ending.replace(' ', '-')}.test.js`);
    writeFileSync(file, `import { test } from 'node:test';
import { writeFileSync, existsSync } from 'node:fs';
import { queue } from ${JSON.stringify(fixtureModule)};
test('a gate left hanging', { timeout: 15_000 }, async t => {
  const q = queue(t);
  q.branch('change/ABC-3-1', 'three.txt', '3\\n');
  q.slow(true);
  await q.step('ABC-3');
  await q.until(() => q.groups().length > 0 && existsSync(q.runs), 'the gate in its full tests', 12_000);
  writeFileSync(${JSON.stringify(out)}, JSON.stringify(q.groups()));
  ${ending === 'fails' ? "throw new Error('fails');" : ending === 'times out' ? 'await new Promise(() => {});' : ''}
});
`);
    const { NODE_TEST_CONTEXT, ...env } = process.env;                                    // a run of its own, not a part of this one
    const r = await run(process.execPath, ['--test', '--test-force-exit', file], { env, timeout: 60_000 }).then(() => 0, e => e.code);
    assert.equal(r, ending === 'passes' ? 0 : 1, ending);
    const groups = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(groups.length > 0 && groups.every(g => g > 1), ending);
    const alive = g => { try { process.kill(-g, 0); return true; } catch { return false; } };
    for (let i = 0; groups.some(alive) && i < 50; i++) await new Promise(res => setTimeout(res, 100));
    assert.deepEqual(groups.filter(alive), [], `${ending}: the gate's processes are gone`);
  }
});

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
  return command.replaceAll('"$workspace"', JSON.stringify(workspace)).replaceAll('$main', main).replaceAll('$branch', branch);
};

// Where that fetch writes what it fetches: its <from>:<to> refspec pairs.
const fetched = command => [...command.replaceAll('"', '').matchAll(/\+?(refs\/heads\/\S+?):(\S+)/g)].map(m => ({ from: m[1], to: m[2] }));

test('ASS-318 AC1: the gate\'s fetch of main and the branch survives a plain `git fetch origin` at the same time in the same workspace — it no longer races the shared tracking refs, so a green branch is not sent to Blocked', { timeout: 300_000 }, async t => {
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
