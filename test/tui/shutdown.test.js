// The dashboard's shut-down (src/tui/shutdown.js): its children stopped and
// waited for, the stubborn killed, and every agent still alive killed too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shutDown, ender, stillNamed, vmStopper, goldenBuilds } from '../../src/tui/shutdown.js';
import { within, LOADED_MS } from '../support/until.js';

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
// ASS-549: the other control stops when the test lets it (a promise the test resolves), not on a 30 ms timer the
// test raced with a 15 ms one — on a loaded Mac the 15 ms timer could fire after the 30 ms one. The downloader is
// let go first and given its turns to settle, so the check that nothing exited yet proves ender waits for EVERY child.
test('ender shuts down once, waiting for every child, then exits with the first code asked for', async () => {
  const held = (name, pid) => {
    let done;
    const c = { name, pid, stopped: false, exited: new Promise(resolve => { done = resolve; }) };
    c.stop = () => { c.stopped = true; };
    c.letGo = () => done();
    return c;
  };
  const other = held('control', 10), downloader = held('downloader', 11);
  const exits = [];
  const end = ender({ children: [other, downloader], agentPids: () => [], timeoutMs: LOADED_MS * 10, alive: () => false, kill: () => {}, log: () => {} }, code => exits.push([code, other.stopped, downloader.stopped]));
  const first = end(75), second = end(75);
  assert.equal(first, second);                                                // a second control's 75: the same shut-down
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([other.stopped, downloader.stopped], [true, true]);        // both asked to stop
  downloader.letGo();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, []);                                                // the other control still stopping
  other.letGo();
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

// ASS-417: a quit stops the harness's VMs; a restart leaves them. limactl is
// a stub on PATH: instances are folders under $LIMA_HOME holding `status`
// (and `stuck`: a graceful stop that never ends — ASS-545: it sleeps 600 s, far past the tests' hang guard, so a
// test waiting on it fails at the guard, whatever the machine's speed); every call is logged with
// the LIMA_HOME it ran under.
const STUB = `#!/bin/bash
echo "$LIMA_HOME $*" >> "$STUB_LOG"
case "$1" in
  list) for d in "$LIMA_HOME"/*/; do [[ -d "$d" ]] && printf '%s\\t%s\\n' "$(basename "$d")" "$(cat "$d/status")"; done ;;
  stop) if [[ "$2" == -f ]]; then echo Stopped > "$LIMA_HOME/$3/status"
        else [[ -f "$LIMA_HOME/$2/stuck" ]] && exec sleep 600; echo Stopped > "$LIMA_HOME/$2/status"; fi ;;
esac
exit 0
`;
// A Lima folder of the harness's and another, each with its VMs ({ name: 'Running' | 'Stopped' | 'stuck' }).
function lima(vms, otherVms = { elsewhere: 'Running' }) {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-vms-')), bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'limactl'), STUB);
  chmodSync(join(bin, 'limactl'), 0o755);
  const make = (home, set) => {
    mkdirSync(home, { recursive: true });
    for (const [name, status] of Object.entries(set)) {
      mkdirSync(join(home, name));
      writeFileSync(join(home, name, 'status'), status === 'stuck' ? 'Running' : status);
      if (status === 'stuck') writeFileSync(join(home, name, 'stuck'), '');
    }
  };
  const home = join(dir, 'lima'), other = join(dir, 'other-lima'), log = join(dir, 'limactl.log');
  make(home, vms); make(other, otherVms);
  writeFileSync(log, '');
  return {
    home, other, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIMA_HOME: home, STUB_LOG: log },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    status: (name, at = home) => readFileSync(join(at, name, 'status'), 'utf8').trim(),
  };
}
const quitWith = (l, { timeoutMs = 5000, children = [], said = [], counts = [], goldenBuilds, kill = () => {} } = {}) => ender({
  children, agentPids: () => [], timeoutMs: 1000, alive: () => false, kill, log: text => said.push(text), goldenBuilds,
  vms: vmStopper({ env: l.env, timeoutMs, log: text => said.push(text), counted: n => counts.push(n) }),
}, () => {});

test('ASS-417 AC1/AC3/AC5: a quit stops every running VM under the harness\'s LIMA_HOME, all at once, only once control has stopped; another LIMA_HOME\'s are untouched, nothing deleted', async () => {
  const l = lima({ one: 'Running', two: 'Running', idle: 'Stopped' });
  const control = child('control', 10, 50), said = [], counts = [];
  let callsWhenControlEnded;
  control.exited.then(() => { callsWhenControlEnded = l.calls(); });
  await quitWith(l, { children: [control], said, counts })(0);
  assert.deepEqual(callsWhenControlEnded, [], 'no limactl until control has stopped');
  assert.deepEqual(l.calls().sort(), [`${l.home} list --format {{.Name}}\t{{.Status}}`, `${l.home} stop one`, `${l.home} stop two`].sort());
  assert.deepEqual([l.status('one'), l.status('two'), l.status('idle'), l.status('elsewhere', l.other)], ['Stopped', 'Stopped', 'Stopped', 'Running']);
  assert.ok(existsSync(join(l.home, 'one')) && existsSync(join(l.home, 'two')), 'kept, not deleted');
  assert.deepEqual(counts, [2, 1, 0]);
  assert.equal(said[0], `stopping 2 VMs under ${l.home}: one, two`);
  assert.deepEqual(said.slice(1).sort(), ['VM one stopped', 'VM two stopped']);
});

