// ASS-537: a Substrate sandbox hibernates when its ticket gives up its seat and resumes when it gets one — control's side
// (sandboxes.js, seat-budget.js, remote-seats.js, substrate-config.js). ctx.cli stands in for the substrate:sandbox-*
// commands (their own side, on a fake cluster, is test/agent-cli/substrate-hibernate.test.js). AC4: hibernate on a gate,
// resume on the next seat, a failed resume (logged, retried with backoff, Blocked after the step's usual limit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxActor } from '../../src/control/machine-substrate.js';
import { sandboxWaits, superviseSandboxes } from '../../src/control/sandboxes.js';
import { trackMachineScript } from '../../src/control/machine-steps.js';
import { ticketKey, waiting, BLOCK_AFTER } from '../../src/control/backoff.js';
import { activeSandboxes, clusterLoad, warmPool, snapshotDisk, DEFAULTS, WORKER_REQUEST, SNAPSHOT_FLOOR } from '../../src/control/substrate-config.js';
import { grantSeats } from '../../src/control/seat-budget.js';
import { machineSeats } from '../../src/control/remote-seats.js';
import { controlFixture } from './control-fixture.js';
import { runSteps } from '../../src/control/steps.js';

const GIB = 1024 ** 3;
const engine = { steps: [
  { id: 'build', sequence: 2, 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'gate' }] },
  { id: 'gate', sequence: 3, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Approve' }, 'move-to-state': 'test' }] },
  { id: 'test', sequence: 4, 'run-location': 'vm', action: { type: 'script', command: 'x' }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }] },
  { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } },
] };
const build = engine.steps[0];

// A fake control context: ctx.cli answers the substrate:sandbox-* commands as they would, keeping each variation's record.
function fakeCtx({ fail = () => null } = {}) {
  const calls = [], lines = [], records = new Map();
  let now = Date.parse('2026-11-22T12:00:00Z');
  const ctx = {
    memory: { warned: new Set(), backoff: new Map() }, calls, lines, records,
    now: () => new Date(now), later: ms => { now += ms; },
    log: (phase, text) => lines.push(`${phase} ${text}`),
    cli: async args => {
      calls.push(args.join(' '));
      const why = fail(args);
      if (why) throw new Error(why);
      const [command, project, key, variation, machine] = args, k = `${key} ${variation}`;
      const at = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
      if (command === 'substrate:sandbox-up') {
        const was = records.get(k);
        const r = { ...(was ?? { name: sandboxActor(key, variation), project, machine, template: 'sandbox-dddddddddddd' }), state: 'running', at };
        records.set(k, r);
        return `${JSON.stringify({ ...r, machine: `substrate:${project}:${machine}:${r.name}`, host: machine, created: !was, branches: [] })}\n`;
      }
      if (command === 'substrate:sandbox-stop') { records.set(k, { ...records.get(k), state: 'stopped', at }); return '{"stopped":true}\n'; }
      if (command === 'substrate:sandbox-delete') { records.delete(k); return '{"deleted":true}\n'; }
      if (command === 'substrate:stack-up') return '{"stack":false}\n';   // ASS-542: no app stack declared here
      return '';
    },
  };
  return ctx;
}
const settle = () => new Promise(r => setTimeout(r, 0));
async function drain(ctx) { for (let i = 0; i < 20; i++) await settle(); for (const r of ctx.memory.sandboxes?.values() ?? []) if (r.job) await r.job; for (const j of ctx.memory.sandboxJobs?.values() ?? []) await j; }
const variationAt = (state, sandbox) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, 'state-changes': [{ to: 'build' }, { to: state }], ...(sandbox ? { sandbox } : {}) });
const running = { name: 'abc-3-a', project: 'p', machine: 'mac', state: 'running', at: '2026-11-22T11:00:00Z' };

