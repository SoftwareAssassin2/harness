// harness:request-restart and harness:restarted — the self-healing engine's
// way to have the harness restart on the fixed code: a request in
// $HARNESS_HOME naming the control that must go, and the check that a
// different control runs since.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fixture, run, AGENT, STAMP } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

// Controls are judged by their pidfiles' processes being alive (ASS-140), so
// each control here is a live process; DEAD is one that has ended.
const children = [];
const live = () => { const c = spawn('sleep', ['300'], { stdio: 'ignore' }); children.push(c); return c.pid; };
const DEAD = spawnSync('true').pid;
after(() => { for (const c of children) c.kill('SIGKILL'); });

// The fixture with its own HARNESS_HOME, where run.pid names `pid` as the control running.
function home(pid) {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'harness-home-'));
  if (pid != null) writeFileSync(join(dir, 'run.pid'), `${pid}\n`);
  return { ...f, home: dir, agent: (...args) => run(AGENT, args, { env: { ...f.env, HARNESS_HOME: dir } }) };
}

test('harness:request-restart records the ticket, the time and the control running; harness:restarted is false until a different control runs, then true each time it is asked, the request kept and stamped', async () => {
  const [old, next] = [live(), live()];
  const f = home(old);
  const { stdout } = await f.agent('harness:request-restart', 'HD-1');
  const request = JSON.parse(stdout);
  assert.match(request.since, STAMP);
  assert.deepEqual(request, { tickets: ['HD-1'], since: request.since, 'control-pids': [old] });
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'restart-requested.json'), 'utf8')), request);
  await fails(f.agent('harness:restarted', 'HD-1'), new RegExp(`harness:restarted: not yet — control ${old} still runs`));            // the same control
  writeFileSync(join(f.home, 'run.pid'), `${next}\n`);
  for (let i = 0; i < 2; i++) assert.deepEqual(JSON.parse((await f.agent('harness:restarted', 'HD-1')).stdout), { ticket: 'HD-1', restarted: true, 'control-pids': [next] });
  const kept = JSON.parse(readFileSync(join(f.home, 'restart-requested.json'), 'utf8'));
  assert.match(kept['restarted-at'], STAMP);
  assert.deepEqual(kept, { ...request, restarted: true, 'restarted-at': kept['restarted-at'] });
  await fails(f.agent('harness:restarted', 'HD-2'), /harness:restarted: no restart was requested for HD-2/);
});

// ASS-210: a second request while the first is pending joins it rather than
// replacing it; one after the restart starts afresh, carrying the restarted
// tickets forward one generation.
test('ASS-210: two requests before one restart are one request, and both tickets are told true after it, whichever asks first', async () => {
  const [old, next] = [live(), live()];
  const f = home(old);
  const first = JSON.parse((await f.agent('harness:request-restart', 'A-1')).stdout);
  await f.agent('harness:request-restart', 'B-2');
  const joined = JSON.parse((await f.agent('harness:request-restart', 'A-1')).stdout);              // deduped
  assert.deepEqual(joined, { tickets: ['A-1', 'B-2'], since: first.since, 'control-pids': [old] });
  writeFileSync(join(f.home, 'run.pid'), `${next}\n`);
  assert.equal(JSON.parse((await f.agent('harness:restarted', 'B-2')).stdout).ticket, 'B-2');
  assert.equal(JSON.parse((await f.agent('harness:restarted', 'A-1')).stdout).restarted, true);
});

test('ASS-210: a request after the restart is a fresh one, not yet; the restarted tickets carried forward in restarted-before are still true', async () => {
  const [old, next, last] = [live(), live(), live()];
  const f = home(old);
  await f.agent('harness:request-restart', 'A-1');
  await f.agent('harness:request-restart', 'B-2');
  writeFileSync(join(f.home, 'run.pid'), `${next}\n`);
  await f.agent('harness:restarted', 'A-1');                                                       // B-2 has not asked yet
  const fresh = JSON.parse((await f.agent('harness:request-restart', 'C-3')).stdout);
  assert.deepEqual(fresh, { tickets: ['C-3'], since: fresh.since, 'control-pids': [next], 'restarted-before': ['A-1', 'B-2'] });
  await fails(f.agent('harness:restarted', 'C-3'), new RegExp(`not yet — control ${next} still runs`));
  assert.equal(JSON.parse((await f.agent('harness:restarted', 'B-2')).stdout).restarted, true);
  assert.equal(JSON.parse((await f.agent('harness:restarted', 'A-1')).stdout).restarted, true);
  writeFileSync(join(f.home, 'run.pid'), `${last}\n`);
  await f.agent('harness:restarted', 'C-3');
  assert.deepEqual(JSON.parse((await f.agent('harness:request-restart', 'D-4')).stdout)['restarted-before'], ['C-3']);   // one generation
  await fails(f.agent('harness:restarted', 'A-1'), /no restart was requested for A-1/);
});

