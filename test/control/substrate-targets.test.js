// ASS-535: control's side of the three substrate run targets — placement (AC2), seats from the host's limits and a
// sandbox's measured use (AC3), the sandbox made before a step and hibernated or deleted off it with a fake Substrate
// client (AC1, AC6: ctx.cli stands in for the substrate:sandbox-* commands), the machine layer's naming, and the
// branch handed over when a step moves onto or off a sandbox (AC4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatch } from '../../src/control/plan.js';
import { placeSeats, targetOf, onSubstrateTarget, onMacTarget } from '../../src/control/seat-kinds.js';
import { projectRunTargets, candidates } from '../../src/control/run-targets.js';
import { machineOf, machinePaths, machineCommand, onSandbox, runTargetOf } from '../../src/control/machine.js';
import { vmOf } from '../../src/control/vm.js';
import { sandboxActor, sandboxMachine, parts } from '../../src/control/machine-substrate.js';
import { sandboxHost, sandboxWaits, sandboxUp, superviseSandboxes, syncSandboxTicket } from '../../src/control/sandboxes.js';
import { readyTarget } from '../../src/control/run-target-places.js';
import { activeSandboxes, sandboxNeed, clusterLoad, DEFAULTS } from '../../src/control/substrate-config.js';
import { macSandboxes, reserveOf, grantSeats } from '../../src/control/seat-budget.js';
import { machineSeats, remoteSandboxes, budgetRemote } from '../../src/control/remote-seats.js';

const GIB = 1024 ** 3;
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const cvm = { id: 'vm-1', 'gcp-project': 'g', zone: 'z' };
const prompt = (id, extra = {}) => ({ id, sequence: 2, name: id, 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }], ...extra });
const script = (id, command, extra = {}) => ({ id, sequence: 3, name: id, 'run-location': 'vm', action: { type: 'script', command }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }], ...extra });
const engineWith = (...steps) => ({ steps: [{ id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } }, ...steps, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] });
const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const ticket = (key, ...variations) => ({ key, variations });
const projectJson = (targets, clusters) => ({ name: 'p', 'dev-environments': { 'run-targets': targets, workstations: [ws], 'cloud-vms': [cvm], substrate: { clusters: clusters.map(machine => ({ machine })) } } });

// A fake control context: ctx.cli answers the substrate:sandbox-* commands as the fake Substrate client would,
// recording each call and the variation's `sandbox` the way the commands write it.
function fakeCtx({ fail = () => null } = {}) {
  const calls = [], lines = [];
  const records = new Map();
  let now = Date.parse('2026-11-22T12:00:00Z');
  const ctx = {
    memory: { warned: new Set(), backoff: new Map() }, calls, lines, records,
    attempt: async (phase, what, fn) => { try { await fn(); } catch (error) { lines.push(`error ${phase} ${what}: ${error.message}`); } },
    now: () => new Date(now), later: ms => { now += ms; },
    log: (phase, text) => lines.push(`${phase} ${text}`),
    cli: async args => {
      calls.push(args.join(' '));
      const why = fail(args);
      if (why) throw new Error(why);
      const [command, project, key, variation, machine] = args;
      const k = `${key} ${variation}`;
      if (command === 'substrate:sandbox-up') {
        const was = records.get(k);
        const r = { name: sandboxActor(key, variation), project, machine, template: 'sandbox-dddddddddddd', image: 'sha256:d', state: 'running' };
        records.set(k, r);
        return `${JSON.stringify({ ...r, machine: `substrate:${project}:${machine}:${r.name}`, host: machine, port: 18500, created: !was, branches: was ? [] : [{ repo: 'app', branch: `change/${key}-1` }] })}\n`;
      }
      if (command === 'substrate:sandbox-stop') { records.set(k, { ...records.get(k), state: 'stopped' }); return '{"stopped":true}\n'; }
      if (command === 'substrate:sandbox-delete') { records.delete(k); return '{"deleted":true,"branches":[]}\n'; }
      if (command === 'substrate:stack-up') return '{"stack":false}\n';   // ASS-542: no stack declared (its own test below)
      if (command === 'ticket:change-state') return 'moved\n';
      if (command === 'code:hand-over') return `${JSON.stringify({ from: null, to: key, branch: 'change/X-1', folder: null })}\n`;
      return '';
    },
  };
  return ctx;
}
const settle = () => new Promise(r => setTimeout(r, 0));
// ASS-582: the remote machines up (connected, set up since) and their clusters healthy (checked since), so a bring-up runs.
const upEntry = { connected: true, 'connected-at': '2026-11-20T10:00:00Z', setup: { ok: true, 'checked-at': '2026-11-20T10:01:00Z' } };
const healthy = { state: 'healthy', problems: [], 'checked-at': '2026-11-20T10:02:00Z' };
const up = { workstations: { 'ws-1': upEntry, 'vm-1': upEntry }, substrate: { 'ws-1': healthy, 'vm-1': healthy } };
async function drain(ctx) { for (let i = 0; i < 20; i++) await settle(); for (const r of ctx.memory.sandboxes?.values() ?? []) if (r.job) await r.job; for (const j of ctx.memory.sandboxJobs?.values() ?? []) await j; }