test('ASS-537 AC1, AC4: hibernate on a gate — the seat given up, the sandbox is stopped (hibernated, never deleted) only once no agent and no in-machine script of it runs; one resumed meanwhile is hibernated again', async () => {
  const ctx = fakeCtx();
  const v = variationAt('gate', { ...running });
  ctx.records.set('ABC-3 A', { ...running });
  const project = { id: 'p', engine, tickets: [{ key: 'ABC-3', variations: [v] }], seats: [] };   // at the gate: no seat
  // Its agent still finishing the turn that reached the gate: never cut off mid-turn.
  const state = { projects: [project], assignments: [{ project: 'p', 'work-item': 'ABC-3', variation: 'A' }] };
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.deepEqual(ctx.calls, []);
  // Its agent done, an in-machine script of it running: still kept up.
  state.assignments = [];
  let end;
  const script = trackMachineScript(ctx, 'p', 'ABC-3', 'A', engine.steps[2], new Promise(r => { end = r; }));
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.deepEqual(ctx.calls, []);
  end(); await script;
  // Nothing of it runs: hibernated — stopped, not deleted — logged.
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.deepEqual(ctx.calls, ['substrate:sandbox-stop p ABC-3 A']);
  assert.ok(ctx.lines.some(l => /^sandbox ABC-3 A: its sandbox abc-3-a on mac stopped \(hibernated: its files and processes kept, no seat\): it holds no seat now/.test(l)), ctx.lines.join('\n'));
  // The next tick loads it stopped: nothing more is done.
  v.sandbox = ctx.records.get('ABC-3 A');
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.equal(ctx.calls.length, 1);
  // Something ran a command in it (the machine layer resumes it): its cluster's next check sees it running, so it is hibernated again.
  ctx.later(60e3);
  project.substrate = { mac: { 'checked-at': ctx.now().toISOString(), usage: { 'sandbox-use': { 'abc-3-a': { state: 'running', 'memory-bytes': GIB } } } } };
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.deepEqual(ctx.calls, ['substrate:sandbox-stop p ABC-3 A', 'substrate:sandbox-stop p ABC-3 A']);
  assert.match(ctx.lines.at(-1), /it had been resumed meanwhile/);
  // A check older than its record (taken before it was hibernated) is not taken for a resume.
  v.sandbox = ctx.records.get('ABC-3 A');
  project.substrate.mac['checked-at'] = '2026-11-22T11:30:00Z';
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.equal(ctx.calls.length, 2);
  assert.ok(!ctx.calls.some(c => c.startsWith('substrate:sandbox-delete')), 'never deleted while the ticket is in flight');
});

test('ASS-537 AC2, AC4: resume on the next seat — seated again at a step on its machine, the hibernated sandbox is resumed (not made again) before the step starts; no step is re-run, no visit spent, nothing counted as a failure', async () => {
  const ctx = fakeCtx();
  const stopped = { ...running, state: 'stopped' };
  const v = variationAt('build', stopped);
  const changes = JSON.stringify(v['state-changes']);
  ctx.records.set('ABC-3 A', { ...stopped });
  const t = { key: 'ABC-3', variations: [v] };
  const project = { id: 'p', engine, tickets: [t], seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  const held = ticketKey('p', 'ABC-3', 'A', 'build');
  // The step waits while its sandbox is resumed beside the tick.
  assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'ABC-3 A build', held), true);
  await drain(ctx);
  // ASS-542: then its app stack (none declared here), told it was resumed.
  assert.deepEqual(ctx.calls, ['substrate:sandbox-up p ABC-3 A mac', 'substrate:stack-up p ABC-3 A --after resumed 0'], 'resumed where it is: no delete, no new sandbox');
  assert.ok(ctx.lines.some(l => l === 'sandbox ABC-3 A: its sandbox abc-3-a is up on the Mac (resumed from hibernation: its files and processes as they were)'), ctx.lines.join('\n'));
  // The next tick loads it running: the step goes on — the same step, its visits as they were.
  v.sandbox = ctx.records.get('ABC-3 A');
  assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'ABC-3 A build', held), false);
  assert.equal(v['harness-status'].state, 'build');
  assert.equal(JSON.stringify(v['state-changes']), changes, 'no move: no visit spent, no step re-run');
  assert.equal(ctx.memory.backoff.get(held), undefined, 'no failure counted');
  assert.equal(ctx.calls.length, 2);
});

test('ASS-537 AC4: a failed resume is logged, tried again with the step\'s backoff, and after BLOCK_AFTER in a row its ticket goes to Blocked (as any step failing that often)', async () => {
  const ctx = fakeCtx({ fail: a => (a[0] === 'substrate:sandbox-up' ? 'substrate:sandbox-up: the sandbox abc-3-a on mac could not be resumed: kubectl ate resume actor abc-3-a failed' : null) });
  const v = variationAt('build', { ...running, state: 'stopped' });
  const t = { key: 'ABC-3', variations: [v] };
  const project = { id: 'p', engine, tickets: [t], seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  const held = ticketKey('p', 'ABC-3', 'A', 'build');
  for (let n = 1; n <= BLOCK_AFTER; n++) {
    assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'ABC-3 A build', held), true);
    await drain(ctx);
    assert.equal(ctx.calls.length, n);
    assert.equal(ctx.memory.backoff.get(held).failures, n);
    assert.ok(waiting(ctx.memory, held, ctx.now().getTime()), 'held by the step\'s backoff');
    const line = ctx.lines.at(-1);
    assert.match(line, new RegExp(`^error sandbox ABC-3 A: its sandbox on mac could not be resumed \\(${n} in a row; ${n < BLOCK_AFTER ? 'next try in' : `to Blocked: its step failed ${BLOCK_AFTER} times in a row`}`));
    // Backed off: not tried again before its time.
    assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'ABC-3 A build', held), true);
    await drain(ctx);
    assert.equal(ctx.calls.length, n);
    ctx.later(60 * 60e3);
  }
  assert.ok(ctx.memory.toBlock?.has(held), 'queued for Blocked (steps.js blockFailing)');
  assert.match(ctx.memory.backoff.get(held).error, /its sandbox could not be resumed: .*kubectl ate resume actor abc-3-a failed/);
});

