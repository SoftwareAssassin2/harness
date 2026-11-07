// The dashboard's shut-down (src/tui/shutdown.js): its children stopped and
// waited for, the stubborn killed, and every agent still alive killed too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shutDown, ender, stillNamed } from '../../src/tui/shutdown.js';

// A child that exits when stopped, after `ms` — or never, with ms null.
const child = (name, pid, ms) => {
  let done;
  const c = { name, pid, stopped: false, exited: new Promise(resolve => { done = resolve; }) };
  c.stop = () => { c.stopped = true; if (ms != null) setTimeout(done, ms); };
  return c;
};

test('shutDown stops every child and waits for them; an agent left alive afterwards is killed with its group', async () => {
  const control = child('control', 10, 5), downloader = child('downloader', 11, 1);
  const killed = [], said = [];
  const living = new Set([20]);                                               // 21 is already gone
  await shutDown({
    children: [control, downloader], agentPids: () => [20, 21, null], timeoutMs: 1000,
    alive: pid => living.has(pid), kill: (pid, signal) => killed.push([pid, signal]), log: text => said.push(text),
  });
  assert.deepEqual([control.stopped, downloader.stopped], [true, true]);
  assert.deepEqual(killed, [[-20, 'SIGKILL']]);
  assert.deepEqual(said, ['agent process 20 was still running: killed']);
});

test('shutDown kills a child that has not exited in time, and still sweeps the agents', async () => {
  const stuck = child('control', 10, null), killed = [], said = [];
  await shutDown({ children: [stuck], agentPids: () => [], timeoutMs: 20, alive: () => false, kill: (pid, signal) => killed.push([pid, signal]), log: text => said.push(text) });
  assert.deepEqual(killed, [[-10, 'SIGKILL']]);
  assert.deepEqual(said, ['control did not stop in time: killed']);
});

// ASS-193: a control asking for a restart (exit 75) has the dashboard exit with 75 only once everything else has stopped.
test('ender shuts down once, waiting for every child, then exits with the first code asked for', async () => {
  const other = child('control', 10, 30), downloader = child('downloader', 11, 5);
  const exits = [];
  const end = ender({ children: [other, downloader], agentPids: () => [], timeoutMs: 1000, alive: () => false, kill: () => {}, log: () => {} }, code => exits.push([code, other.stopped, downloader.stopped]));
  const first = end(75), second = end(75);
  assert.equal(first, second);                                                // a second control's 75: the same shut-down
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(exits, []);                                                // the other control still stopping
  await first;
  assert.deepEqual(exits, [[75, true, true]]);
  await end(0);
  assert.equal(exits.length, 1);
});

test('ender kills a child that has not stopped in time, then exits', async () => {
  const stuck = child('control', 10, null), killed = [], exits = [];
  await ender({ children: [stuck], agentPids: () => [], timeoutMs: 20, alive: () => false, kill: (pid, signal) => killed.push([pid, signal]), log: () => {} }, code => exits.push(code))(75);
  assert.deepEqual([killed, exits], [[[-10, 'SIGKILL']], [75]]);
});

test('stillNamed counts the running controls a restart request names, so the dashboard waits while they drain (ASS-200)', () => {
  assert.equal(stillNamed({ ticket: 'ASS-200', 'control-pids': [10, 11] }, [10, 11, 12]), 2);
  assert.equal(stillNamed({ ticket: 'ASS-200', 'control-pids': [10, 11] }, [12]), 0);
  assert.equal(stillNamed({ ticket: 'HD-1', 'control-pid': 10 }, [10]), 1);              // an older request's one pid
  assert.equal(stillNamed(null, [10]), 0);                                                // no request
});
