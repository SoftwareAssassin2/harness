// ASS-582: a sandbox bring-up on a remote machine not connected yet, or whose Substrate cluster is not ready yet, waits
// for it — no failure counted — instead of counting towards the 3 in a row that send a ticket to Blocked. ctx.cli stands
// in for the substrate:sandbox-* commands (sandbox-crash.test.js's way); seats.js bootWaits bounds the wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxWaits, machineWhy } from '../../src/control/sandboxes.js';
import { clusterWhy } from '../../src/control/substrate-config.js';
import { bootWaits, seatNeeds } from '../../src/control/seats.js';
import { seatCapacity } from '../../src/control/seat-kinds.js';
import { ticketKey, BLOCK_AFTER } from '../../src/control/backoff.js';
import { sandboxActor } from '../../src/control/machine-substrate.js';
import { bootWaitsJson, bootWaitOverOf } from '../../src/control/boot-waits.js';

const engine = { steps: [
  { id: 'build', sequence: 2, 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
  { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } },
] };
const build = engine.steps[0];
const T0 = Date.parse('2026-11-24T13:23:00Z');
const iso = ms => new Date(ms).toISOString();
const STOPPED = { state: 'stopped', connected: false };
const upAt = ms => ({ state: 'running', connected: true, 'connected-at': iso(ms), setup: { ok: true, 'checked-at': iso(ms + 20e3) } });
const healthyAt = ms => ({ state: 'healthy', problems: [], 'checked-at': iso(ms) });
const NOT_READY = [{ what: 'proxy ARP', why: 'is off on the cluster\'s node (its sandboxes cannot reach each other)', repair: true }, { what: 'pods', why: 'ate-system/ate-api-server is not ready (Running)', repair: true }];

// A fake control context. sandbox-up refuses as the real one does while `ctx.closed` (no open connection), else fails
// with `fail()`'s message when it gives one, else makes the sandbox.
function fakeCtx({ fail = () => null } = {}) {
  const calls = [], lines = [], records = new Map();
  let now = T0;
  const ctx = {
    memory: { warned: new Set(), backoff: new Map() }, calls, lines, records, closed: false,
    now: () => new Date(now), later: ms => { now += ms; }, at: () => now,
    log: (phase, text) => lines.push(`${phase} ${text}`),
    cli: async args => {
      calls.push(args.join(' '));
      const [command, project, key, variation, machine] = args, k = `${key} ${variation}`;
      if (command === 'substrate:sandbox-up') {
        if (ctx.closed) throw new Error(`agent.sh substrate:sandbox-up ${args.slice(1).join(' ')}: substrate:sandbox-up: ${project}'s ${machine} has no open connection (control connects it for a step that needs it)`);
        const why = fail(args);
        if (why) throw new Error(why);
        const r = { name: sandboxActor(key, variation), project, machine, template: 'sandbox-dddddddddddd', state: 'running', 'created-at': iso(now), at: iso(now) };
        records.set(k, r);
        return `${JSON.stringify({ ...r, host: machine, created: true, branches: [] })}\n`;
      }
      if (command === 'substrate:stack-up') return '{"stack":false}\n';
      return '';
    },
  };
  return ctx;
}
const settle = () => new Promise(r => setTimeout(r, 0));
async function drain(ctx) { for (let i = 0; i < 20; i++) await settle(); for (const r of ctx.memory.sandboxes?.values() ?? []) if (r.job) await r.job; }

