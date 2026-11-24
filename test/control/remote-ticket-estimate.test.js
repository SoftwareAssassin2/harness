// ASS-574: a workstation's or cloud VM's sandboxes are sized by the Mac's estimate since ASS-570 (ticket-estimate.js),
// one per machine — only working sandboxes sampled (AC1), floored, kept across ticks and restarts per machine and moved
// gradually (AC2), and where the per-ticket figure came from said in remote-seats.json and the log (AC3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetRemote, machineSeats } from '../../src/control/remote-seats.js';
import { projectRunTargets } from '../../src/control/run-targets.js';
import { sandboxNeed, clusterEntry } from '../../src/control/substrate-config.js';
import { STEP, ESTIMATE_FILE, estimateFile } from '../../src/control/ticket-estimate.js';

const GIB = 2 ** 30;
const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' });
const IDLE = { state: 'running', 'memory-bytes': Math.round(0.34 * GIB), 'cpu-percent': 3 };
const HIBERNATED = { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0, 'snapshot-bytes': 4255744 };

// A project on workstation-substrate with clusters on ws-1 and ws-2; T-1 A's sandbox t-1-a on ws-1 holds a seat there.
// Each machine: 32 GiB, 8 cores, 3 GiB used and 40% CPU (its cluster's fixed 2.5 GiB / 30% among them), so its own
// measured use per ticket (0.5 GiB, 10%) is under any sandbox estimate and the estimate is the figure.
function fixture({ targets = ['workstation-substrate', 'workstation'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ass574-'));
  mkdirSync(join(dir, 'p'), { recursive: true });
  let now = Date.parse('2026-11-24T09:00:00Z');
  const lines = [];
  const ctx = { memory: {}, now: () => new Date(now), log: (phase, line) => lines.push(`${phase} ${line}`), paths: { projects: dir } };
  const json = { name: 'p', 'dev-environments': { 'run-targets': targets, workstations: [ws('ws-1'), ws('ws-2')], substrate: { clusters: [{ machine: 'ws-1' }, { machine: 'ws-2' }] } } };
  const usage = () => ({ at: new Date(now - 1e3).toISOString(), memory: { 'total-bytes': 32 * GIB, 'available-bytes': 29 * GIB }, cpu: { cores: 8, samples: [{ at: new Date(now - 1e3).toISOString(), percent: 40 }] } });
  const project = { id: 'p', engine: {}, json, runTargets: projectRunTargets(json), devEnvironments: { mode: 'vm+workstation', workstations: [ws('ws-1'), ws('ws-2')] },
    workstations: {}, substrate: {},
    tickets: [{ key: 'T-1', variations: [{ name: 'A', sandbox: { name: 't-1-a', project: 'p', machine: 'ws-1', state: 'running' } }] }],
    seats: [{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-substrate' }] };
  const f = {
    dir, lines, ctx, project,
    later: ms => { now += ms; },
    iso: () => new Date(now).toISOString(),
    // reading(use, machine, at) — the machine's cluster's last check (substrate.json), its sandbox t-1-a as `use` says.
    reading: (use, machine = 'ws-1', at = new Date(now).toISOString()) => {
      project.substrate[machine] = { 'checked-at': at, node: { running: true }, usage: { workers: { replicas: 1, 'memory-request-bytes': 0 }, 'sandbox-use': { 't-1-a': use } } };
    },
    // tick(busy) — the remote phase, T-1 A working (an agent of it running) or not; its remote-seats.json entry for ws-1.
    tick: async (busy = false, machine = 'ws-1') => {
      for (const id of ['ws-1', 'ws-2']) project.workstations[id] = { connected: true, usage: usage() };
      await budgetRemote(ctx, { projects: [project], harness: {}, assignments: busy ? [{ project: 'p', 'work-item': 'T-1', variation: 'A', state: 'plan' }] : [] });
      return project.remoteBudget[machine];
    },
    file: () => JSON.parse(readFileSync(join(dir, 'p', 'remote-seats.json'), 'utf8')),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
  return f;
}
const lastRemote = (f, machine = 'ws-1') => f.lines.findLast(l => l.startsWith(`remote p ${machine}:`));

test('ASS-574 AC2: on main an idle sandbox\'s reading swung a remote machine\'s per-ticket figure (reproduced); now alternating idle and hibernated readings leave it at the floor', async () => {
  const f = fixture();
  // main's figure: sandboxNeed (the average of the running sandboxes, idle or not) as the floor under the machine's own use.
  const entry = clusterEntry(f.project, 'ws-1');
  const live = use => ({ usage: { 'sandbox-use': { 't-1-a': use } } });
  const per = need => machineSeats({ entry: { connected: true, usage: { at: f.iso(), memory: { 'total-bytes': 32 * GIB, 'available-bytes': 29 * GIB }, cpu: { cores: 8, samples: [{ at: f.iso(), percent: 40 }] } } },
    limits: { memory: 90, cpu: 90 }, held: 1, harness: {}, now: Date.parse(f.iso()), floor: need, reserved: { memory: 2.5 * GIB, cpu: 30, running: true } }).per;
  const swing = [per(sandboxNeed(entry, live(IDLE))), per(sandboxNeed(entry, live(HIBERNATED)))].map(p => [p.memory / GIB, p.cpu]);
  assert.deepEqual(swing, [[0.5, 10], [1.5, 100]], 'the swing, as on main: an idle sandbox made a ticket a third as dear in memory and a tenth in CPU');
  // Now: the same two readings, tick after tick, no work — the floor every time, logged once.
  const figures = [];
  for (const use of [IDLE, IDLE, HIBERNATED, IDLE, HIBERNATED]) {
    f.reading(use); f.later(60e3);
    const b = await f.tick();
    figures.push([b['per-ticket']['memory-bytes'] / GIB, b['per-ticket']['cpu-percent'], b['per-ticket'].source]);
  }
  assert.deepEqual(figures, Array(5).fill([1.5, 100, 'defaults']), f.lines.join('\n'));
  assert.equal(f.lines.filter(l => l.startsWith('remote p ws-1:')).length, 1, 'logged once: nothing changed');
  f.done();
});

test('ASS-574 AC1: idle, starting, resuming, hibernating and hibernated sandboxes on a remote machine are never samples; a working running one is', async () => {
  const f = fixture();
  const small = { 'memory-bytes': Math.round(0.3 * GIB), 'cpu-percent': 2 };
  f.reading({ state: 'running', ...small }); f.later(60e3);
  let b = await f.tick(false);
  assert.deepEqual([b['per-ticket'].source, b['per-ticket'].samples, b['per-ticket']['memory-bytes']], ['defaults', 0, 1.5 * GIB], 'idle: not a sample');
  for (const state of ['starting', 'resuming', 'suspending', 'suspended']) {
    await f.tick(true); f.later(200e3);
    f.reading({ state, ...small }); f.later(5e3);
    b = await f.tick(true);
    assert.equal(b['per-ticket'].samples, 0, state);
  }
  // Working through a whole check interval and running: a sample (under the floor, so the figure stays the floor).
  await f.tick(true); f.later(200e3);
  f.reading({ state: 'running', ...small }); f.later(5e3);
  b = await f.tick(true);
  assert.deepEqual([b['per-ticket'].samples, b['per-ticket'].source, b['per-ticket']['memory-bytes'], b['per-ticket']['cpu-percent']], [1, 'defaults', 1.5 * GIB, 100]);
  f.later(5e3);
  assert.equal((await f.tick(true))['per-ticket'].samples, 1, 'the same reading is not taken twice');
  f.done();
});

test('ASS-574 AC2, AC3: working samples raise one machine\'s figure gradually to their 80th percentile, never below its floor; per machine; kept across a restart; remote-seats.json and the log say where it came from', async () => {
  const f = fixture();
  let b = await f.tick();
  assert.match(lastRemote(f), /one ticket 1\.5 GiB, 100% CPU \(defaults\): /);
  assert.deepEqual(b['per-ticket'].floor, { 'memory-bytes': 1.5 * GIB, 'cpu-percent': 100 });
  for (let i = 0; i < 5; i++) {
    await f.tick(true); f.later(200e3); await f.tick(true);
    f.reading({ state: 'running', 'memory-bytes': 3 * GIB, 'cpu-percent': 200 }); f.later(5e3);
  }
  const before = (await f.tick(true))['per-ticket'];
  assert.equal(before.source, 'working-samples');
  assert.deepEqual(before.target, { 'memory-bytes': 3 * GIB, 'cpu-percent': 200 });
  let last = before['memory-bytes'];
  for (let i = 0; i < 20; i++) {
    f.later(5e3);
    const p = (await f.tick(true))['per-ticket'];
    assert.ok(p['memory-bytes'] >= 1.5 * GIB, 'never below its floor');
    assert.ok(p['memory-bytes'] <= last * STEP + 1 && p['memory-bytes'] >= last / STEP - 1, `${last} → ${p['memory-bytes']}`);
    last = p['memory-bytes'];
  }
  b = f.file()['ws-1'];
  assert.deepEqual([b['per-ticket']['memory-bytes'], b['per-ticket']['cpu-percent'], b['per-ticket'].source, b['per-ticket'].samples, b['per-ticket'].measured], [3 * GIB, 200, 'working-samples', 5, false]);
  assert.match(lastRemote(f), /one ticket 3\.0 GiB, 200% CPU \(from 5 working samples\): /);
  // Per machine: ws-2 took none of ws-1's samples; the Mac's file is not touched.
  assert.deepEqual([f.file()['ws-2']['per-ticket'].source, f.file()['ws-2']['per-ticket'].samples, f.file()['ws-2']['per-ticket']['memory-bytes']], ['defaults', 0, 1.5 * GIB]);
  assert.ok(existsSync(estimateFile(f.dir, 'p', 'ws-1')), 'ticket-estimate-ws-1.json');
  assert.equal(JSON.parse(readFileSync(estimateFile(f.dir, 'p', 'ws-1'), 'utf8')).samples.length, 5);
  assert.ok(!existsSync(join(f.dir, 'p', ESTIMATE_FILE)), 'the Mac\'s estimate is its own');
  // A restart: a new control with nothing in memory reads it back.
  delete f.ctx.memory.ticketEstimate;
  delete f.ctx.memory.remoteSeats;
  f.later(5e3);
  b = await f.tick(false);
  assert.deepEqual([b['per-ticket']['memory-bytes'], b['per-ticket'].source, b['per-ticket'].samples], [3 * GIB, 'working-samples', 5]);
  f.done();
});

test('ASS-574 AC3: a machine\'s measured use per ticket above the estimate is said; a machine without sandboxes says a VM\'s', async () => {
  const f = fixture();
  await f.tick();
  // 12 GiB used now: (12 − 2.5) / 1 = 9.5 GiB a ticket, above the 1.5 GiB estimate.
  const heavy = { connected: true, usage: { at: f.iso(), memory: { 'total-bytes': 32 * GIB, 'available-bytes': 20 * GIB }, cpu: { cores: 8, samples: [{ at: f.iso(), percent: 40 }] } } };
  f.later(1e3);
  f.reading(IDLE);   // its sandbox runs: in the reading
  const copy = { ...f.project, workstations: { 'ws-1': heavy, 'ws-2': heavy } };
  await budgetRemote(f.ctx, { projects: [copy], harness: {}, assignments: [] });
  const b = copy.remoteBudget['ws-1'];
  assert.deepEqual([Math.round(b['per-ticket']['memory-bytes'] / GIB * 10) / 10, b['per-ticket'].source, b['per-ticket'].measured], [9.5, 'defaults', true]);
  assert.match(lastRemote(f), /\(defaults; its measured use per ticket above it\)/);
  f.done();
  // A plain workstation target first: no sandboxes, a VM's floor.
  const g = fixture({ targets: ['workstation', 'workstation-substrate'] });
  const p = (await g.tick())['per-ticket'];
  assert.deepEqual([p.source, p['memory-bytes']], ['vm', 4 * GIB]);
  assert.match(lastRemote(g), /\(a VM's\): /);
  assert.ok(!existsSync(estimateFile(g.dir, 'p', 'ws-1')));
  g.done();
});
