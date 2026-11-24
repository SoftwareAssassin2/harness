// ASS-577: control's side of a hand-over out of (or into) a ticket's stopped Lima VM (run-target-places.js). handOverVm
// names the Lima VM code:hand-over would start; AC2: under the memory hold the step waits (handOverWaits) — the hand-over
// never run, no failure counted (no backoff), the variation held with the hold as a step starting a VM is — and it goes
// on once there is memory; while the hand-over runs the VM counts as worked in (the VM lifecycle does not stop it under
// it); each start, and a VM found gone (AC3), is logged from what code:hand-over prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readyTarget, handOverVm, handOverWaits } from '../../src/control/run-target-places.js';
import { machineScriptRunning } from '../../src/control/machine-steps.js';
import { MEMORY_READ_EVERY } from '../../src/control/host-memory.js';

const GIB = 2 ** 30;
const vm = { name: 'abc-89-a' };
const at = extra => ({ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' }, vm, ...extra });
const onSandbox = [{ key: 'ABC-89', variation: 'A', kind: 'cloud-vm', target: 'cloud-vm-substrate' }];
const project = (variation, seats = onSandbox, localSeats = []) => {
  const t = { key: 'ABC-89', variations: [variation] };
  return { project: { id: 'p', json: {}, tickets: [t], seats, localSeats }, t, v: variation };
};
// A bare control context; `said` is what code:hand-over prints; the Mac's memory as `memory` gives it.
function bareCtx({ said = {}, memory = { freePercent: 64, pressure: 'normal', totalBytes: 100 * GIB, vms: new Map() } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hand-over-vm-'));
  mkdirSync(join(dir, 'p'));
  let now = Date.parse('2026-11-24T10:00:00Z'), reading = memory;
  const ctx = {
    paths: { projects: dir }, memory: { warned: new Set(), backoff: new Map() }, calls: [], lines: [],
    now: () => new Date(now), log: (phase, text) => ctx.lines.push(`${phase} ${text}`),
    hostMemory: async () => reading,
    cli: async args => { ctx.calls.push(args.join(' ')); return `${JSON.stringify({ from: 'local-vm', to: 'cloud-vm-substrate', branch: 'change/ABC-89-1', folder: null, ...said })}\n`; },
    set: m => { reading = m; now += MEMORY_READ_EVERY; },
    hold: () => (existsSync(join(dir, 'p', 'memory-hold.json')) ? JSON.parse(readFileSync(join(dir, 'p', 'memory-hold.json'), 'utf8')) : null),
  };
  return ctx;
}

test('handOverVm: the Lima VM a hand-over would start — off local-vm (or nothing recorded, as ABC-89 A), onto local-vm; none for a workstation claim, a non-Lima machine, or no move', () => {
  const vmOf = (variation, seats) => { const p = project(variation, seats); return handOverVm(p.project, p.t, p.v); };
  assert.equal(vmOf(at()), 'abc-89-a', 'no run-target recorded: on its VM');
  assert.equal(vmOf(at({ 'run-target': { target: 'local-vm' } })), 'abc-89-a');
  assert.equal(vmOf(at({ 'run-target': { target: 'local-substrate' } }), [{ key: 'ABC-89', variation: 'A', kind: 'vm', target: 'local-vm' }]), 'abc-89-a', 'onto local-vm');
  assert.equal(vmOf(at({ 'run-target': { target: 'local-worktree' } })), null, 'from a worktree onto a sandbox: no VM');
  assert.equal(vmOf(at({ 'run-target': { target: 'cloud-vm-substrate' } })), null, 'no move');
  assert.equal(vmOf(at({ workstation: { name: 'ws', project: 'p', folder: 'f' } })), null, 'a workstation claim is no Lima VM');
  assert.equal(vmOf(at({ vm: { name: 'x', kind: 'cloud-vm' } })), null);
  assert.equal(vmOf(at(), [{ key: 'ABC-89', variation: 'A', kind: 'vm', target: 'local-vm' }]), null, 'local-vm to local-vm: no hand-over at all');
});

test('AC2: under the memory hold a hand-over that must start a stopped Lima VM waits — not run, no failure counted, the variation held — and goes on once memory is back', async () => {
  const ctx = bareCtx({ memory: { freePercent: 2, pressure: 'critical', totalBytes: 100 * GIB, vms: new Map() } });
  const { project: p, t, v } = project(at());
  const state = { harness: {}, projects: [p] };
  assert.equal(await handOverWaits(ctx, state, p, t, v, 'ABC-89 A build'), true);
  assert.equal(await handOverWaits(ctx, state, p, t, v, 'ABC-89 A build'), true);
  assert.deepEqual(ctx.calls, [], 'code:hand-over not run');
  assert.equal(ctx.memory.backoff.size, 0, 'no failure counted');
  assert.equal(ctx.lines.filter(l => /waits: its hand-over must start its stopped Lima VM abc-89-a, and the Mac is out of memory/.test(l)).length, 1, 'said once');
  const hold = ctx.hold();
  assert.deepEqual(hold.held.map(h => [h.key, h.variation, h.vm]), [['ABC-89', 'A', 'abc-89-a']], 'held as a step starting a VM is (its seat freed)');
  // Memory back: it goes on, the hold lifted.
  ctx.set({ freePercent: 64, pressure: 'normal', totalBytes: 100 * GIB, vms: new Map() });
  assert.equal(await handOverWaits(ctx, state, p, t, v, 'ABC-89 A build'), false);
  assert.equal(ctx.hold(), null, 'the hold lifted');
  // A VM control has seen up needs no start: never held for memory.
  const up = bareCtx({ memory: { freePercent: 2, pressure: 'critical', totalBytes: 100 * GIB, vms: new Map() } });
  up.memory.vmsUp = new Set(['abc-89-a']);
  assert.equal(await handOverWaits(up, state, p, t, v, 'ABC-89 A build'), false);
  // No Lima VM in the hand-over (a worktree onto a sandbox): never held.
  const wt = project(at({ 'run-target': { target: 'local-worktree' } }));
  assert.equal(await handOverWaits(bareCtx({ memory: { freePercent: 2, pressure: 'critical', totalBytes: 100 * GIB, vms: new Map() } }), state, wt.project, wt.t, wt.v, 'x'), false);
});

test('AC1: while code:hand-over runs, the variation counts as worked in its machine (the VM lifecycle stops not the VM it started), and the start is logged as "started …; stopped again"', async () => {
  const ctx = bareCtx({ said: { 'started-vm': 'abc-89-a', 'stopped-again': true } });
  let release, during = null;
  const answer = ctx.cli;
  ctx.cli = async args => { during = machineScriptRunning(ctx, 'p', 'ABC-89', 'A'); await new Promise(r => { release = r; setImmediate(r); }); return answer(args); };
  const { project: p, t, v } = project(at());
  assert.equal(await readyTarget(ctx, p, t, v), 'cloud-vm-substrate');
  assert.equal(during, true, 'held as an in-machine script while it ran');
  assert.equal(machineScriptRunning(ctx, 'p', 'ABC-89', 'A'), false, 'and no longer after');
  assert.ok(release);
  assert.ok(ctx.lines.includes('run-targets ABC-89 A: started its stopped Lima VM abc-89-a to hand its branches over; stopped again'), ctx.lines.join('\n'));
});

test('AC3: a Lima VM found gone is logged with what was lost, and the hand-over is done (not tried again)', async () => {
  const ctx = bareCtx({ said: { 'missing-vm': 'abc-89-a', lost: 'whatever abc-89-a held that was never pushed (on the forge: repo change/ABC-89-1)' } });
  const { project: p, t, v } = project(at());
  assert.equal(await readyTarget(ctx, p, t, v), 'cloud-vm-substrate');
  assert.ok(ctx.lines.includes('run-targets ABC-89 A: its Lima VM abc-89-a no longer exists; its branches were taken from the forge instead. Lost: whatever abc-89-a held that was never pushed (on the forge: repo change/ABC-89-1)'), ctx.lines.join('\n'));
  assert.equal(ctx.memory.backoff.size, 0);
});
