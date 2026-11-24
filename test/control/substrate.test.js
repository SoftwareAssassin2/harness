// ASS-533: a project's Substrate clusters — dev-environments.substrate validated by field (AC1), control's health check
// every few minutes and its restart of a broken cluster (AC4), the header warning naming the machine (AC4), and each
// cluster's memory and CPU counted against its host's limits: the Mac's budget and the remote machine's own (AC5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { substrateErrors, substrateEntries, clusterHosts, clusterLoad, macLoad, remoteLoad, entriesOf, GKE_REFUSED, DEFAULTS } from '../../src/control/substrate-config.js';
import { superviseSubstrate, CHECK_EVERY, REPAIR_AFTER } from '../../src/control/substrate.js';
import { grantSeats, reserveOf } from '../../src/control/seat-budget.js';
import { machineSeats } from '../../src/control/remote-seats.js';
import { headerWarnings, SUBSTRATE_STALE_MS } from '../../src/tui/screens/frame.js';
import { initialState } from '../../src/tui/app.js';

const GIB = 1024 ** 3;
const remotes = { workstations: [{ id: 'ada-dev', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' }], 'cloud-vms': [{ id: 'vm-1', 'gcp-project': 'g', zone: 'z' }] };
// ASS-540's shape: dev-environments.substrate is an object; its clusters are this ticket's list.
const json = (clusters, d = remotes) => ({ 'dev-environments': { mode: 'vm+workstation', ...d, substrate: { clusters } } });

test('AC1: dev-environments.substrate accepts the Mac, each workstation or cloud VM, and a GKE entry; a bad entry is named by field', () => {
  const ok = json([{ machine: 'mac' }, { machine: 'ada-dev', 'warm-workers': 2 }, { machine: 'vm-1', 'memory-gib': 3 }, { machine: 'gke', 'gcp-project': 'example', location: 'europe-west1-b', cluster: 'harness' }]);
  assert.deepEqual(substrateErrors(ok), []);
  const entries = substrateEntries(ok);
  assert.deepEqual(entries.map(e => [e.machine, e.kind, e.host, e.cluster]), [['mac', 'kind', 'mac', 'harness-substrate'], ['ada-dev', 'kind', 'workstation', 'harness-substrate'], ['vm-1', 'kind', 'cloud-vm', 'harness-substrate'], ['gke', 'gke', 'gke', 'harness']]);
  assert.equal(entries[1]['warm-workers'], 2);
  assert.equal(entries[0]['memory-gib'], DEFAULTS['memory-gib']);
  assert.match(GKE_REFUSED, /^GKE is not approved yet/);
  // None: nothing changes for a project without one.
  assert.deepEqual(substrateErrors({}), []);
  assert.deepEqual(substrateEntries({ 'dev-environments': { mode: 'vm' } }), []);
  assert.deepEqual(substrateErrors(json({ machine: 'mac' })), ['dev-environments.substrate.clusters is not a list']);
  assert.deepEqual(substrateErrors({ 'dev-environments': { substrate: [{ machine: 'mac' }] } }), ['dev-environments.substrate is not an object']);
  assert.deepEqual(substrateErrors({ 'dev-environments': { substrate: { 'needs-docker': ['x'] } } }), [], 'ASS-540\'s needs-docker alone: no clusters');
  assert.deepEqual([...clusterHosts(ok)].sort(), ['cloud-vm', 'local', 'workstation']);
  assert.deepEqual([...clusterHosts(json([{ machine: 'gke', 'gcp-project': 'g', location: 'l', cluster: 'c' }]))], [], 'GKE gives no host until approved');
  assert.deepEqual(substrateErrors(json([
    'mac', {}, { machine: 'nope' }, { machine: 'mac' }, { machine: 'mac', 'warm-workers': 1.5 }, { machine: 'gke', location: 'x' }, { machine: 'vm-1', colour: 'red', 'memory-gib': 100 },
  ])), [
    'dev-environments.substrate.clusters[0] is not an object',
    'dev-environments.substrate.clusters[1].machine is missing',
    'dev-environments.substrate.clusters[2].machine "nope" is not "mac", "gke" nor one of the project\'s workstations or cloud VMs (ada-dev, vm-1)',
    'dev-environments.substrate.clusters[4].machine "mac" has an earlier entry too (one cluster per machine)',
    'dev-environments.substrate.clusters[4].warm-workers is not a whole number from 0 to 32',
    'dev-environments.substrate.clusters[5].gcp-project is missing (a GKE entry names its gcp-project, location and cluster)',
    'dev-environments.substrate.clusters[5].cluster is missing (a GKE entry names its gcp-project, location and cluster)',
    'dev-environments.substrate.clusters[6].memory-gib is not a number from 0.5 to 64',
    'dev-environments.substrate.clusters[6].colour is not a substrate setting (machine, memory-gib, cpu-percent, sandbox-memory-gib, sandbox-cpu-percent, warm-workers, worker-memory-gib, worker-cpus)',
  ]);
  assert.match(substrateErrors(json([{ machine: 'mac' }], { workstations: [{ id: 'mac' }] }))[0], /machine "mac" is ambiguous: a workstation has that id too/);
  assert.throws(() => substrateEntries(json([{ machine: 'nope' }])), /project\.json: dev-environments\.substrate\.clusters\[0\]\.machine "nope"/);
});

// A loaded project as state.js gives it: its json, its live substrate.json, its workstations' live data.
const project = (id, substrate, live = {}, workstations = {}) => ({ id, json: json(substrate), substrate: live, workstations });

test('AC5: a cluster costs its fixed memory and CPU plus its active sandboxes; the Mac\'s fixed cost is split between the projects sharing it', () => {
  const [e] = substrateEntries(json([{ machine: 'mac' }]));
  // ASS-537 AC3: plus its warm workers' memory requests — one warm worker (warm-workers) at 256 MiB with no sandbox on it.
  const POOL = 256 * 1024 ** 2;
  assert.deepEqual(clusterLoad(e, null), { memory: 2.5 * GIB + POOL, cpu: 30, running: false, sandboxes: 0, pool: POOL });
  assert.deepEqual(clusterLoad(e, { node: { running: true }, usage: { sandboxes: 2 } }), { memory: 5.5 * GIB, cpu: 230, running: true, sandboxes: 2, pool: 0 });
  const a = project('a', [{ machine: 'mac' }], { mac: { node: { running: true }, usage: { sandboxes: 1 } } }), b = project('b', [{ machine: 'mac' }]), c = project('c', []);
  assert.deepEqual(macLoad(a, [a, b, c]), { memory: 1.25 * GIB + 1.5 * GIB, cpu: 15 + 100, running: true, sandboxes: 1, pool: 0 });
  assert.equal(macLoad(c, [a, b, c]), null);
  assert.deepEqual(reserveOf(b, [a, b, c]), { memory: 1.25 * GIB + POOL, cpu: 15, pending: true, pool: POOL });   // its own pool, never split
  const r = project('r', [{ machine: 'ada-dev', 'memory-gib': 3 }], { 'ada-dev': { node: { running: true } } });
  assert.deepEqual(remoteLoad(r, 'ada-dev'), { memory: 3 * GIB + POOL, cpu: 30, running: true, sandboxes: 0, pool: POOL });
  assert.equal(remoteLoad(r, 'vm-1'), null);
  assert.deepEqual(entriesOf({ id: 'x', json: json([{ machine: 'nope' }]) }), [], 'a wrong list counts nothing');
});

test('AC5: the Mac\'s budget — a project\'s part of the cluster comes off its allotment before its seats, and off the Mac\'s room while the cluster is not up', () => {
  const budget = { memory: 40 * GIB, cpu: null }, idle = { memory: 0, cpu: 0, cpuFull: false };
  const p = (id, share, want, extra = {}) => ({ id, share, canUse: true, want, held: 0, starting: 0, per: { memory: 4 * GIB, cpu: 100 }, ...extra });
  const seatsOf = m => Object.fromEntries([...m].map(([id, r]) => [id, r.seats]));
  // Without a cluster: 5 and 5. A running cluster's 2.5 GiB of a's 20: a fits 4.
  assert.deepEqual(seatsOf(grantSeats({ budget, mac: idle, projects: [p('a', 50, 20), p('b', 50, 20)] })), { a: 5, b: 5 });
  assert.deepEqual(seatsOf(grantSeats({ budget, mac: idle, projects: [p('a', 50, 20, { reserve: { memory: 2.5 * GIB, cpu: 30, pending: false } }), p('b', 50, 20)] })), { a: 4, b: 5 });
  // Not up yet: it also takes the Mac's room — 40 GiB less 36 used leaves one 4 GiB ticket, but not with a 2.5 GiB cluster to come.
  const full = { memory: 36 * GIB, cpu: 0, cpuFull: false };
  assert.deepEqual(seatsOf(grantSeats({ budget, mac: full, projects: [p('a', 50, 20), p('b', 50, 20)] })), { a: 1, b: 0 });
  assert.deepEqual(seatsOf(grantSeats({ budget, mac: full, projects: [p('a', 50, 20, { reserve: { memory: 2.5 * GIB, cpu: 30, pending: true } }), p('b', 50, 20)] })), { a: 0, b: 0 });
});

test('AC5: a remote machine\'s own limits — its cluster counts in its use, and is not taken for a ticket\'s', () => {
  const NOW = Date.parse('2026-11-22T12:00:00Z'), iso = ms => new Date(ms).toISOString();
  const entry = (total, used) => ({ connected: true, usage: { at: iso(NOW), error: null, memory: { 'total-bytes': total * GIB, 'available-bytes': (total - used) * GIB }, cpu: { cores: 8, samples: [{ at: iso(NOW), percent: 100 }] } } });
  const limits = { memory: 90, cpu: 90 };
  // 32 GiB, 1 ticket on it using 8 GiB with the cluster's 2.5: one ticket is 5.5 GiB, not 8.
  const up = machineSeats({ entry: entry(32, 8), limits, held: 1, now: NOW, reserved: { memory: 2.5 * GIB, cpu: 30, running: true } });
  assert.equal(up.per.memory, 5.5 * GIB);
  assert.equal(up.used.memory, 8 * GIB);
  // 16 GiB, 1 ticket using 8: a second 8 GiB ticket fits 14.4 GiB? No — 16. With a cluster still to come (2.5 GiB) even less.
  assert.equal(machineSeats({ entry: entry(16, 4), limits, held: 1, now: NOW }).seats, 2);
  const pending = machineSeats({ entry: entry(16, 4), limits, held: 1, now: NOW, reserved: { memory: 7 * GIB, cpu: 30, running: false } });
  assert.equal(pending.used.memory, 11 * GIB);
  assert.equal(pending.seats, 1, 'the cluster to come takes the room a second ticket would have had');
});

// A control context for the phase: ctx.cli answers substrate:health from `health` (machine → result, or a function), and
// substrate:up by recording it.
function ctxFor(health, { now = Date.parse('2026-11-22T12:00:00Z') } = {}) {
  const logs = [], calls = [];
  const ctx = {
    memory: {}, env: {}, log: (phase, line) => logs.push(`${phase} ${line}`), now: () => new Date(ctx.t),
    cli: async (args, env) => {
      calls.push([...args, ...(env ? [env] : [])]);
      if (args[0] === 'substrate:health') { const h = typeof health === 'function' ? health(args[2]) : health[args[2]]; if (h instanceof Error) throw h; return JSON.stringify(h); }
      if (args[0] === 'substrate:up') return `${JSON.stringify({ ok: true, did: ['started the cluster\'s node harness-substrate-control-plane'] })}\n`;
      throw new Error(`unexpected ${args[0]}`);
    },
  };
  ctx.t = now;
  return { ctx, logs, calls };
}
const tick = async (ctx, state) => { superviseSubstrate(ctx, state); await Promise.all([...ctx.memory.substrate.values()].map(r => r.job)); };
const broken = (what, repair = true) => ({ ok: false, state: 'broken', problems: [{ what, why: `${what} is wrong`, repair }] });

test('AC4: control checks each cluster every few minutes, restarts one broken on two checks in a row (at once when its node is down), never for what a restart cannot fix', async () => {
  let h = { ok: true, state: 'healthy', problems: [] };
  const { ctx, logs, calls } = ctxFor(() => h);
  const state = { harness: {}, projects: [project('p', [{ machine: 'mac' }])] };
  await tick(ctx, state);
  assert.deepEqual(calls, [['substrate:health', 'p', 'mac']]);
  await tick(ctx, state);
  assert.equal(calls.length, 1, 'not again before CHECK_EVERY');
  ctx.t += CHECK_EVERY;
  h = broken('rustfs');
  await tick(ctx, state);
  assert.equal(calls.filter(c => c[0] === 'substrate:up').length, 0, 'one broken check is not enough');
  ctx.t += CHECK_EVERY;
  await tick(ctx, state);
  assert.equal(REPAIR_AFTER, 2);
  assert.deepEqual(calls.at(-1), ['substrate:up', 'p', 'mac', { HARNESS_SUBSTRATE_REPAIR: '1' }]);
  assert.ok(logs.some(l => /^substrate p mac: restarting the cluster \(substrate:up\): rustfs: rustfs is wrong$/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /^substrate p mac: restarted: started the cluster's node/.test(l)));
  // A node down: restarted at the first check. A missing cluster alike.
  ctx.t += CHECK_EVERY;
  h = broken('node');
  await tick(ctx, state);
  assert.equal(calls.at(-1)[0], 'substrate:up');
  ctx.t += CHECK_EVERY;
  h = { ok: false, state: 'missing', problems: [{ what: 'cluster', why: 'none', repair: true }] };
  await tick(ctx, state);
  assert.equal(calls.at(-1)[0], 'substrate:up');
  // Docker short of memory, a template's golden snapshot: reported only, never restarted.
  const ups = calls.filter(c => c[0] === 'substrate:up').length;
  for (let i = 0; i < 3; i++) { ctx.t += CHECK_EVERY; h = broken('templates', false); await tick(ctx, state); }
  assert.equal(calls.filter(c => c[0] === 'substrate:up').length, ups);
  // Starting (the node just restarted): waits.
  ctx.t += CHECK_EVERY; h = { ok: false, state: 'starting', problems: [{ what: 'pods', why: 'x', repair: true }] }; await tick(ctx, state);
  ctx.t += CHECK_EVERY; await tick(ctx, state);
  assert.equal(calls.filter(c => c[0] === 'substrate:up').length, ups);
});

test('AC4: a failed restart backs off; none under the disk hold or a credentials hold; a remote cluster is checked only while its machine is connected and set up; GKE is refused, logged once; a wrong list is logged by field', async () => {
  const fail = { calls: 0 };
  const { ctx, logs, calls } = ctxFor({ mac: broken('node'), 'ada-dev': { ok: true, state: 'healthy', problems: [] } });
  const cli = ctx.cli;
  ctx.cli = async (args, env) => { if (args[0] === 'substrate:up') { fail.calls++; calls.push(args); throw new Error('agent.sh substrate:up p mac: kind create cluster failed'); } return cli(args, env); };
  const p = project('p', [{ machine: 'mac' }, { machine: 'ada-dev' }, { machine: 'gke', 'gcp-project': 'g', location: 'l', cluster: 'c' }]);
  const state = { harness: {}, projects: [p] };
  await tick(ctx, state);
  assert.equal(fail.calls, 1);
  assert.ok(logs.some(l => /^error substrate p mac: substrate:up failed \(1 in a row; next try in 30s\)/.test(l)), logs.join('\n'));
  assert.ok(!calls.some(c => c[2] === 'ada-dev'), 'ada-dev is not connected: not checked');
  assert.equal(logs.filter(l => /p gke: refused: GKE is not approved yet/.test(l)).length, 1);
  ctx.t += CHECK_EVERY;
  p.workstations = { 'ada-dev': { connected: true, setup: { ok: true } } };
  await tick(ctx, state);
  assert.ok(calls.some(c => c[0] === 'substrate:health' && c[2] === 'ada-dev'));
  assert.equal(fail.calls, 2, 'tried again after its backoff');
  assert.equal(logs.filter(l => /gke: refused/.test(l)).length, 1, 'GKE logged once');
  // The disk hold, and a credentials hold: no restart, said once.
  ctx.t += 10 * CHECK_EVERY;
  await tick(ctx, { ...state, diskSpace: { level: 'hold' } });
  ctx.t += CHECK_EVERY;
  await tick(ctx, { ...state, diskSpace: { level: 'hold' } });
  assert.equal(fail.calls, 2);
  assert.equal(logs.filter(l => /p mac: not restarted while the disk hold is on/.test(l)).length, 1);
  ctx.t += CHECK_EVERY;
  p.credentialsHold = { problems: [{ credential: 'x', problem: 'y', fix: 'z' }] };
  await tick(ctx, state);
  assert.equal(fail.calls, 2);
  assert.ok(logs.some(l => /not restarted while the project is held by its credentials/.test(l)));
  // A wrong list: logged by field, once; nothing checked.
  const before = calls.length;
  const bad = { harness: {}, projects: [project('q', [{ machine: 'nope' }])] };
  await tick(ctx, bad); ctx.t += CHECK_EVERY; await tick(ctx, bad);
  assert.equal(calls.length, before);
  assert.equal(logs.filter(l => /^error substrate q: its dev-environments\.substrate\.clusters is wrong, so none of its clusters is checked or set up until it is fixed: dev-environments\.substrate\.clusters\[0\]\.machine "nope"/.test(l)).length, 1);
  // Background work off: nothing checked.
  const off = { harness: {}, projects: [{ ...project('r', [{ machine: 'mac' }]), json: { ...json([{ machine: 'mac' }]), 'background-work': false } }] };
  await tick(ctx, off);
  assert.equal(calls.length, before);
});

test('AC4: the header shows a broken cluster as a chip naming its machine, saying whether control restarts it or what to fix; a stale check shows none', () => {
  const now = Date.parse('2026-11-22T12:00:00Z'), at = new Date(now - 60e3).toISOString();
  const sprint = { number: 10, start: '2026-11-16', end: '2026-11-29', features: [], bugs: [], spikes: [] };
  const stateOf = substrate => initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint, substrate, limits: { project: {}, harness: {} } }], workflows: [{ name: 'e', steps: [] }], assignments: [] });
  const chips = s => headerWarnings(stateOf(s), now).filter(w => w.id.startsWith('substrate:'));
  assert.deepEqual(chips({ mac: { state: 'healthy', problems: [], 'checked-at': at } }), []);
  const [mac] = chips({ mac: { state: 'broken', problems: [{ what: 'rustfs', why: 'no endpoints', repair: true }], 'checked-at': at } });
  assert.deepEqual([mac.text, mac.chip, mac.scope], ['Substrate mac broken', true, 'project']);
  assert.match(mac.todo, /^Control restarts the Substrate cluster on mac \(substrate:up p mac\); if it stays broken: rustfs: no endpoints$/);
  const [ws] = chips({ 'ada-dev': { state: 'broken', problems: [{ what: 'docker', why: 'not answering', repair: false }], 'checked-at': at } });
  assert.equal(ws.text, 'Substrate ada-dev broken');
  assert.match(ws.todo, /^Fix the Substrate cluster on ada-dev: docker: not answering$/);
  // ASS-539: Docker's memory alone is its own warning (substrate-memory:<machine>), not the cluster's.
  assert.deepEqual(chips({ 'ada-dev': { state: 'broken', problems: [{ what: 'docker memory', why: 'Docker has 2.0 GiB', repair: false }], 'checked-at': at } }), []);
  assert.equal(chips({ mac: { state: 'missing', problems: [], 'checked-at': at } })[0].text, 'Substrate mac cluster missing');
  assert.equal(chips({ mac: { state: 'docker-down', problems: [], 'checked-at': at } })[0].text, 'Substrate mac Docker down');
  assert.deepEqual(chips({ mac: { state: 'broken', problems: [], 'checked-at': new Date(now - SUBSTRATE_STALE_MS - 1).toISOString() } }), []);
});

test('a cloud VM\'s idle disconnect stops its cluster\'s node first (its own idle check counts the cluster\'s load as busy); a workstation\'s does not', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { superviseWorkstations } = await import('../../src/control/workstations.js');
  const run = async kind => {
    const dir = mkdtempSync(join(tmpdir(), 'idle-'));
    mkdirSync(join(dir, 'p'));
    writeFileSync(join(dir, 'p', 'workstations.json'), JSON.stringify({ m: { connected: true, setup: { ok: true } } }));
    const machine = kind === 'cloud-vm' ? { kind, id: 'm', 'gcp-project': 'g', zone: 'z' } : { id: 'm', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
    const d = kind === 'cloud-vm' ? { 'cloud-vms': [{ id: 'm', 'gcp-project': 'g', zone: 'z' }] } : { workstations: [{ id: 'm', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' }] };
    const project = { id: 'p', json: { 'dev-environments': { mode: 'vm+workstation', ...d, substrate: { clusters: [{ machine: 'm' }] } } }, devEnvironments: { mode: 'vm+workstation', workstations: [machine] }, tickets: [], workstations: {} };
    let t = 0;
    const calls = [], logs = [];
    const ctx = {
      memory: {}, env: {}, paths: { projects: dir }, now: () => new Date(t), log: (a, b) => logs.push(`${a} ${b}`), load: () => ({ projects: [project] }),
      cli: async a => { calls.push(a.join(' ')); return a[0] === 'substrate:stop' ? '{"ok":true,"did":["stopped the cluster\'s node"]}' : '{}'; },
      attempt: async (p, w, fn) => { try { await fn(); } catch (e) { logs.push(`error ${e.message}`); } },
    };
    for (const dt of [0, 301e3]) { t += dt; superviseWorkstations(ctx, { projects: [project], assignments: [], harness: {} }); await ctx.memory.workstations.get('p').job; }
    return { calls, logs };
  };
  const vm = await run('cloud-vm');
  assert.deepEqual(vm.calls, ['substrate:stop p m', 'workstation:disconnect p m']);
  assert.ok(vm.logs.some(l => /^workstation p m: stopped its Substrate cluster's node \(its state kept\) so it can stop itself when idle$/.test(l)));
  assert.deepEqual((await run('workstation')).calls, ['workstation:disconnect p m']);
});