test('ASS-578 AC2: a quit stops the running VMs of every Lima folder in use — the harness-wide one and a project\'s own lima-home — each with its own folder as LIMA_HOME', async () => {
  const l = lima({ one: 'Running', idle: 'Stopped' }, { elsewhere: 'Running' }), said = [];
  const projects = mkdtempSync(join(tmpdir(), 'projects-'));
  mkdirSync(join(projects, 'big'));
  writeFileSync(join(projects, 'big', 'project.json'), JSON.stringify({ name: 'Big', 'lima-home': l.other }));
  l.env.PROJECTS_DIR = projects;
  await quitWith(l, { said })(0);
  assert.deepEqual([l.status('one'), l.status('idle'), l.status('elsewhere', l.other)], ['Stopped', 'Stopped', 'Stopped']);
  assert.ok(l.calls().includes(`${l.other} stop elsewhere`), l.calls().join('\n'));
  assert.ok(l.calls().includes(`${l.home} stop one`), l.calls().join('\n'));
  assert.ok(l.calls().includes(`${l.other} list --format {{.Name}}\t{{.Status}}`), 'its folder listed');
  assert.equal(said[0], `stopping 2 VMs under ${l.home}, ${l.other}: one, elsewhere`);
});

test('ASS-417 AC2/AC5: a restart (exit 75) stops no VM, and interrupts no golden build', async () => {
  const l = lima({ one: 'Running' }), killed = [];
  await quitWith(l, { goldenBuilds: () => [{ project: 'p', pid: 99 }], kill: (pid, signal) => killed.push([pid, signal]) })(75);
  assert.deepEqual(l.calls(), []);
  assert.equal(l.status('one'), 'Running');
  assert.deepEqual(killed, []);
});

test('ASS-417 AC1/AC5: a VM not stopped within the time limit is force-stopped (limactl stop -f)', async () => {
  const l = lima({ slow: 'stuck', quick: 'Running' }), said = [];
  // ASS-545: within() is a hang guard only (LOADED_MS, 90 s: well above the 1.5 s limit plus a loaded Mac's
  // limactl calls, well below the stuck stop's 600 s), in place of an 8 s limit.
  assert.notEqual(await within(quitWith(l, { timeoutMs: 1500, said })(0)), `still running after ${LOADED_MS}ms`, 'the force-stop did not wait for the stuck stop');
  assert.ok(l.calls().includes(`${l.home} stop -f slow`), l.calls().join('\n'));
  assert.ok(!l.calls().includes(`${l.home} stop -f quick`));
  assert.deepEqual([l.status('slow'), l.status('quick')], ['Stopped', 'Stopped']);
  assert.ok(said.includes('VM slow force-stopped (not stopped after 1.5 s)'), said.join('\n'));
  assert.ok(said.includes('VM quick stopped'));
});

test('ASS-417 AC3/AC5: Q pressed again while the VMs stop force-stops the rest at once, and the dashboard exits', async () => {
  const l = lima({ a: 'stuck', b: 'stuck' }), said = [], exits = [];
  let end;
  end = ender({
    children: [], agentPids: () => [], alive: () => false, kill: () => {}, log: text => said.push(text),
    vms: vmStopper({ env: l.env, timeoutMs: 600_000, log: text => said.push(text), counted: n => { if (n === 2) setTimeout(() => end.force(), 200); } }),
  }, code => exits.push(code));
  // ASS-545: a hang guard only (LOADED_MS, 90 s), in place of a 5 s limit; the limit is 10 minutes, far past it.
  assert.notEqual(await within(end(0)), `still running after ${LOADED_MS}ms`, 'not the 10-minute limit');
  assert.deepEqual(exits, [0]);
  assert.deepEqual([l.status('a'), l.status('b')], ['Stopped', 'Stopped']);
  assert.deepEqual(said.slice(1).sort(), ['VM a force-stopped (Q pressed again)', 'VM b force-stopped (Q pressed again)']);
});

test('ASS-417: with no LIMA_HOME folder there are no VMs, and limactl is not run', async () => {
  const l = lima({}), said = [];
  await vmStopper({ env: { ...l.env, LIMA_HOME: join(l.home, 'missing') }, log: text => said.push(text) }).run();
  assert.deepEqual([l.calls(), said], [[], []]);
});

test('ASS-417 AC4: a running golden image build (its run recorded, no exit written, its process a build) is killed with its group on a quit, and logged', async () => {
  const projects = mkdtempSync(join(tmpdir(), 'shutdown-golden-'));
  const run = (project, pid, exit) => {
    mkdirSync(join(projects, project));
    writeFileSync(join(projects, project, 'golden-build-run.json'), JSON.stringify({ pid, 'started-at': '2026-11-12T00:00:00Z' }));
    if (exit != null) writeFileSync(join(projects, project, 'golden-build-run.exit'), `${exit}\n`);
  };
  run('building', 501); run('ended', 502, 1); run('reused', 503);
  mkdirSync(join(projects, 'none'));
  const builds = goldenBuilds(projects, pid => pid !== 503);
  assert.deepEqual(builds, [{ project: 'building', pid: 501 }]);
  const l = lima({}), killed = [], said = [];
  await quitWith(l, { goldenBuilds: () => builds, kill: (pid, signal) => killed.push([pid, signal]), said })(0);
  assert.deepEqual(killed, [[-501, 'SIGKILL']]);
  assert.match(said[0], /^golden image build of building interrupted \(process 501 killed\)/);
});
