// ASS-539: Substrate machines on the dashboard. AC1: the project's sandboxes on every machine (the Mac, each workstation
// and cloud VM; ASS-572: each machine card's On it on the n screen, the footer's "substrate sandboxes" box before) — ticket, state, memory and CPU — and
// they are listed there alone (ASS-535 had them under each machine). AC2: the header warnings for a cluster down, a
// template with no golden snapshot, a failed image build, a failed sandbox setup, Docker's memory low and snapshot
// disk use high, each with its fix (test/notify/header-warnings.test.js shows each notifying once); control records
// the failed setups for it (sandboxes.js recordSandboxFailures). AC3: the cluster's memory and CPU with the project's
// other use. AC4: the docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState } from '../../src/tui/app.js';
import { platform, headerWarnings, SUBSTRATE_STALE_MS } from '../../src/tui/screens/frame.js';
import { ticketsOn } from '../../src/tui/machine-tickets.js';   // ASS-572: each n screen card's On it (the machine boxes' before)
import { cardOf, onIt } from '../support/network-fixture.js';
import { view as networkView } from '../../src/tui/screens/network.js';
import { visible } from '../../src/tui/text.js';
import { loadProjects } from '../../src/tui/load.js';
import { liveWarnings } from '../../src/notify/warnings.js';
import { sandboxWaits, superviseSandboxes, sandboxFailures } from '../../src/control/sandboxes.js';
import { imageBuildFailed, loadSandboxImages, loadSandboxFailures, SANDBOX_FAILURES_FILE } from '../../src/control/substrate-config.js';
import { ticketKey } from '../../src/control/backoff.js';