test('ASS-537 AC4: …and control\'s steps phase then moves the ticket to Blocked, its failure the step\'s', async () => {
  const f = controlFixture();
  const at = f.variation()['harness-status'].state;
  const key = ticketKey('p', 'ABC-3', 'A', at);
  const ctx = { ...fakeCtx({ fail: () => 'could not be resumed' }), memory: f.ctx.memory };
  ctx.memory.backoff ??= new Map();
  const t = { key: 'ABC-3', variations: [f.variation()] };
  const project = { id: 'p', engine, tickets: [t], seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  for (let n = 0; n < BLOCK_AFTER; n++) {
    sandboxWaits(ctx, {}, project, t, f.variation(), build, 'w', key);
    await drain(ctx);
    ctx.later(60 * 60e3);
    for (const r of ctx.memory.sandboxes.values()) r.until = 0;
  }
  await runSteps(f.ctx, f.ctx.load());
  assert.equal(f.variation()['harness-status'].state, 'blocked');
});

test('ASS-537 AC3: a hibernated sandbox counts no memory or CPU; the warm pool\'s memory requests and the snapshots\' disk are counted', () => {
  const entry = { ...DEFAULTS, kind: 'kind', machine: 'mac', host: 'mac' };
  const live = { node: { running: true }, usage: {
    'sandbox-use': {
      'abc-3-a': { state: 'running', 'memory-bytes': 2 * GIB, 'cpu-percent': 50, 'snapshot-bytes': 0.5e9 },
      'abc-4-a': { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0, 'snapshot-bytes': 1.5e9 },   // hibernated
      'abc-5-a': { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0, 'snapshot-bytes': 1e9 },
    },
    'snapshot-bytes': 3.1e9, disk: { 'total-bytes': 100e9, 'free-bytes': 60e9 },
    workers: { replicas: 3, 'memory-request-bytes': 256 * 1024 ** 2 },
  } };
  // Hibernated: neither active nor counted in memory or CPU.
  assert.deepEqual(activeSandboxes(entry, live).map(s => s.actor), ['abc-3-a']);
  // The pool grew to 3 workers with them and keeps them: 2 warm ones, each reserving its 256Mi request.
  assert.deepEqual(warmPool(entry, live), { workers: 3, idle: 2, request: 256 * 1024 ** 2, memory: 512 * 1024 ** 2 });
  const load = clusterLoad(entry, live);
  assert.equal(load.memory, DEFAULTS['memory-gib'] * GIB + 512 * 1024 ** 2 + 2 * GIB);
  assert.equal(load.cpu, DEFAULTS['cpu-percent'] + 50);
  assert.equal(clusterLoad(entry, live, { sandboxes: false }).memory, DEFAULTS['memory-gib'] * GIB + 512 * 1024 ** 2, 'the pool is the cluster\'s part, counted either way');
  // Before a check reports its pool: the entry's warm workers at the default request.
  assert.equal(warmPool(entry, null).memory, DEFAULTS['warm-workers'] * WORKER_REQUEST);
  // Snapshots: every sandbox's (hibernated or not) and the golden ones; one more ticket's the average, at least the floor.
  const d = snapshotDisk(entry, live, {});
  assert.deepEqual([d.bytes, d.per, d.free, d.hold, d.full], [3.1e9, SNAPSHOT_FLOOR, 60e9, 15e9, false]);
  const tight = snapshotDisk(entry, { usage: { ...live.usage, disk: { 'free-bytes': 15.5e9 } } }, {});
  assert.equal(tight.full, true, 'one more snapshot would take the disk below disk-free-hold-gb');
  assert.equal(snapshotDisk(entry, { usage: {} }, {}).full, false, 'not measured: not held');
  // The Mac's budget: a project whose snapshots have no room gets no new seat; those it holds stay.
  const p = (id, extra = {}) => ({ id, share: 50, canUse: true, want: 4, held: 1, starting: 0, per: { memory: 2 * GIB, cpu: 50 }, ...extra });
  const seats = grantSeats({ budget: { memory: 40 * GIB, cpu: null }, mac: { memory: 0, cpu: 0 }, projects: [p('a', { diskFull: true }), p('b')] });
  assert.deepEqual([seats.get('a').seats, seats.get('b').seats], [1, 10]);
  // A remote machine of sandboxes: no ticket at all while its cluster's disk has no room (not even a first).
  const now = Date.parse('2026-11-22T12:00:00Z');
  const entryW = { connected: true, usage: { at: new Date(now - 1e3).toISOString(), memory: { 'total-bytes': 32 * GIB, 'available-bytes': 30 * GIB }, cpu: { cores: 8, samples: [] } } };
  const fits = machineSeats({ entry: entryW, limits: { memory: 90, cpu: 90 }, held: 0, harness: {}, now });
  const full = machineSeats({ entry: entryW, limits: { memory: 90, cpu: 90 }, held: 0, harness: {}, now, diskFull: true });
  assert.deepEqual([fits.seats, full.seats, full.admit], [1, 0, false]);
  assert.match(full.why, /disk has no room for one more sandbox's snapshot/);
  assert.ok(full.over.includes('disk'));
});