test('AC2: local-substrate takes a Mac seat, workstation-substrate a workstation\'s, cloud-vm-substrate a cloud VM\'s; a step takes the first of its targets the project allows with a free seat; a Docker step never a substrate one', () => {
  const rt = projectRunTargets(projectJson(['local-substrate', 'workstation-substrate', 'cloud-vm-substrate', 'local-vm'], ['mac', 'ws-1', 'vm-1']));
  const agentStep = prompt('build'), dockerStep = script('test', './agent.sh ci-checks:verify {project} {ticket} {variation}');
  assert.deepEqual(candidates(agentStep, rt), ['local-substrate', 'workstation-substrate', 'cloud-vm-substrate', 'local-vm']);
  assert.deepEqual(candidates(dockerStep, rt), ['local-vm']);
  const engine = engineWith(agentStep, dockerStep);
  const seats = { mac: 1, remote: 2, byKind: { workstation: 1, 'cloud-vm': 1 } };
  const p = planDispatch({ ranked: [ticket('T-1', at('build')), ticket('T-2', at('build')), ticket('T-3', at('build')), ticket('T-4', at('build'))], engine, harness: { 'max-agents': null }, seats, runTargets: rt });
  assert.deepEqual(p.targets.map(t => [t.key, t.target]), [['T-1', 'local-substrate'], ['T-2', 'workstation-substrate'], ['T-3', 'cloud-vm-substrate']]);
  assert.deepEqual(p.waiting, [{ key: 'T-4', variation: 'A' }]);
  // Placed as seats of their hosts: a Mac seat, the workstation's, the cloud VM's — each record with its target.
  const capacity = { mode: 'vm+workstation', vm: 1, workstations: [{ id: 'ws-1', seats: 1, lost: null }, { id: 'vm-1', seats: 1, lost: null, kind: 'cloud-vm' }], remote: 2 };
  const plans = Object.fromEntries(p.targets.map(t => [`${t.key} ${t.variation}`, { target: t.target, candidates: t.candidates }]));
  const placed = placeSeats({ records: [], reserved: p.targets.map(t => ({ key: t.key, variation: t.variation })), capacity, targetFor: (k, v) => plans[`${k} ${v}`], now: 'n' });
  assert.deepEqual(placed.records.map(r => [r.key, r.kind, r.workstation ?? null, r.target]), [['T-1', 'vm', null, 'local-substrate'], ['T-2', 'workstation', 'ws-1', 'workstation-substrate'], ['T-3', 'cloud-vm', 'vm-1', 'cloud-vm-substrate']]);
  const project = { seats: placed.records };
  assert.deepEqual(['T-1', 'T-2', 'T-3'].map(k => [targetOf(project, k, 'A'), onSubstrateTarget(project, k, 'A'), onMacTarget(project, k, 'A'), sandboxHost(project, k, 'A')]),
    [['local-substrate', true, false, 'mac'], ['workstation-substrate', true, false, 'ws-1'], ['cloud-vm-substrate', true, false, 'vm-1']]);
  // Its Docker test step: the local VM's seat (the step's only target), moved there between its steps.
  const next = placeSeats({ records: placed.records, reserved: [{ key: 'T-1', variation: 'A' }], capacity, targetFor: () => ({ target: 'local-vm', candidates: ['local-vm'] }), now: 'm' });
  assert.deepEqual(next.records.map(r => [r.key, r.kind, r.target]), [['T-1', 'vm', 'local-vm']]);
});