test('ASS-210: an old-shape request, a singular ticket and control-pid, is read as a one-ticket list, and joined', async () => {
  const [old, next] = [live(), live()];
  const f = home(old);
  writeFileSync(join(f.home, 'restart-requested.json'), JSON.stringify({ ticket: 'HD-1', since: '2026-10-11T22:00:00Z', 'control-pid': old }));
  await fails(f.agent('harness:restarted', 'HD-1'), new RegExp(`not yet — control ${old} still runs`));
  writeFileSync(join(f.home, 'run.pid'), `${next}\n`);
  assert.deepEqual(JSON.parse((await f.agent('harness:restarted', 'HD-1')).stdout), { ticket: 'HD-1', restarted: true, 'control-pids': [next] });
  const g = home(old);
  writeFileSync(join(g.home, 'restart-requested.json'), JSON.stringify({ ticket: 'HD-1', since: '2026-10-11T22:00:00Z', 'control-pids': [old] }));
  assert.deepEqual(JSON.parse((await g.agent('harness:request-restart', 'HD-2')).stdout), { tickets: ['HD-1', 'HD-2'], since: '2026-10-11T22:00:00Z', 'control-pids': [old] });
});

test('harness:request-restart with no control running records a null pid, and any control counts as restarted; another ticket\'s request is not this one\'s', async () => {
  const f = home(null);
  assert.deepEqual(JSON.parse((await f.agent('harness:request-restart', 'HD-2')).stdout)['control-pids'], []);
  await fails(f.agent('harness:restarted', 'HD-2'), /not yet — no control runs/);
  await fails(f.agent('harness:restarted', 'HD-9'), /no restart was requested for HD-9/);
  writeFileSync(join(f.home, 'run.pid'), `${live()}\n`);
  assert.equal(JSON.parse((await f.agent('harness:restarted', 'HD-2')).stdout).restarted, true);
  await fails(f.agent('harness:request-restart'), /usage: harness:request-restart <ticket-key>/);
});

test('with a control per project, the request names every control running; restarted once none of them still runs', async () => {
  const f = home(null);
  const [example, harness, harness2, example2] = [live(), live(), live(), live()];
  writeFileSync(join(f.home, 'run-example.pid'), `${example}\n`);
  writeFileSync(join(f.home, 'run-harness.pid'), `${harness}\n`);
  assert.deepEqual(JSON.parse((await f.agent('harness:request-restart', 'ASS-8')).stdout)['control-pids'], [example, harness].sort((a, b) => a - b));
  writeFileSync(join(f.home, 'run-harness.pid'), `${harness2}\n`);                                  // one restarted, the other not yet
  await fails(f.agent('harness:restarted', 'ASS-8'), new RegExp(`not yet — control ${example} still runs`));
  writeFileSync(join(f.home, 'run-example.pid'), `${example2}\n`);
  assert.deepEqual(JSON.parse((await f.agent('harness:restarted', 'ASS-8')).stdout)['control-pids'], [example2, harness2].sort((a, b) => a - b));
});

// A control that died without removing its pidfile is not running (ASS-140):
// a request names only live controls, and a named control that died counts as
// gone, so a stale pidfile for a project whose control never comes back can't
// hold Await the Restart forever.
test('ASS-140: a pidfile naming a dead process counts as no control, in the request and in the check', async () => {
  const f = home(null);
  const [example, harness, harness2] = [live(), live(), live()];
  writeFileSync(join(f.home, 'run-example.pid'), `${example}\n`);
  writeFileSync(join(f.home, 'run-harness.pid'), `${harness}\n`);
  writeFileSync(join(f.home, 'run-old.pid'), `${DEAD}\n`);
  assert.deepEqual(JSON.parse((await f.agent('harness:request-restart', 'ASS-9')).stdout)['control-pids'], [example, harness].sort((a, b) => a - b));
  writeFileSync(join(f.home, 'run-harness.pid'), `${harness2}\n`);
  writeFileSync(join(f.home, 'run-example.pid'), `${DEAD}\n`);                              // example's control died, its pidfile left
  assert.deepEqual(JSON.parse((await f.agent('harness:restarted', 'ASS-9')).stdout)['control-pids'], [harness2]);
  const g = home(DEAD);
  await g.agent('harness:request-restart', 'ASS-10');
  assert.deepEqual(JSON.parse(readFileSync(join(g.home, 'restart-requested.json'), 'utf8'))['control-pids'], []);
  await fails(g.agent('harness:restarted', 'ASS-10'), /not yet — no control runs/);
});

// ASS-255: Await the Restart (grouped-release-harness) waits on exit 1, its
// waiting-exit-code, so 1 is only ever "not yet"; a ticket no request names
// waits on nothing, which is an error (2), still failing the step.
test('ASS-255: harness:restarted exits 1 only while the restart is pending — a requested control still runs, or none does — and 2 when no restart was requested for the ticket', async () => {
  const code = promise => promise.then(() => 0, e => e.code);
  const [old, next] = [live(), live()];
  const f = home(old);
  await f.agent('harness:request-restart', 'HD-1');
  assert.equal(await code(f.agent('harness:restarted', 'HD-1')), 1);                              // control old still runs
  writeFileSync(join(f.home, 'run.pid'), `${DEAD}\n`);
  assert.equal(await code(f.agent('harness:restarted', 'HD-1')), 1);                              // no control runs
  assert.equal(await code(f.agent('harness:restarted', 'HD-9')), 2);
  await fails(f.agent('harness:restarted', 'HD-9'), /no restart was requested for HD-9/);
  writeFileSync(join(f.home, 'run.pid'), `${next}\n`);
  assert.equal(await code(f.agent('harness:restarted', 'HD-1')), 0);
  assert.equal(await code(home(old).agent('harness:restarted', 'HD-1')), 2);                     // no request at all
});