const ROOT = join(import.meta.dirname, '..', '..');
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const GIB = 2 ** 30;
const now = new Date('2026-11-22T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const recordAt = iso(now.getTime() - 10 * 60e3), checkedAt = iso(now.getTime() - 60e3);

const steps = [
  { id: 'build', name: 'Build', sequence: 1, action: { type: 'prompt' } },
  { id: 'lint', name: 'Lint', sequence: 2, action: { type: 'script' } },
  { id: 'done', name: 'Done', sequence: 9, 'is-done': true },
];
const at = (state, extra = {}) => ({ 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const sandbox = (key, variation, machine, state) => ({ sandbox: { name: `${key}-${variation}`.toLowerCase(), project: 'p', machine, template: 'sandbox-0123456789ab', state, 'created-at': recordAt, at: recordAt } });
const sprint = {
  number: 1, start: '2026-11-16', end: '2026-11-29', bugs: [], spikes: [],
  features: [
    { key: 'SB-1', title: 'T', variations: [{ name: 'A', ...at('build', sandbox('SB-1', 'A', 'mac', 'running')) }] },              // on the Mac, its agent working
    { key: 'SB-2', title: 'T', variations: [{ name: 'A', ...at('build', sandbox('SB-2', 'A', 'ws-1', 'stopped')) }] },             // hibernated on a workstation
    { key: 'SB-3', title: 'T', variations: [{ name: 'A', ...at('lint') }, { name: 'B', ...at('lint') }] },                           // B seated on the cloud VM, no sandbox yet
    { key: 'SB-4', title: 'T', variations: [{ name: 'A', ...at('build', sandbox('SB-4', 'A', 'cvm-1', 'running')) }] },            // running, not measured yet
  ],
};
const live = {
  mac: { state: 'healthy', problems: [], 'checked-at': checkedAt, usage: { 'sandbox-use': {
    'sb-1-a': { state: 'running', 'memory-bytes': 1.5 * GIB, 'cpu-percent': 42.4, 'snapshot-bytes': 0 },
    'old-9-a': { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0, 'snapshot-bytes': 0.2 * GIB },   // no variation names it
  } } },
  'ws-1': { state: 'healthy', problems: [], 'checked-at': checkedAt, usage: { 'sandbox-use': { 'sb-2-a': { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0, 'snapshot-bytes': 0.2 * GIB } } } },
};
const settings = { mode: 'vm+workstation', workstations: [{ id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' }, { kind: 'cloud-vm', id: 'cvm-1', 'gcp-project': 'g', zone: 'z' }] };
const project = (extra = {}) => ({
  id: 'p', name: 'P', environments: [], stateEngine: 'e', sprint, devEnvironments: settings, runTargets: ['local-substrate', 'workstation-substrate', 'cloud-vm-substrate', 'local-vm'],
  substrateMachines: ['mac', 'ws-1', 'cvm-1'], substrate: live, localSeats: [], vms: {}, workstations: {}, limits: { project: {}, harness: {} },
  seats: [
    { key: 'SB-1', variation: 'A', kind: 'vm', target: 'local-substrate' },
    { key: 'SB-3', variation: 'B', kind: 'cloud-vm', workstation: 'cvm-1', target: 'cloud-vm-substrate' },
    { key: 'SB-4', variation: 'A', kind: 'cloud-vm', workstation: 'cvm-1', target: 'cloud-vm-substrate' },
  ],
  seatBudget: { seats: 4, share: 50, allotment: { seats: 3, 'memory-bytes': 12 * GIB, 'cpu-percent': 400 }, used: { seats: 1, 'memory-bytes': 2 * GIB, 'cpu-percent': 50, substrate: { 'memory-bytes': 2.9 * GIB, 'cpu-percent': 15, running: true, 'pool-memory-bytes': 0.25 * GIB } }, mac: { 'memory-used-bytes': 20 * GIB, 'memory-budget-bytes': 40 * GIB, 'cpu-percent': 300, 'cpu-budget-percent': 1260, 'cpu-capacity-percent': 1400, over: [] } },
  ...extra,
});
const team = [{ project: 'p', 'agent-name': 'X', 'work-item': 'SB-1', variation: 'A', model: 'opus-5' }];
const stateOf = (p, more = {}) => ({ ...initialState({ projects: [p], workflows: [{ name: 'e', steps }], assignments: team, controls: { p: { pid: 1, startTime: '2026-11-22T08:00:00Z' } } }), ...more });

// ASS-572: the sandboxes are in each machine card's "On it" on the n screen now (machine-tickets.js ticketsOn), the
// substrate sandboxes box's before (ASS-566 moved it there from the footer).
const on = (p, machine, more = {}) => ticketsOn(stateOf(p, more), p, machine, { cpuCapacity: machine === 'mac' ? 1400 : null }).map(e => strip(e.text));
const card = (p, id, columns = 120) => cardOf(networkView(stateOf(p), { columns, now: now.getTime() }), id);

test('AC1: each machine card lists the project\'s sandboxes on it — ticket, activity, state (running, hibernated, starting), memory and CPU', () => {
  assert.deepEqual(on(project(), 'mac'), [
    '📦 SB-1 sandbox · 🤖 Build · running 1.5 GiB 3% CPU',   // the check newer than the record: its measured use, CPU of the whole Mac
    '📦 old-9-a sandbox · hibernated (0.2 GiB snapshot)',      // measured on the Mac's cluster, no variation names it
  ]);
  assert.deepEqual(on(project(), 'ws-1'), ['📦 SB-2 sandbox · hibernated (0.2 GiB snapshot)']);   // hibernated: no memory or CPU, its snapshot's disk
  assert.deepEqual(on(project(), 'cvm-1'), [
    '📦 SB-4 sandbox · running not measured',                  // running, before its cluster's next check
    '📦 SB-3 B sandbox · 💻 Lint · starting',                  // seated on a substrate target, no sandbox there yet (its script step waits)
  ]);
  // Colours: running green, hibernated and starting gray.
  const raw = [...ticketsOn(stateOf(project()), project(), 'mac'), ...ticketsOn(stateOf(project()), project(), 'cvm-1')].map(e => e.text).join('\n');
  assert.ok(raw.includes('\x1b[32mrunning'), raw);
  assert.ok(raw.includes('\x1b[90mhibernated'), raw);
  assert.ok(raw.includes('\x1b[90mstarting'), raw);
  // On the n screen, in its machine's card.
  assert.deepEqual(onIt(card(project(), 'ws-1')), ['📦 SB-2 sandbox · hibernated (0.2 GiB snapshot)']);
});

test('AC1: a record newer than the check wins (resumed since); hibernating while it suspends', () => {
  const resumed = { ...sprint, features: [{ key: 'SB-2', title: 'T', variations: [{ name: 'A', ...at('build', { sandbox: { ...sandbox('SB-2', 'A', 'ws-1', 'running').sandbox, at: iso(now.getTime()) } }) }] }] };
  const p = project({ sprint: resumed, seats: [] });
  assert.deepEqual(on(p, 'mac'), ['📦 sb-1-a sandbox · running 1.5 GiB 3% CPU', '📦 old-9-a sandbox · hibernated (0.2 GiB snapshot)']);
  assert.deepEqual(on(p, 'ws-1'), ['📦 SB-2 sandbox · running not measured']);
  const suspending = project({ substrate: { mac: { ...live.mac, usage: { 'sandbox-use': { 'sb-1-a': { state: 'suspending', 'memory-bytes': GIB, 'cpu-percent': 14 } } } } } });
  assert.equal(on(suspending, 'mac')[0], '📦 SB-1 sandbox · 🤖 Build · hibernating 1.0 GiB 1% CPU');
});

test('AC1: a sandbox is listed once, on its own machine\'s card — not as a Lima VM on the Mac (ASS-535 had them under each machine)', () => {
  const lines = networkView(stateOf(project()), { columns: 120, now: now.getTime() }).map(strip).join('\n');
  assert.equal(lines.match(/📦 SB-1/g).length, 1);
  assert.ok(!on(project(), 'mac').some(l => l.startsWith('💺')), 'SB-1 holds a VM seat record, but on local-substrate');
});

test('AC1: a machine with nothing of the project says so', () => {
  const empty = project({ sprint: { ...sprint, features: [] }, seats: [], substrate: {} });
  assert.deepEqual(onIt(card(empty, 'ws-1')), ['nothing of its project']);
});

test('AC1: long keys are cut, more than four tickets on a machine end in "+N more", and the footer and the n screen fit 120 columns', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ key: `VERY-LONG-PROJECT-${i}`, title: 'T', variations: [{ name: 'B', ...at('build', sandbox(`VERY-LONG-PROJECT-${i}`, 'B', 'cvm-1', 'running')) }] }));
  const p = project({ sprint: { ...sprint, features: many }, seats: [], substrate: { 'cvm-1': { state: 'healthy', 'checked-at': checkedAt, usage: { 'sandbox-use': Object.fromEntries(many.map(t => [`${t.key}-b`.toLowerCase(), { state: 'running', 'memory-bytes': 999 * GIB, 'cpu-percent': 9999 }])) } } } });
  assert.equal(on(p, 'cvm-1')[0], '📦 VERY-LONG-PRO… B sandbox · running 999.0 GiB');
  const items = onIt(card(p, 'cvm-1'));
  assert.equal(items.length, 4);
  assert.equal(items.at(-1), '+8 more');
  for (const columns of [120, 160, 240]) for (const line of [...platform(stateOf(p), columns, now.getTime()), ...networkView(stateOf(p), { columns, now: now.getTime() })]) assert.ok(visible(line) <= columns, `${visible(line)} > ${columns}: ${strip(line)}`);
});

test('AC3: the Mac\'s cluster\'s memory and CPU (the project\'s part) show on the Mac card, and each remote cluster\'s on its machine\'s', () => {
  const cluster = (p, id) => card(p, id, 160).lines.find(l => l.startsWith('Cluster'));
  assert.equal(cluster(project(), 'mac'), 'Cluster ● healthy · 2.9 GiB · 1% CPU');
  const notUp = project({ substrate: {}, seatBudget: { ...project().seatBudget, used: { ...project().seatBudget.used, substrate: { 'memory-bytes': 2.5 * GIB, 'cpu-percent': 30, running: false } } } });
  assert.equal(cluster(notUp, 'mac'), 'Cluster ○ not up · 2.5 GiB · 2% CPU');
  const noCluster = project({ substrate: {}, seatBudget: { ...project().seatBudget, used: { seats: 1 } } });
  assert.equal(cluster(noCluster, 'mac'), undefined);
  const remote = project({ remoteBudget: { 'ws-1': { held: 1, seats: 2, state: 'measured', limits: { memory: 90, cpu: 90 }, 'memory-used-bytes': 8 * GIB, 'memory-budget-bytes': 28 * GIB, 'cpu-percent': 120, 'cpu-budget-percent': 720, substrate: { 'memory-bytes': 2.75 * GIB, 'cpu-percent': 30, running: true } } } });
  assert.equal(cluster(remote, 'ws-1'), 'Cluster ● healthy · 2.8 GiB · 4% CPU');
  // A cluster in trouble says so in red.
  const broken = project({ substrate: { ...live, 'ws-1': { state: 'missing', problems: [], 'checked-at': checkedAt } } });
  assert.equal(cluster(broken, 'ws-1'), 'Cluster ● cluster missing');
});

// AC2 — each warning's text and fix; the notify-once part is in test/notify/header-warnings.test.js.
const warn = p => headerWarnings(stateOf(p), now.getTime());
const ids = p => warn(p).map(w => w.id);
const check = (state, problems, extra = {}) => ({ state, problems, 'checked-at': checkedAt, ...extra });

test('AC2: a cluster down — broken, missing, Docker down or not checked — names its machine and its fix; its template and memory problems get their own warnings, not this one', () => {
  const down = warn(project({ substrate: { 'ws-1': check('broken', [{ what: 'node', why: 'the cluster\'s node is not running', repair: true }]) } })).find(w => w.id === 'substrate:ws-1');
  assert.deepEqual([down.text, down.chip], ['Substrate ws-1 broken', true]);
  assert.match(down.todo, /^Control restarts the Substrate cluster on ws-1 \(substrate:up p ws-1\); if it stays broken: node: /);
  const docker = warn(project({ substrate: { mac: check('docker-down', [{ what: 'docker', why: 'not answering', repair: false }]) } })).find(w => w.id === 'substrate:mac');
  assert.equal(docker.text, 'Substrate mac Docker down');
  assert.equal(docker.todo, 'Fix the Substrate cluster on mac: docker: not answering');
  // A template and memory problem with a pod down: three warnings, the cluster's naming only the pod.
  const both = warn(project({ substrate: { mac: check('broken', [{ what: 'pods', why: 'ate-system/x is not ready', repair: true }, { what: 'templates', why: 'template t has no golden snapshot: too big', repair: false }, { what: 'docker memory', why: 'Docker has 2.0 GiB', repair: false }]) } }));
  assert.deepEqual(both.map(w => w.id).filter(id => /substrate/.test(id)), ['substrate:mac', 'substrate-template:mac', 'substrate-memory:mac']);
  assert.match(both[0].todo, /if it stays broken: pods: ate-system\/x is not ready$/);
  // Healthy, or a stale check: nothing.
  assert.deepEqual(ids(project({ substrate: { mac: check('healthy', []) } })).filter(id => /substrate/.test(id)), []);
  assert.deepEqual(ids(project({ substrate: { mac: check('broken', [{ what: 'docker memory', why: 'x', repair: false }], { 'checked-at': iso(now.getTime() - SUBSTRATE_STALE_MS - 1) }) } })).filter(id => /substrate/.test(id)), []);
});

test('AC2: a template with no golden snapshot carries ate-api-server\'s reason and both fixes', () => {
  const [w] = warn(project({ substrate: { mac: check('broken', [{ what: 'templates', why: 'template sandbox-0123456789ab has no golden snapshot: no worker has room for the actor', repair: false }]) } })).filter(x => x.id.startsWith('substrate'));
  assert.equal(w.id, 'substrate-template:mac');
  assert.equal(w.text, 'Substrate mac template: no golden snapshot');
  assert.match(w.todo, /^No sandbox can be made from it: template sandbox-0123456789ab has no golden snapshot: no worker has room for the actor\. If ate-api-server says no worker has room for the actor, raise worker-memory-gib in p's dev-environments\.substrate\.clusters entry for mac and run \.\/agent\.sh substrate:up p mac; else fix the sandbox image and rebuild it: \.\/agent\.sh substrate:build-image p$/);
  // A template list that could not be read is the cluster's (a restart fixes it), not this warning.
  assert.deepEqual(ids(project({ substrate: { mac: check('broken', [{ what: 'templates', why: 'kubectl ate get actor-template failed', repair: true }]) } })).filter(id => id.startsWith('substrate')), ['substrate:mac']);
});

test('AC2: Docker\'s memory low — Docker Desktop\'s VM on the Mac, Docker or the machine itself on a workstation or cloud VM', () => {
  const [mac] = warn(project({ substrate: { mac: check('broken', [{ what: 'docker memory', why: 'Docker has 2.0 GiB, the cluster needs at least 4.0 GiB (Docker Desktop: Settings, Resources, Memory)', repair: false }]) } }));
  assert.deepEqual([mac.id, mac.text], ['substrate-memory:mac', 'Docker Desktop memory low']);
  assert.match(mac.todo, /^Give Docker Desktop more memory \(Settings, Resources, Memory, then Apply & restart\): docker memory: Docker has 2\.0 GiB/);
  const [remote] = warn(project({ substrate: { 'cvm-1': check('broken', [{ what: 'host memory', why: 'the machine has only 0.80 GiB available', repair: false }]) } }));
  assert.deepEqual([remote.id, remote.text], ['substrate-memory:cvm-1', 'cvm-1 Docker memory low']);
  assert.match(remote.todo, /^Free memory on cvm-1 \(fewer tickets on it: its max-memory-percent\), or give it more: host memory: the machine has only 0\.80 GiB available$/);
});

test('AC2: snapshot disk use high — below the disk warning level with snapshots there; full when one more would pass the hold; none above it or without snapshots', () => {
  const disk = (free, snaps) => ({ mac: check('healthy', [], { usage: { 'snapshot-bytes': snaps, disk: { 'total-bytes': 200 * GIB, 'free-bytes': free }, 'sandbox-use': { 'sb-1-a': { state: 'suspended', 'snapshot-bytes': snaps } } } }) });
  const levels = { level: 'ok', 'free-bytes': 300 * GIB, 'warn-bytes': 50e9, 'hold-bytes': 15e9 };
  const of = (free, snaps) => headerWarnings(stateOf(project({ substrate: disk(free, snaps) }), { disk: levels }), now.getTime()).filter(w => w.id.startsWith('substrate'));
  const [high] = of(40 * GIB, 4 * GIB);
  assert.deepEqual([high.id, high.text], ['substrate-snapshots:mac', 'Substrate mac snapshot disk high']);
  assert.match(high.todo, /^Its sandboxes' snapshots take 4\.0 GiB of Docker Desktop's disk, which has 40\.0 GiB free \(below the 50 GB warning level\): delete the sandboxes no ticket needs \(\.\/agent\.sh substrate:sandbox-delete p <KEY> <variation>\), or give Docker Desktop more disk \(Settings, Resources, Disk usage limit\)$/);
  const [full] = of(16 * GIB, 4 * GIB);
  assert.match(full.todo, /; no new seat for its sandboxes until it is above 15 GB with room for one more: /);
  assert.deepEqual(of(60 * GIB, 4 * GIB), []);
  assert.deepEqual(of(10 * GIB, 0), []);
});

test('AC2: a failed sandbox image build — only while its last build failed and no build of those inputs succeeded; a running or cut-short build is not one', () => {
  const image = run => ({ label: { hash: 'h1' }, run: { hash: 'h2', 'started-at': '2026-11-22T11:00:00Z', ...run }, log: '/d/p/sandbox-image-build-arm64.log' });
  assert.equal(imageBuildFailed(image({ 'ended-at': '2026-11-22T11:10:00Z', 'exit-code': 2 })), true);
  assert.equal(imageBuildFailed(image({ 'ended-at': null, 'exit-code': null })), false, 'building, or cut short');
  assert.equal(imageBuildFailed(image({ 'ended-at': '2026-11-22T11:10:00Z', 'exit-code': 0 })), false);
  assert.equal(imageBuildFailed({ label: { hash: 'h2' }, run: { hash: 'h2', 'ended-at': 'x', 'exit-code': 1 } }), false, 'built since');
  const [w] = warn(project({ sandboxImages: { arm64: image({ 'ended-at': '2026-11-22T11:10:00Z', 'exit-code': 2 }) } }));
  assert.deepEqual([w.id, w.text, w.chip], ['sandbox-image:arm64', 'Sandbox image arm64 build failed', true]);
  assert.equal(w.todo, "The last build of p's arm64 sandbox image exited 2 at 2026-11-22 11:10:00 UTC: read /d/p/sandbox-image-build-arm64.log, fix what it says, then build it again: ./agent.sh substrate:build-image p --arch arm64");
});

test('AC2: a failed sandbox setup — its ticket, machine, error and the commands to look and to try by hand', () => {
  const [w] = warn(project({ sandboxFailures: [{ key: 'SB-3', variation: 'B', sandbox: 'sb-3-b', machine: 'cvm-1', what: 'resumed', failures: 1, error: 'kubectl ate resume actor sb-3-b failed' }] }));
  assert.deepEqual([w.id, w.text], ['sandbox-setup:sb-3-b', 'Sandbox sb-3-b setup failed']);
  assert.equal(w.todo, "SB-3 B's sandbox on cvm-1 could not be resumed (1 in a row; control tries again, and sends the ticket to Blocked after 3): kubectl ate resume actor sb-3-b failed. Check ./agent.sh substrate:health p cvm-1 and control's log; ./agent.sh substrate:sandbox-up p SB-3 B cvm-1 tries it by hand");
});

test('AC2: every Substrate warning has its own stable id per machine, so two troubles on one machine notify separately and each once', () => {
  const p = project({
    substrate: { mac: check('broken', [{ what: 'rustfs', why: 'down', repair: true }, { what: 'templates', why: 'no golden snapshot', repair: false }, { what: 'docker memory', why: 'low', repair: false }], { usage: { 'snapshot-bytes': GIB, disk: { 'free-bytes': 20 * GIB } } }) },
    sandboxImages: { amd64: { label: null, run: { hash: 'h', 'ended-at': 'x', 'exit-code': 1 }, log: '/l' } },
    sandboxFailures: [{ key: 'SB-1', variation: 'A', sandbox: 'sb-1-a', machine: 'mac', what: 'made', failures: 1, error: 'e' }],
  });
  const live = liveWarnings(stateOf(p), now.getTime());
  const keys = live.p.map(w => w.key).filter(k => /substrate|sandbox/.test(k));
  assert.deepEqual(keys, ['substrate:mac', 'substrate-template:mac', 'substrate-memory:mac', 'substrate-snapshots:mac', 'sandbox-image:amd64', 'sandbox-setup:sb-1-a']);
  assert.ok(live.p.filter(w => keys.includes(w.key)).every(w => w.warning.chip && !w.warning.operator && w.warning.scope === 'project'));
});

// Control's side of the failed-setup warning: sandbox-failures.json.
function controlCtx(dir, fail) {
  let t = Date.parse('2026-11-22T12:00:00Z');
  return { memory: { warned: new Set(), backoff: new Map() }, paths: { projects: dir }, now: () => new Date(t), later: ms => { t += ms; }, log: () => {},
    cli: async args => { if (fail()) throw new Error('substrate:sandbox-up: no worker has room for the actor\nmore detail'); return `${JSON.stringify({ name: 'sb-1-a', created: true, template: 'sandbox-x', branches: [] })}\n`; } };
}
const drain = async ctx => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); for (const r of ctx.memory.sandboxes?.values() ?? []) if (r.job) await r.job; };

test('AC2: control records a sandbox that could not be made in sandbox-failures.json, which the dashboard loads; a bring-up that works removes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbfail-'));
  mkdirSync(join(dir, 'p'));
  let failing = true;
  const ctx = controlCtx(dir, () => failing);
  const engine = { steps: [{ id: 'build', sequence: 1, 'run-location': 'vm', action: { type: 'prompt', prompt: 'x' } }, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] };
  const v = { name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } };
  const t = { key: 'SB-1', variations: [v] };
  const p = { id: 'p', engine, tickets: [t], seats: [{ key: 'SB-1', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  const state = { projects: [p], assignments: [] };
  sandboxWaits(ctx, state, p, t, v, engine.steps[0], 'SB-1 A build', ticketKey('p', 'SB-1', 'A', 'build'));
  await drain(ctx);
  superviseSandboxes(ctx, state);
  const file = join(dir, 'p', SANDBOX_FAILURES_FILE);
  assert.ok(existsSync(file));
  const [f] = loadSandboxFailures(join(dir, 'p'));
  assert.deepEqual({ ...f, 'next-try-at': typeof f['next-try-at'] }, { key: 'SB-1', variation: 'A', sandbox: 'sb-1-a', machine: 'mac', what: 'made', failures: 1, error: 'substrate:sandbox-up: no worker has room for the actor', since: '2026-11-22T12:00:00.000Z', 'next-try-at': 'string' });
  // The dashboard reads it as a warning.
  writeProject(dir);
  const loaded = loadProjects(dir).find(x => x.id === 'p');
  assert.equal(loaded.sandboxFailures[0].sandbox, 'sb-1-a');
  // Off a substrate target (its seat elsewhere): no longer listed.
  p.seats = [{ key: 'SB-1', variation: 'A', kind: 'vm', target: 'local-vm' }];
  assert.deepEqual(sandboxFailures(ctx, p), []);
  p.seats = [{ key: 'SB-1', variation: 'A', kind: 'vm', target: 'local-substrate' }];
  // Brought up: the file goes.
  failing = false;
  ctx.later(60 * 60e3);
  for (const r of ctx.memory.sandboxes.values()) r.until = 0;
  ctx.memory.backoff.clear();
  sandboxWaits(ctx, state, p, t, v, engine.steps[0], 'SB-1 A build', ticketKey('p', 'SB-1', 'A', 'build'));
  await drain(ctx);
  superviseSandboxes(ctx, state);
  assert.equal(existsSync(file), false);
});

const writeProject = dir => writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'dev-environments': { mode: 'vm', substrate: { clusters: [{ machine: 'mac' }] } } }));