test('AC1, AC2: a step on a substrate target runs in the variation\'s own sandbox — the machine layer names it, its paths are a VM\'s, its commands go through sandbox-exec.js; another variation never shares it', () => {
  const v = at('build', { vm: { name: 'abc-3-a' }, sandbox: { name: 'abc-3-a', project: 'p', machine: 'mac', state: 'running' } });
  assert.equal(sandboxActor('ABC-3', 'A'), 'abc-3-a');
  assert.equal(sandboxActor('ABC-3', 'B'), 'abc-3-b');
  assert.equal(sandboxMachine(v), 'substrate:p:mac:abc-3-a');
  assert.equal(machineOf(v), 'abc-3-a');                                  // no target: its VM, as before
  assert.equal(machineOf(v, 'local-substrate'), 'substrate:p:mac:abc-3-a');
  assert.equal(machineOf({ ...v, 'run-target': { target: 'workstation-substrate' } }), 'substrate:p:mac:abc-3-a');   // its recorded run target
  assert.equal(machineOf(v, 'local-vm'), 'abc-3-a');
  assert.equal(vmOf(v, 'T', 'local-substrate'), 'substrate:p:mac:abc-3-a');
  assert.throws(() => vmOf(at('build'), 'ABC-3 A build', 'local-substrate'), /runs in its Substrate sandbox, and the variation has none yet/);
  assert.deepEqual(onSandbox('substrate:p:ws-1:abc-3-a'), { project: 'p', machine: 'ws-1', actor: 'abc-3-a' });
  assert.equal(onSandbox('abc-3-a'), null);
  assert.throws(() => parts('p:mac'), /not a sandbox machine/);
  const paths = machinePaths('substrate:p:ws-1:abc-3-a');
  assert.deepEqual([paths.repos, paths.ticket, paths.kind], ['/repos/', '/mnt/ticket', 'sandbox']);
  assert.match(paths.where, /own Substrate sandbox, abc-3-a, on ws-1/);
  const { argv } = machineCommand('substrate:p:mac:abc-3-a', ['claude', '-p'], { cwd: '/repos/app', marker: 'harness-step-1' });
  assert.deepEqual(argv.slice(1), [argv[1], '--sandbox', 'p:mac:abc-3-a', '--workdir', '/repos/app', '--marker', 'harness-step-1', '--', 'claude', '-p']);
  assert.match(argv[1], /src\/substrate\/sandbox-exec\.js$/);
});