// world(live, cluster) — project p, its workstation ws-1 (live entry `live`, its cluster's check `cluster`), ABC-3 A at
// build seated on workstation-substrate there.
function world(live, cluster) {
  const v = { name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' }, 'state-changes': [{ to: 'build' }] };
  const t = { key: 'ABC-3', variations: [v] };
  const project = {
    id: 'p', engine, tickets: [t], json: {},
    devEnvironments: { mode: 'workstation', workstations: [{ id: 'ws-1' }] },
    workstations: { 'ws-1': live }, substrate: cluster ? { 'ws-1': cluster } : {},
    seats: [{ key: 'ABC-3', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-substrate' }],
  };
  return { v, t, project, held: ticketKey('p', 'ABC-3', 'A', 'build') };
}
const state = { harness: { 'remote-boot-wait-seconds': 900 } };

test('AC1: a bring-up on a machine not connected yet runs no sandbox-up, counts no failure and waits, logged once; its seat has control start and connect the machine; once it is up and its cluster checked healthy, the sandbox is made', async () => {
  const ctx = fakeCtx();
  const { v, t, project, held } = world(STOPPED, healthyAt(T0 - 3600e3));
  for (let i = 0; i < 5; i++) {
    assert.equal(sandboxWaits(ctx, state, project, t, v, build, 'ABC-3 A build', held), true, 'the step waits');
    await drain(ctx);
    ctx.later(60e3);
  }
  assert.deepEqual(ctx.calls, [], 'no bring-up tried while the machine is down');
  assert.equal(ctx.memory.backoff.get(held), undefined, 'no failure of the step counted');
  assert.deepEqual(ctx.lines.filter(l => /waits for ws-1 to come up/.test(l)), ['sandbox ABC-3 A: waits for ws-1 to come up (it is stopped; control starts and connects it)']);
  assert.ok(!ctx.lines.some(l => /could not be brought up/.test(l)), ctx.lines.join('\n'));
  // The connect (and start) is triggered: the seat on it makes control's workstation job need it (seats.js seatNeeds).
  assert.match(seatNeeds(state, project, { waiting: [], ready: [], reserved: [] }).get('ws-1'), /its seat: ABC-3 A/);
  // Connected, but its cluster's last check is from before the connection: still waits, its reason said.
  const connected = ctx.at();
  project.workstations['ws-1'] = upAt(connected);
  sandboxWaits(ctx, state, project, t, v, build, 'w', held);
  await drain(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.ok(ctx.lines.includes('sandbox ABC-3 A: waits for ws-1 to come up (its Substrate cluster not checked since it connected)'), ctx.lines.join('\n'));
  // Checked healthy since: brought up.
  project.substrate['ws-1'] = healthyAt(connected + 30e3);
  sandboxWaits(ctx, state, project, t, v, build, 'w', held);
  await drain(ctx);
  assert.deepEqual(ctx.calls, ['substrate:sandbox-up p ABC-3 A ws-1', 'substrate:stack-up p ABC-3 A --after created 0']);
  assert.equal(ctx.memory.backoff.get(held), undefined);
});

test('AC1: fails on main\'s rule — the refusal "has no open connection" (a connection closed under the bring-up) is a wait, never counted', async () => {
  const ctx = fakeCtx();
  const { v, t, project, held } = world(upAt(T0 - 600e3), healthyAt(T0 - 60e3));
  ctx.closed = true;
  for (let i = 0; i < BLOCK_AFTER + 1; i++) {
    sandboxWaits(ctx, state, project, t, v, build, 'w', held);
    await drain(ctx);
    ctx.later(60e3);
  }
  assert.equal(ctx.calls.filter(c => c.startsWith('substrate:sandbox-up')).length, BLOCK_AFTER + 1);
  assert.equal(ctx.memory.backoff.get(held), undefined, 'not counted');
  assert.ok(!ctx.memory.toBlock?.has(held), 'never queued for Blocked');
});

test('AC2: a cluster not ready — starting after a node start, or broken with pods not ready and proxy ARP off — makes the step wait, not fail', async () => {
  for (const cluster of [
    { state: 'starting', problems: [{ what: 'pods', why: 'not ready', repair: true }] },
    { state: 'broken', problems: NOT_READY },
    { state: 'missing', problems: [] },
    { state: 'docker-down', problems: [] },
  ]) {
    const ctx = fakeCtx();
    const { v, t, project, held } = world(upAt(T0 - 600e3), { ...cluster, 'checked-at': iso(T0 - 60e3) });
    for (let i = 0; i < BLOCK_AFTER + 1; i++) {
      assert.equal(sandboxWaits(ctx, state, project, t, v, build, 'w', held), true);
      await drain(ctx);
      ctx.later(60e3);
    }
    assert.deepEqual(ctx.calls, [], cluster.state);
    assert.equal(ctx.memory.backoff.get(held), undefined, cluster.state);
    assert.equal(ctx.lines.filter(l => /waits for ws-1 to come up/.test(l)).length, 1, 'logged once');
  }
  assert.match(clusterWhy({ substrate: { m: { state: 'broken', problems: NOT_READY, 'checked-at': iso(T0) } } }, 'm'), /^its Substrate cluster is not ready \(control restarts it\): proxy ARP: is off/);
  // The Mac's cluster: the same, though with no check recorded at all it runs as before.
  assert.match(machineWhy({ substrate: { mac: { state: 'starting', problems: [] } } }, 'mac'), /starting/);
  assert.equal(machineWhy({}, 'mac'), null);
  // A cluster broken only for what no restart fixes is not waited for: its bring-up runs (and counts, AC4).
  assert.equal(clusterWhy({ substrate: { m: { state: 'broken', problems: [{ what: 'docker memory', why: 'low', repair: false }], 'checked-at': iso(T0) } }, workstations: { m: upAt(T0 - 60e3) } }, 'm'), null);
});

test('AC3: past remote-boot-wait-seconds a machine whose cluster never got ready is lost for placement (as ASS-575\'s boot wait), so its step goes elsewhere; nothing is counted towards Blocked; it is back once its cluster is ready', async () => {
  const ctx = fakeCtx();
  const { v, t, project, held } = world(STOPPED, healthyAt(T0 - 3600e3));
  bootWaits(ctx, state, project);
  assert.deepEqual(project.bootWaitOver, {});
  // It boots and connects within the wait, but its cluster stays not ready.
  ctx.later(120e3);
  project.workstations['ws-1'] = upAt(ctx.at());
  project.substrate['ws-1'] = { state: 'broken', problems: NOT_READY, 'checked-at': iso(ctx.at() + 10e3) };
  for (let s = 120; s <= 900; s += 60) {
    bootWaits(ctx, state, project);
    assert.deepEqual(project.bootWaitOver, {}, `still within its wait at ${s} s`);
    sandboxWaits(ctx, state, project, t, v, build, 'w', held);
    await drain(ctx);
    ctx.later(60e3);
  }
  bootWaits(ctx, state, project);
  assert.deepEqual(project.bootWaitOver, { 'ws-1': 'it did not come up within 900 s (remote-boot-wait-seconds)' });
  assert.match(ctx.lines.find(l => /did not come up within/.test(l)), /ws-1 did not come up within 900 s .*\(its Substrate cluster is not ready/);
  assert.equal(seatCapacity(project).workstations[0].lost, 'it did not come up within 900 s (remote-boot-wait-seconds)', 'lost: no seat placed on it, its holders placed again');
  // The dashboard reads it the same from boot-waits.json (ASS-575), though the machine itself is up.
  const file = bootWaitsJson(new Map([['ws-1', ctx.memory.bootWaits.get('p ws-1')]]), 900);
  assert.equal(file.machines['ws-1'].cluster, true);
  assert.deepEqual(bootWaitOverOf(file, project.workstations, ctx.at()), project.bootWaitOver);
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.memory.backoff.get(held), undefined, 'never counted');
  // Its holder taken out of its seat (keepSeats): still lost while the cluster is not ready.
  project.seats = [];
  bootWaits(ctx, state, project);
  assert.ok(project.bootWaitOver['ws-1'], 'stays lost until its cluster is ready');
  project.substrate['ws-1'] = healthyAt(ctx.at());
  bootWaits(ctx, state, project);
  assert.deepEqual(project.bootWaitOver, {}, 'back once its cluster is ready');
  // A machine up with no substrate seat on it is never held back by its cluster.
  project.substrate['ws-1'] = { state: 'broken', problems: NOT_READY, 'checked-at': iso(ctx.at()) };
  bootWaits(ctx, state, project);
  assert.deepEqual(project.bootWaitOver, {});
});

test('AC4: a real bring-up failure on a connected machine with a healthy cluster still counts 1, 2, 3 and then sends the ticket to Blocked', async () => {
  const ctx = fakeCtx({ fail: a => (a[0] === 'substrate:sandbox-up' ? 'substrate:sandbox-up: kubectl ate resume actor abc-3-a failed: no worker has room' : null) });
  const { v, t, project, held } = world(upAt(T0 - 600e3), healthyAt(T0 - 60e3));
  for (let n = 1; n <= BLOCK_AFTER; n++) {
    sandboxWaits(ctx, state, project, t, v, build, 'w', held);
    await drain(ctx);
    assert.equal(ctx.memory.backoff.get(held).failures, n);
    ctx.later(60 * 60e3);
  }
  assert.ok(ctx.memory.toBlock?.has(held), 'queued for Blocked');
  assert.match(ctx.lines.join('\n'), /could not be brought up \(3 in a row; to Blocked: its step failed 3 times in a row\)/);
});