test('AC1, AC2: the dashboard loads the clusters declared, the sandbox images\' labels and last builds, and control\'s failed setups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbload-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'dev-environments': { mode: 'vm+workstation', 'cloud-vms': [{ id: 'cvm-1', 'gcp-project': 'g', zone: 'z' }], substrate: { clusters: [{ machine: 'mac' }, { machine: 'cvm-1' }, { machine: 'gke', 'gcp-project': 'g', location: 'l', cluster: 'c' }] } } }));
  writeFileSync(join(dir, 'p', 'sandbox-image-amd64-build.json'), JSON.stringify({ hash: 'h', 'ended-at': 'x', 'exit-code': 1 }));
  writeFileSync(join(dir, 'p', SANDBOX_FAILURES_FILE), JSON.stringify({ failures: [{ key: 'K-1', variation: 'A', sandbox: 'k-1-a', machine: 'mac' }] }));
  const p = loadProjects(dir)[0];
  assert.deepEqual(p.substrateMachines, ['mac', 'cvm-1']);   // GKE: refused until approved, no cluster to show
  assert.deepEqual(Object.keys(p.sandboxImages), ['amd64']);
  assert.equal(p.sandboxImages.amd64.log, join(dir, 'p', 'sandbox-image-build-amd64.log'));
  assert.deepEqual(loadSandboxImages(join(dir, 'p')).amd64.label, null);
  assert.equal(p.sandboxFailures[0].sandbox, 'k-1-a');
});

test('AC4: CLAUDE.md and README cover Substrate — setup, health, every new warning with its fix, credentials, adding a cluster, the template\'s capabilities, Docker steps never in sandboxes', () => {
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const table = claude.replaceAll('`', '');
  for (const text of ['Substrate <machine> broken', 'Substrate <machine> template: no golden snapshot', 'Docker Desktop memory low', '<machine> Docker memory low', 'Substrate <machine> snapshot disk high', 'Sandbox image <arch> build failed', 'Sandbox <sandbox> setup failed']) {
    assert.ok(table.includes(`**${text}**`), `CLAUDE.md's warnings table: ${text}`);
  }
  for (const text of ['substrate:up', 'substrate:health', 'substrate:credentials', 'substrate:build-image', 'substrate.clusters', 'worker-memory-gib', 'local-substrate', 'Docker steps', 'hibernat', '📦 <KEY>']) {
    assert.ok(claude.includes(text), `CLAUDE.md: ${text}`);
    assert.ok(readme.includes(text), `README.md: ${text}`);
  }
  assert.match(claude, /### Adding a Substrate cluster to a project/);
  assert.match(claude, /capabilities/i);
  assert.match(readme, /capabilities/i);
});