for (const [target, seat, host] of [['local-substrate', { kind: 'vm' }, 'mac'], ['workstation-substrate', { kind: 'workstation', workstation: 'ws-1' }, 'ws-1'], ['cloud-vm-substrate', { kind: 'cloud-vm', workstation: 'vm-1' }, 'vm-1']]) {
  test(`AC1, AC6: on ${target}, the step waits while its sandbox is brought up on ${host === 'mac' ? 'the Mac' : host}'s cluster (substrate:sandbox-up, logged), then goes on; a failed bring-up is logged and tried again after the backoff`, async () => {
    let failing = true;
    const ctx = fakeCtx({ fail: a => (a[0] === 'substrate:sandbox-up' && failing ? 'substrate:sandbox-up: no worker has room' : null) });
    const variation = at('build');
    const t = ticket('ABC-3', variation);
    const project = { id: 'p', seats: [{ key: 'ABC-3', variation: 'A', target, ...seat }], tickets: [t], ...up };
    const step = prompt('build');
    assert.equal(sandboxWaits(ctx, {}, project, t, variation, step, 'ABC-3 A build'), true);
    await drain(ctx);
    assert.deepEqual(ctx.calls, [`substrate:sandbox-up p ABC-3 A ${host}`]);
    assert.match(ctx.lines.join('\n'), /error sandbox ABC-3 A: its sandbox on .* could not be brought up \(1 in a row; next try in/);
    assert.equal(sandboxWaits(ctx, {}, project, t, variation, step, 'ABC-3 A build'), true);   // backed off: not tried again yet
    await drain(ctx);
    assert.equal(ctx.calls.length, 1);
    failing = false;
    ctx.later(10 * 60e3);
    assert.equal(sandboxWaits(ctx, {}, project, t, variation, step, 'ABC-3 A build'), true);
    await drain(ctx);
    variation.sandbox = ctx.records.get('ABC-3 A');   // as the next tick loads it
    assert.equal(sandboxWaits(ctx, {}, project, t, variation, step, 'ABC-3 A build'), false);
    assert.equal(sandboxUp(ctx, project, t, variation), true);
    assert.match(ctx.lines.join('\n'), new RegExp(`sandbox ABC-3 A: its sandbox abc-3-a is up on ${host === 'mac' ? 'the Mac' : host} \\(made from sandbox-dddddddddddd\\), app on change/ABC-3-1 brought in`));
    assert.equal(ctx.calls.at(-1), 'substrate:stack-up p ABC-3 A --after created 0', 'ASS-542: its app stack right after');
    // A step working on no machine, or a variation on another target, never waits for one.
    assert.equal(sandboxWaits(ctx, {}, project, t, variation, { id: 'gate', action: { type: 'human' } }, 'w'), false);
    assert.equal(sandboxWaits(ctx, {}, { ...project, seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-vm' }] }, t, variation, step, 'w'), false);
    // Before its agent or script, /mnt/ticket brought up to date there.
    await syncSandboxTicket(ctx, project, t, variation, sandboxMachine(variation));
    assert.equal(ctx.calls.at(-1), 'substrate:sandbox-sync-ticket p ABC-3 A');
  });
}

test('AC1: a seat moved to another machine moves the sandbox — its work pushed out of the old one (--keep-work), a new one made on the new machine', async () => {
  const ctx = fakeCtx();
  const variation = at('build', { sandbox: { name: 'abc-3-a', project: 'p', machine: 'ws-1', state: 'running' } });
  const t = ticket('ABC-3', variation);
  const project = { id: 'p', seats: [{ key: 'ABC-3', variation: 'A', kind: 'cloud-vm', workstation: 'vm-1', target: 'cloud-vm-substrate' }], tickets: [t], ...up };
  assert.equal(sandboxWaits(ctx, {}, project, t, variation, prompt('build'), 'w'), true);
  await drain(ctx);
  assert.deepEqual(ctx.calls, ['substrate:sandbox-delete p ABC-3 A --keep-work', 'substrate:sandbox-up p ABC-3 A vm-1', 'substrate:stack-up p ABC-3 A --after created 0']);
});

test('AC1, AC3: off a substrate target — at a gate, holding no seat, or on the local VM once its branch has moved there — the sandbox is stopped (hibernated) once no agent or script runs; a done ticket\'s is deleted', async () => {
  const ctx = fakeCtx();
  const sandbox = machine => ({ name: 'abc-3-a', project: 'p', machine, state: 'running' });
  const engine = { steps: [{ id: 'gate', action: { type: 'human' } }, { id: 'test', 'run-location': 'vm', action: { type: 'script', command: 'x' } }, { id: 'done', 'is-done': true, action: { type: 'none' } }] };
  const a = at('gate', { sandbox: sandbox('mac'), 'run-target': { target: 'local-substrate' } });
  const b = { ...at('test', { sandbox: { ...sandbox('mac'), name: 'abc-3-b' }, 'run-target': { target: 'local-substrate' } }), name: 'B' };   // its branch not moved yet
  const c = { ...at('done', { sandbox: { ...sandbox('mac'), name: 'abc-3-c' } }), name: 'C' };
  const d = { ...at('test', { sandbox: { ...sandbox('mac'), name: 'abc-3-d' }, 'run-target': { target: 'local-substrate' } }), name: 'D' };   // still on its sandbox, an agent at work
  const project = { id: 'p', engine, tickets: [ticket('ABC-3', a, b, c, d)], seats: [{ key: 'ABC-3', variation: 'B', kind: 'vm', target: 'local-vm' }, { key: 'ABC-3', variation: 'D', kind: 'vm', target: 'local-substrate' }] };
  const state = { projects: [project], assignments: [{ project: 'p', 'work-item': 'ABC-3', variation: 'D' }] };
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.deepEqual(ctx.calls, ['substrate:sandbox-stop p ABC-3 A', 'substrate:sandbox-delete p ABC-3 C']);
  assert.match(ctx.lines.join('\n'), /sandbox ABC-3 A: its sandbox abc-3-a on mac stopped \(hibernated: its files and processes kept, no seat\): it holds no seat now/);
  assert.match(ctx.lines.join('\n'), /sandbox ABC-3 C: its sandbox abc-3-c on mac deleted: its ticket is done/);
  // B's branch has moved to its VM (code:hand-over recorded local-vm): now it is stopped too.
  b['run-target'] = { target: 'local-vm' };
  superviseSandboxes(ctx, state);
  await drain(ctx);
  assert.ok(ctx.calls.includes('substrate:sandbox-stop p ABC-3 B'), ctx.calls.join('; '));
});

test('AC4: a move onto or off a substrate target hands the branch over (code:hand-over, through the Mac) and records the target for the machine layer; machine to machine without a sandbox records nothing, as before', async () => {
  const ctx = fakeCtx();
  const variation = at('build', { 'run-target': { target: 'local-vm' }, vm: { name: 'abc-3-a' }, sandbox: { name: 'abc-3-a', project: 'p', machine: 'mac', state: 'running' } });
  const t = ticket('ABC-3', variation);
  const project = { id: 'p', seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }], tickets: [t] };
  assert.equal(await readyTarget(ctx, project, t, variation), 'local-substrate');
  assert.deepEqual(ctx.calls, ['code:hand-over p ABC-3 A local-substrate']);
  assert.equal(runTargetOf(variation).target, 'local-substrate');   // ASS-565: noted beside the loaded variation, not written onto it
  assert.equal(machineOf(variation), 'substrate:p:mac:abc-3-a');
  // Back to the local VM for the Docker step: handed over again.
  project.seats = [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-vm' }];
  await readyTarget(ctx, project, t, variation);
  assert.equal(ctx.calls.at(-1), 'code:hand-over p ABC-3 A local-vm');
  assert.equal(machineOf(variation), 'abc-3-a');
  // local-vm → workstation: as before ASS-535, nothing moves here.
  project.seats = [{ key: 'ABC-3', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation' }];
  await readyTarget(ctx, project, t, variation);
  assert.equal(ctx.calls.length, 2);
});

test('AC3: on the Mac, a project on sandboxes counts one ticket at a sandbox\'s measured use (rootfs writes included), its cluster\'s fixed part apart; a hibernated sandbox counts nothing', () => {
  const entry = { ...DEFAULTS, kind: 'kind', machine: 'mac', host: 'mac' };
  const live = { node: { running: true }, usage: { sandboxes: 2, 'sandbox-use': {
    'abc-3-a': { state: 'running', 'memory-bytes': 3 * GIB, 'cpu-percent': 40 },   // 3 GiB: its rootfs writes are in its pod's memory
    'abc-4-a': { state: 'running', 'memory-bytes': 1 * GIB, 'cpu-percent': 20 },
    'abc-5-a': { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0 },       // hibernated
  } } };
  assert.deepEqual(activeSandboxes(entry, live).map(s => [s.actor, s.memory / GIB, s.cpu]), [['abc-3-a', 3, 40], ['abc-4-a', 1, 20]]);
  assert.deepEqual(sandboxNeed(entry, live), { memory: 2 * GIB, cpu: 30 });
  assert.deepEqual(sandboxNeed(entry, { usage: {} }), { memory: DEFAULTS['sandbox-memory-gib'] * GIB, cpu: DEFAULTS['sandbox-cpu-percent'] });
  assert.equal(clusterLoad(entry, live).memory, (DEFAULTS['memory-gib'] + 4) * GIB);
  assert.equal(clusterLoad(entry, live, { sandboxes: false }).memory, DEFAULTS['memory-gib'] * GIB);
  // A project whose run targets put local-substrate first, with a Mac cluster: its reserve is the fixed part alone.
  const project = { id: 'p', json: projectJson(['local-substrate', 'local-vm'], ['mac']), runTargets: projectRunTargets(projectJson(['local-substrate', 'local-vm'], ['mac'])), substrate: { mac: live } };
  assert.equal(macSandboxes(project), true);
  assert.equal(macSandboxes({ ...project, runTargets: projectRunTargets(projectJson(['local-vm', 'local-substrate'], ['mac'])) }), false);
  assert.equal(reserveOf(project, [project]).memory, DEFAULTS['memory-gib'] * GIB);
  // Seats by the budget: with 10 GiB of room and 2 GiB a ticket, five more; at a VM's 4 GiB, two.
  const grant = per => grantSeats({ budget: { memory: 20 * GIB }, mac: { memory: 10 * GIB }, projects: [{ id: 'p', share: 100, canUse: true, want: 9, held: 0, starting: 0, per: { memory: per } }] }).get('p').seats;
  assert.deepEqual([grant(sandboxNeed(entry, live).memory), grant(4 * GIB)], [5, 2]);
});

test('AC3: on a workstation or cloud VM, its own limits — a sandbox holder whose sandbox runs is in the reading, one ticket a sandbox\'s use, the cluster\'s fixed part alone taken out; no ticket counts', async () => {
  const json = projectJson(['workstation-substrate', 'workstation'], ['ws-1']);
  const now = Date.parse('2026-11-22T12:00:00Z');
  const usage = { at: new Date(now - 10e3).toISOString(), memory: { 'total-bytes': 32 * GIB, 'available-bytes': 20 * GIB }, cpu: { cores: 8, samples: [{ at: new Date(now - 10e3).toISOString(), percent: 100 }] } };
  const live = { node: { running: true }, usage: { 'sandbox-use': { 't-1-a': { state: 'running', 'memory-bytes': 2 * GIB, 'cpu-percent': 50 }, 't-2-a': { state: 'suspended' } } } };
  const project = { id: 'p', engine: {}, json, runTargets: projectRunTargets(json), devEnvironments: { mode: 'vm+workstation', workstations: [{ ...ws }] },
    workstations: { 'ws-1': { connected: true, usage } }, substrate: { 'ws-1': live },
    seats: [{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-substrate' }] };
  assert.equal(remoteSandboxes(project, project.devEnvironments.workstations[0]), true);
  const ctx = { memory: {}, now: () => new Date(now), log: () => {}, paths: { projects: '/nonexistent' } };
  await budgetRemote(ctx, { projects: [project], harness: {} });
  const b = project.remoteBudget['ws-1'];
  assert.equal(b.pending, 0, 'its sandbox runs: in the reading');
  // 12 GiB used less the cluster's fixed 2.5, over one ticket: 9.5 GiB a ticket; under 90% of 32 GiB another fits.
  assert.equal(b['per-ticket']['memory-bytes'], Math.round(9.5 * GIB));
  assert.equal(b.seats, 2);
  // The floor on such a machine is a sandbox's expected use, not a VM's 4 GiB.
  const r = machineSeats({ entry: { connected: true, usage: { ...usage, memory: { 'total-bytes': 32 * GIB, 'available-bytes': 30 * GIB } } }, limits: { memory: 90, cpu: 90 }, held: 1, harness: {}, now, floor: { memory: 1.5 * GIB, cpu: 50 }, reserved: { memory: 2.5 * GIB, cpu: 30, running: true } });
  assert.equal(r.per.memory, 1.5 * GIB);
});

test('ASS-542 AC2: the app stack is brought up right after the sandbox (told whether it was made or resumed, and how long that took); one that fails sends the ticket to Blocked with the reason, once, the sandbox counted up so Blocked runs in it; tried again once the ticket has left Blocked', async () => {
  const ctx = fakeCtx();
  const inner = ctx.cli;
  let stackFails = true, resumedNext = false;
  ctx.cli = async args => {
    if (args[0] === 'substrate:stack-up') {
      ctx.calls.push(args.join(' '));
      if (!stackFails) return '{"state":"up","stack":true,"seconds":42,"app":{"url":"https://app.example.internal/","status":200},"login":{"ok":true},"session-kept":null}\n';
      throw Object.assign(new Error('agent.sh substrate:stack-up p ABC-3 A --after created 7: substrate:stack-up: ABC-3 A\'s app stack in its sandbox abc-3-a on ws-1 failed: job migrate: the job failed (exit 1) — its log: /d/work/ABC-3/sandbox-stack-A/logs/migrate.log'), { code: 3 });
    }
    if (args[0] === 'substrate:sandbox-up') {
      const out = JSON.parse(await inner(args));
      return `${JSON.stringify({ ...out, seconds: 7, created: !resumedNext, resumed: resumedNext })}\n`;
    }
    return inner(args);
  };
  const engine = { steps: [...engineWith(prompt('build')).steps, { id: 'blocked', sequence: 5, action: { type: 'prompt', prompt: 'b' } }, { id: 'blocked-for-human', sequence: 6, action: { type: 'human' } }] };
  const variation = at('build');
  const t = ticket('ABC-3', variation);
  const project = { id: 'p', engine, seats: [{ key: 'ABC-3', variation: 'A', target: 'workstation-substrate', kind: 'workstation', workstation: 'ws-1' }], tickets: [t], ...up };
  const step = prompt('build');
  assert.equal(sandboxWaits(ctx, {}, project, t, variation, step, 'ABC-3 A build'), true);
  await drain(ctx);
  assert.deepEqual(ctx.calls.slice(0, 3), ['substrate:sandbox-up p ABC-3 A ws-1', 'substrate:stack-up p ABC-3 A --after created 7', 'ticket:change-state p ABC-3 A build blocked']);
  assert.equal(ctx.calls.length, 4);
  assert.match(ctx.calls[3], /^ticket:set-ai-feedback p ABC-3 A ABC-3 A's app stack in its sandbox abc-3-a on ws-1 failed: job migrate: the job failed \(exit 1\) — its log: \/d\/work\/ABC-3\/sandbox-stack-A\/logs\/migrate\.log ABC-3 A's app stack .*migrate\.log\. Control brings a ticket's Substrate sandbox up .* sandbox-stack-A\/logs/);
  assert.match(ctx.lines.join('\n'), /error sandbox ABC-3 A: ABC-3 A's app stack in its sandbox abc-3-a on ws-1 failed: job migrate/);
  // In Blocked: the sandbox counts as up (Blocked's troubleshooting runs in it), nothing tried again.
  variation.sandbox = ctx.records.get('ABC-3 A');
  variation['harness-status'].state = 'blocked';
  const n = ctx.calls.length;
  assert.equal(sandboxWaits(ctx, {}, project, t, variation, prompt('blocked'), 'ABC-3 A blocked'), false);
  await drain(ctx);
  assert.equal(ctx.calls.length, n);
  // Its fix landed, the ticket back at its step: the stack is tried again, and up now (resumed this time).
  variation['harness-status'].state = 'build';
  stackFails = false; resumedNext = true;
  assert.equal(sandboxWaits(ctx, {}, project, t, variation, step, 'ABC-3 A build'), true);
  await drain(ctx);
  assert.deepEqual(ctx.calls.slice(n), ['substrate:sandbox-up p ABC-3 A ws-1', 'substrate:stack-up p ABC-3 A --after resumed 7']);
  assert.equal(sandboxWaits(ctx, {}, project, t, variation, step, 'ABC-3 A build'), false);
  assert.match(ctx.lines.join('\n'), /sandbox ABC-3 A: its app stack is up in abc-3-a \(42s, https:\/\/app\.example\.internal\/ answers 200, signed in as the seeded user\)/);
});
