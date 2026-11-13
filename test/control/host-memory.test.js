// The memory hold (ASS-398, reworked by ASS-404): before control starts or
// creates a VM it reads the Mac's memory (ctx.hostMemory — replaced here, never
// the real Mac's: macOS's free percentage and pressure level, and each Lima
// VM's physical footprint, compressed pages included: ASS-419) and holds the VM while macOS reports warn or critical
// pressure, or free memory below what a VM of the project needs — the largest
// use of its running VMs plus memory-free-margin-gib, between
// memory-need-floor-gib and its configured memory (its golden image
// template.yaml), the floor with none running; or harness.json's
// memory-free-hold-gib. Held, the VM is not started, its variation waits as
// for a slot holding no seat, no failure counted, and the project's hold is
// recorded (memory-hold.json, with the figures and the variations held) until
// it lifts by itself. Driven as tick-vm-lifecycle.test.js: the real grouped
// engines; agent.sh a recorder; limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { superviseVms, awaitsVm, VM_WAIT } from '../../src/control/vm-lifecycle.js';
import { runSteps } from '../../src/control/steps.js';
import { createContext } from '../../src/control/tick.js';
import { planFor } from '../../src/control/plan.js';
import { mayMove } from '../../src/control/moves.js';
import { parseSysctl, parseVzProcesses, parseFootprint, matchInstances, parseMemory, vmMemoryBytes, memoryNeed, vmNeed, memoryVerdict, MEMORY_READ_EVERY } from '../../src/control/host-memory.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const GIB = 2 ** 30;
const ENGINE = 'example-development-grouped';
const at = (state, sub) => ({ state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) });
const BUILDING = at('build', ['grouped-build', 'generate-solution']);
const PLANNING = at('plan', ['grouped-plan', 'enrich-ac']);
// A reading of a 100 GiB Mac, so its free percentage is its free GiB.
const mac = ({ free = 64, pressure = 'normal', vms = {} } = {}) => ({ freePercent: free, pressure, totalBytes: 100 * GIB, vms: new Map(Object.entries(vms)) });

// p on example-development-grouped with a golden image whose template.yaml
// gives its VMs `memory`; ABC-3's variations as `variations` gives them
// ({ name: [harness-status, VM status or null, extra] }), each VM abc-3-<name>;
// agent.sh calls recorded; the Mac's memory set(reading options: mac's).
function holding(variations, { memory = '4GiB', harness = {} } = {}) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  writeFileSync(file('harness.json'), JSON.stringify({ ...JSON.parse(readFileSync(file('harness.json'), 'utf8')), 'max-tickets-in-progress': null, ...harness }));
  for (const name of engineNames()) if (!existsSync(file('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), file('engines', name), { recursive: true });
  const project = JSON.parse(readFileSync(file('projects', 'p', 'project.json'), 'utf8'));
  writeFileSync(file('projects', 'p', 'project.json'), JSON.stringify({ ...project, 'execution-state-engine': ENGINE, 'golden-image': { folder: 'golden-p' } }));
  mkdirSync(file('golden-p'), { recursive: true });
  writeFileSync(file('golden-p', 'template.yaml'), `vmType: vz\ncpus: 4\n${memory ? `memory: ${memory}\n` : ''}`);
  const v = fakeVm(f.env);
  const sprint = file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', 'ticket-system-status': 'In Progress', variations: Object.entries(variations).map(([name, [status, vm, extra]]) => {
    if (vm) v.instance(`abc-3-${name.toLowerCase()}`, vm);
    return { name, 'harness-status': status, 'state-changes': [], vm: { name: `abc-3-${name.toLowerCase()}`, ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }, ...extra };
  }) }] }));
  const home = file('harness-home');
  mkdirSync(home, { recursive: true });
  f.ctx.env = { ...v.env, HARNESS_HOME: home };
  let now = Date.parse('2026-11-12T10:00:00Z'), reading = mac(), reads = 0;
  f.ctx.now = () => new Date(now);
  f.ctx.hostMemory = async () => { reads++; return reading; };
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); return ''; };
  return {
    f, v, calls, file,
    set: options => { reading = mac(options); },
    reads: () => reads,
    later: ms => { now += ms; },
    record: () => (existsSync(file('projects', 'p', 'memory-hold.json')) ? JSON.parse(readFileSync(file('projects', 'p', 'memory-hold.json'), 'utf8')) : null),
    holds: () => f.lines.filter(l => /^hold /.test(l)),
    seats: () => { const plan = planFor(f.ctx.load(), f.ctx.load().projects[0]); return { reserved: plan.reserved.map(s => s.variation), waiting: plan.waiting.map(s => s.variation), memoryHeld: plan.memoryHeld.map(s => s.variation) }; },
    pass: async () => {
      const before = calls.length;
      await superviseVms(f.ctx, f.ctx.load());
      await Promise.all([...f.ctx.memory.vms.values()].map(r => r.job));
      return calls.slice(before).sort();
    },
  };
}

test('ASS-404 AC2/AC5: the reading — sysctl\'s free percentage, pressure level and memory size; ps\'s Virtualization framework VM processes; lsof matching each to its Lima instance', () => {
  assert.deepEqual(parseSysctl('kern.memorystatus_level: 36\nkern.memorystatus_vm_pressure_level: 1\nhw.memsize: 51539607552\n'), { freePercent: 36, pressure: 'normal', totalBytes: 48 * GIB });
  assert.equal(parseSysctl('kern.memorystatus_level: 9\nkern.memorystatus_vm_pressure_level: 2\nhw.memsize: 1\n').pressure, 'warn');
  assert.equal(parseSysctl('kern.memorystatus_level: 3\nkern.memorystatus_vm_pressure_level: 4\nhw.memsize: 1\n').pressure, 'critical');
  assert.equal(parseSysctl('kern.memorystatus_level: 3\nhw.memsize: 1\n').pressure, 'unknown');
  assert.throws(() => parseSysctl('nothing'), /sysctl: unexpected output/);
  const vz = '/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine';
  const procs = parseVzProcesses(`  101  3355443 ${vz}\n  102     2048 /opt/homebrew/bin/limactl\n  103  3040870 ${vz}\n  104   100000 ${vz}\n`);
  assert.deepEqual([...procs], [[101, 3355443 * 1024], [103, 3040870 * 1024], [104, 100000 * 1024]]);
  const lsof = ['p101', 'f3', 'n/dev/null', 'n/lima/_config/user', 'n/lima/abc-3-a/disk', 'n/lima/abc-3-a/cidata.iso', 'p102', 'n/lima/abc-3-c/disk', 'p103', 'n/lima/abc-3-b/serialv.log', 'p104', 'n/elsewhere/other/disk'].join('\n');
  assert.deepEqual([...matchInstances(lsof, '/lima/', procs)], [['abc-3-a', 3355443 * 1024], ['abc-3-b', 3040870 * 1024]], 'an instance by the files its VM process holds; a process not a VM, or a VM not Lima\'s, matches none');
});

test('ASS-404 AC1: the need is the largest use of the project\'s running VMs plus the margin, between the floor and its configured memory; with none running the floor, never the configured size; memory-free-hold-gib still sets it', () => {
  const h = holding({ A: [BUILDING, 'Running'], B: [BUILDING, 'Running'] }, { memory: '"10GiB"' });
  const project = h.f.ctx.load().projects[0];
  assert.equal(vmMemoryBytes(h.f.ctx, project), 10 * GIB);
  const reading = vms => ({ ...mac(), vms: vms && new Map(Object.entries(vms)) });
  // From the running VMs: the largest, 3.2 GiB, plus 2; another project's VM not counted.
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'abc-3-a': 3.2 * GIB, 'abc-3-b': 2.9 * GIB, 'xyz-1-a': 9 * GIB })),
    { bytes: 5.2 * GIB, why: 'the largest of its 2 running VMs, 3.2 GiB footprint (compressed pages included), plus a 2 GiB margin', measure: 'footprint' });
  // The floor: none running, or not measured — never the configured 10 GiB.
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'xyz-1-a': 9 * GIB })), { bytes: 4 * GIB, why: 'none of its VMs running to measure: the 4.0 GiB floor', measure: 'floor' });
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, { ...reading(null), vmsError: 'lsof: gone' }), { bytes: 4 * GIB, why: 'its VMs not measured (lsof: gone): the 4.0 GiB floor', measure: 'floor' });
  assert.equal(memoryNeed(h.f.ctx, { harness: { 'memory-need-floor-gib': 6 } }, project, reading({})).bytes, 6 * GIB, 'the floor configurable');
  // Raised to the floor, capped at the ceiling.
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'abc-3-a': GIB })), { bytes: 4 * GIB, why: 'the largest of its 1 running VM, 1.0 GiB footprint (compressed pages included), plus a 2 GiB margin, raised to the 4.0 GiB floor', measure: 'footprint' });
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'abc-3-a': 9.5 * GIB })), { bytes: 10 * GIB, why: 'the largest of its 1 running VM, 9.5 GiB footprint (compressed pages included), plus a 2 GiB margin, capped at its configured 10.0 GiB', measure: 'footprint' });
  assert.equal(memoryNeed(h.f.ctx, { harness: { 'memory-free-margin-gib': 1 } }, project, reading({ 'abc-3-a': 3 * GIB })).bytes, 4 * GIB);
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: { 'memory-free-hold-gib': 3 } }, project, reading({})), { bytes: 3 * GIB, why: "harness.json's memory-free-hold-gib", measure: 'configured' });
  // A configured size below the floor caps it.
  const small = holding({}, { memory: '2GiB' });
  assert.equal(memoryNeed(small.f.ctx, { harness: {} }, small.f.ctx.load().projects[0], reading({})).bytes, 2 * GIB);
  assert.equal(parseMemory('4096MiB'), 4 * GIB);
  assert.equal(vmMemoryBytes(holding({}, { memory: null }).f.ctx, project), 4 * GIB);
});

// ASS-419: a VM's cost is its physical footprint (top's MEM, compressed pages
// included), read with `footprint`; ps rss only when that cannot be read.
test('ASS-419 AC1: footprint\'s phys_footprint per VM process, only the pids asked for', () => {
  const text = [
    '======================================================================',
    'com.apple.Virtualization.VirtualMachine [101]: 64-bit    Footprint: 10758553056 B (16384 bytes per page)',
    '======================================================================',
    'Auxiliary data:',
    '    phys_footprint: 10759519712 B',
    '    phys_footprint_peak: 10764205536 B',
    'other [555]: 64-bit    Footprint: 304809472 B (16384 bytes per page)',
    '    phys_footprint: 304842240 B',
    'com.apple.Virtualization.VirtualMachine [103]: 64-bit    Footprint: 3 B (16384 bytes per page)',
    '    phys_footprint: 3221225472 B',
  ].join('\n');
  assert.deepEqual([...parseFootprint(text, [101, 103])], [[101, 10759519712], [103, 3 * GIB]], 'the peak not taken; a process not asked for left out');
  assert.deepEqual([...parseFootprint('', [101])], []);
});

test('ASS-419 AC2/AC3: a footprint far above resident memory raises the need — capped at the configured size or the footprint when larger; never below the configured size once a VM was seen at it; the resident size said when that is all there is; vmNeed reads the Mac (cached) itself', async () => {
  const h = holding({ A: [BUILDING, 'Running'], B: [BUILDING, 'Stopped'] }, { memory: '16GiB' });
  const project = h.f.ctx.load().projects[0];
  const reading = (vms, measure) => ({ ...mac(), vms: new Map(Object.entries(vms)), ...(measure ? { measure } : {}) });
  // ASS-404 read 1 GiB resident for a VM top showed at 10 GiB: the footprint is the cost now.
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'abc-3-a': GIB }, 'resident')),
    { bytes: 4 * GIB, why: 'the largest of its 1 running VM, 1.0 GiB resident (ps rss, its footprint not read), plus a 2 GiB margin, raised to the 4.0 GiB floor', measure: 'resident' });
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'abc-3-a': 10 * GIB }, 'footprint')),
    { bytes: 12 * GIB, why: 'the largest of its 1 running VM, 10.0 GiB footprint (compressed pages included), plus a 2 GiB margin', measure: 'footprint' });
  // A footprint above the configured size (the VM's own overhead): the footprint is the cap.
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'abc-3-a': 16.5 * GIB })),
    { bytes: 16.5 * GIB, why: 'the largest of its 1 running VM, 16.5 GiB footprint (compressed pages included), plus a 2 GiB margin, capped at that footprint, above its configured 16.0 GiB', measure: 'footprint' });
  // Seen at its configured size, the need never drops below it: a smaller VM, or none running.
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({ 'abc-3-a': 2 * GIB })),
    { bytes: 16 * GIB, why: 'the largest of its 1 running VM, 2.0 GiB footprint (compressed pages included), plus a 2 GiB margin, raised to its configured 16.0 GiB, a VM of it once seen using that much', measure: 'footprint' });
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project, reading({})),
    { bytes: 16 * GIB, why: 'none of its VMs running to measure: its configured 16.0 GiB, a VM of it once seen using that much', measure: 'floor' });
  // vmNeed: the need for one new VM, the Mac read through ctx.hostMemory, at most every MEMORY_READ_EVERY.
  const fresh = holding({ A: [BUILDING, 'Running'], B: [BUILDING, 'Stopped'] }, { memory: '16GiB' });
  fresh.set({ free: 64, vms: { 'abc-3-a': 9 * GIB } });
  const state = fresh.f.ctx.load();
  assert.equal((await vmNeed(fresh.f.ctx, state, state.projects[0])).bytes, 11 * GIB);
  fresh.set({ free: 64, vms: { 'abc-3-a': 12 * GIB } });
  assert.equal((await vmNeed(fresh.f.ctx, state, state.projects[0])).bytes, 11 * GIB, 'the cached reading');
  assert.equal(fresh.reads(), 1);
  fresh.later(MEMORY_READ_EVERY);
  assert.equal((await vmNeed(fresh.f.ctx, state, state.projects[0])).bytes, 14 * GIB);
  fresh.f.ctx.hostMemory = null;
  assert.deepEqual(await vmNeed(fresh.f.ctx, state, state.projects[0]), { bytes: 4 * GIB, why: 'its VMs not measured: the 4.0 GiB floor', measure: 'floor' });
});

test('ASS-419 AC2/AC3: the hold uses the footprint — 8 GiB free holds a VM whose sibling is 1 GiB resident but 10 GiB footprint', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'], B: [BUILDING, 'Running'] }, { memory: '16GiB' });
  h.set({ free: 8, vms: { 'abc-3-b': 10 * GIB } });
  assert.deepEqual(await h.pass(), []);
  assert.ok(h.holds()[0].includes('below the 12.0 GiB a VM needs'), h.holds().join('\n'));
  assert.equal(h.record()['need-measure'], 'footprint');
  assert.equal(h.record()['need-bytes'], 12 * GIB);
});

test('ASS-404 AC2: held under warn or critical pressure, or free memory below the need; under normal pressure with room, not', () => {
  const need = { bytes: 5 * GIB, why: '' };
  assert.equal(memoryVerdict(mac({ free: 16 }), need).short, false);
  assert.equal(memoryVerdict(mac({ free: 5 }), need).short, false, 'exactly the need is room');
  assert.deepEqual(memoryVerdict(mac({ free: 40, pressure: 'warn' }), need), { short: true, why: 'memory pressure warn (macOS: pressure warn, 40% free, 40.0 of 100.0 GiB)' });
  assert.equal(memoryVerdict(mac({ free: 40, pressure: 'critical' }), need).short, true);
  assert.deepEqual(memoryVerdict(mac({ free: 4 }), need), { short: true, why: '4.0 GiB free, below the 5.0 GiB a VM needs (macOS: pressure normal, 4% free, 4.0 of 100.0 GiB)' });
});

test('ASS-404 AC5: control reads the Mac\'s memory, off with HOST_MEMORY_DISABLED=1 (the test fixtures\' env)', () => {
  assert.equal(createContext({ root: '/nowhere', env: { HOST_MEMORY_DISABLED: '1' } }).hostMemory, null);
  assert.equal(typeof createContext({ root: '/nowhere', env: {} }).hostMemory, 'function');
});

test('ASS-404 AC2: under normal pressure with room nothing is held — 8 GiB free starts a VM configured with 10 GiB whose siblings use 3', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'], B: [BUILDING, 'Running'] }, { memory: '10GiB' });
  h.set({ free: 8, vms: { 'abc-3-b': 3 * GIB } });
  assert.deepEqual(await h.pass(), ['vm:start p ABC-3 A']);
  assert.deepEqual(h.holds(), []);
  assert.equal(h.record(), null);
});

test('ASS-398 AC1/AC3, ASS-404 AC2/AC4: under warn pressure no VM is started or recreated — stops go on, no failure counted — the hold logged once with macOS\'s figures and the need, and recorded; its variation waits as for a slot past VM_WAIT; once pressure is normal with room the hold lifts by itself, and the VMs start', async () => {
  const h = holding({
    A: [BUILDING, 'Stopped'],
    B: [BUILDING, null],                                                      // deleted to make room
    E: [at('release', ['grouped-release-example', 'team-code-review']), 'Running'],
  });
  h.set({ free: 30, pressure: 'warn', vms: { 'abc-3-e': 3 * GIB } });
  assert.deepEqual(await h.pass(), ['vm:stop p abc-3-e']);
  assert.deepEqual(h.holds(), ['hold Out of memory: memory pressure warn (macOS: pressure warn, 30% free, 30.0 of 100.0 GiB); a p VM needs 4.0 GiB (the largest of its 1 running VM, 3.0 GiB footprint (compressed pages included), plus a 2 GiB margin, capped at its configured 4.0 GiB): abc-3-a (ABC-3 A) not started — no p VM starts or is created until macOS reports normal pressure and that much free; its variation waits as for a slot, holding no seat, no failure counted']);
  assert.ok(h.f.lines.includes('vm p abc-3-a: not started: out of memory; waits as for a slot'), h.f.lines.join('\n'));
  assert.ok(h.f.lines.includes('vm p abc-3-b: not recreated: out of memory; waits as for a slot'), h.f.lines.join('\n'));
  assert.equal(h.f.ctx.memory.vms.get('p').held.size, 0, 'no failure counted, no backoff');
  assert.deepEqual(h.record(), {
    since: '2026-11-12T10:00:00Z', pressure: 'warn', 'free-percent': 30, 'free-bytes': 30 * GIB, 'total-bytes': 100 * GIB,
    'need-bytes': 4 * GIB, 'need-why': 'the largest of its 1 running VM, 3.0 GiB footprint (compressed pages included), plus a 2 GiB margin, capped at its configured 4.0 GiB', 'need-measure': 'footprint', why: 'memory pressure warn (macOS: pressure warn, 30% free, 30.0 of 100.0 GiB)',
    vm: 'abc-3-a', held: [{ vm: 'abc-3-a', key: 'ABC-3', variation: 'A', state: 'build' }, { vm: 'abc-3-b', key: 'ABC-3', variation: 'B', state: 'build' }],
  });
  // Its steps wait as for a slot: not judged, past VM_WAIT too.
  const state = h.f.ctx.load(), project = state.projects[0], a = project.tickets[0].variations.find(v => v.name === 'A');
  h.later(VM_WAIT + MEMORY_READ_EVERY);
  assert.deepEqual(await h.pass(), ['vm:stop p abc-3-e']);
  assert.equal(awaitsVm(h.f.ctx, state, project, a, 'ABC-3 A build'), true);
  assert.ok(!h.f.lines.some(l => /is not running after/.test(l)), h.f.lines.join('\n'));
  assert.equal(h.holds().length, 1, 'logged once');
  assert.equal(h.f.lines.filter(l => /abc-3-a: not started: out of memory/.test(l)).length, 1, 'said once per VM');

  h.set({ free: 16 });
  h.later(MEMORY_READ_EVERY);
  assert.deepEqual(await h.pass(), ['vm:create p ABC-3 B', 'vm:start p ABC-3 A', 'vm:stop p abc-3-e']);
  assert.ok(h.holds().includes('hold memory back: pressure normal, 16.0 GiB free (16% of 100.0 GiB), at or above the 4.0 GiB a VM needs for p — the out-of-memory hold lifted at 2026-11-12T10:02:20Z (held since 2026-11-12T10:00:00Z); VMs start again'), h.holds().join('\n'));
  assert.equal(h.record(), null, 'its record removed');
  assert.equal(awaitsVm(h.f.ctx, h.f.ctx.load(), project, a, 'ABC-3 A build'), false);
});

test('ASS-404 AC2: free memory below the need holds under normal pressure — critical pressure too', async () => {
  for (const [reading, why] of [[{ free: 3 }, /^hold Out of memory: 3\.0 GiB free, below the 4\.0 GiB a VM needs \(macOS: pressure normal, 3% free/], [{ free: 50, pressure: 'critical' }, /^hold Out of memory: memory pressure critical /]]) {
    const h = holding({ A: [BUILDING, 'Stopped'] }, { memory: '10GiB' });
    h.set(reading);
    assert.deepEqual(await h.pass(), []);
    assert.match(h.holds()[0], why);
    assert.equal(h.record().vm, 'abc-3-a');
  }
});

test('ASS-404 AC3: a variation whose VM is held for memory holds no seat while it waits — the next in rank order gets it — and takes its seat again once its VM can start; no step re-run, no visit spent', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'], B: [BUILDING, 'Stopped'] }, { harness: { 'max-tickets-in-progress': 1 } });
  assert.deepEqual(h.seats(), { reserved: ['A'], waiting: ['B'], memoryHeld: [] });
  h.set({ free: 2 });
  assert.deepEqual(await h.pass(), []);
  assert.deepEqual(h.seats(), { reserved: ['B'], waiting: [], memoryHeld: ['A'] }, 'A\'s seat freed, B in it');
  h.later(MEMORY_READ_EVERY);
  assert.deepEqual(await h.pass(), [], 'B\'s VM is held too');
  assert.deepEqual(h.seats(), { reserved: [], waiting: [], memoryHeld: ['A', 'B'] });
  assert.deepEqual(h.record().held.map(x => x.variation), ['A', 'B']);
  h.set({ free: 16 });
  h.later(MEMORY_READ_EVERY);
  assert.deepEqual(await h.pass(), ['vm:start p ABC-3 A'], 'A, first in rank, takes its seat again and starts; B waits for a slot');
  assert.deepEqual(h.seats(), { reserved: ['A'], waiting: ['B'], memoryHeld: [] });
  assert.ok(!h.calls.some(c => /^ticket:(move|change-state|change-sub-state)/.test(c)), h.calls.join('\n'));
  const variations = h.f.ctx.load().projects[0].tickets[0].variations;
  assert.deepEqual(variations.map(v => [v['harness-status'].state, v['state-changes'].length]), [['build', 0], ['build', 0]]);
});

test('ASS-404 AC3: while the hold is on, a seat a held variation freed goes to a variation whose VM is up, not to one whose VM would be held too; a held variation that moves off its step is dropped from the hold', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'], C: [PLANNING, 'Running'], D: [PLANNING, 'Stopped'] }, { harness: { 'max-tickets-in-progress': 1 } });
  h.set({ free: 2 });
  await h.pass();
  assert.deepEqual(h.record().held.map(x => x.variation), ['A', 'D']);
  const state = h.f.ctx.load(), project = state.projects[0], [, c, d] = project.tickets[0].variations;
  h.f.ctx.memory.vmsUp = new Set(['abc-3-c']);
  assert.equal(mayMove(h.f.ctx, 'steps', state, project, d, 'ABC-3 D plan', 'build'), false);
  assert.ok(h.f.lines.includes('steps ABC-3 D plan: waits for an in-progress slot to move to build (the one free is a seat a VM held for memory left: its VM would be held too)'), h.f.lines.join('\n'));
  assert.equal(mayMove(h.f.ctx, 'steps', state, project, c, 'ABC-3 C plan', 'build'), true, 'C\'s VM is up: it takes the seat');
  // D moved on (by hand, to committed): dropped from the hold, its record rewritten.
  const sprint = h.file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), json = JSON.parse(readFileSync(sprint, 'utf8'));
  json.features[0].variations[2]['harness-status'] = at('committed');
  writeFileSync(sprint, JSON.stringify(json));
  h.later(MEMORY_READ_EVERY);
  await h.pass();
  assert.deepEqual(h.record().held.map(x => x.variation), ['A']);
});

test('ASS-398 AC3: the hold lifts on its own once there is room, though no VM waits to start any more; the memory is read at most every 10 seconds; a record an earlier control left is removed', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'] });
  h.set({ free: 1 });
  await h.pass();
  assert.ok(h.record());
  const reads = h.reads();
  await h.pass();
  assert.equal(h.reads(), reads, 'read again only after MEMORY_READ_EVERY');
  writeFileSync(h.file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [], features: [] }));
  h.set({ free: 8 });
  h.later(MEMORY_READ_EVERY);
  await h.pass();
  assert.ok(h.holds().some(l => /^hold memory back: pressure normal, 8\.0 GiB free/.test(l)), h.holds().join('\n'));
  assert.equal(h.record(), null);
  writeFileSync(h.file('projects', 'p', 'memory-hold.json'), '{"since":"2026-11-01T00:00:00Z"}');   // a previous control's
  await h.pass();
  assert.equal(h.record(), null);
});

test('ASS-398 AC1: harness.json\'s memory-free-hold-gib sets the need; with room nothing is held and nothing logged', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'] }, { harness: { 'memory-free-hold-gib': 1 } });
  h.set({ free: 2 });                                                        // below the 4 GiB floor, above the 1 GiB set
  assert.deepEqual(await h.pass(), ['vm:start p ABC-3 A']);
  assert.deepEqual(h.holds(), []);
  assert.equal(h.record(), null);
});

test('ASS-398 AC1, ASS-404 AC3: a script step that creates a VM (vm:create) waits, not run, while memory is short — said once, no failure — the hold on, its variation held with it (no seat); it runs once memory frees', async () => {
  const f = controlFixture();
  const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.find(s => s.id === 'build').action.command = 'echo vm:create {project} {ticket} {variation}';
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': hs('build'), 'state-changes': [] }] });
  });
  let now = Date.parse('2026-11-12T10:00:00Z'), reading = mac({ free: 1 });
  f.ctx.now = () => new Date(now);
  f.ctx.hostMemory = async () => reading;
  const record = join(f.dir, 'projects', 'p', 'memory-hold.json');
  for (let i = 0; i < 3; i++) { await runSteps(f.ctx, f.ctx.load()); now += MEMORY_READ_EVERY; }
  assert.equal(f.lines.filter(l => l === 'steps ABC-4 A build: waits: out of memory').length, 1, f.lines.join('\n'));
  assert.ok(!f.lines.some(l => /^script .*vm:create/.test(l)), f.lines.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).held, [{ key: 'ABC-4', variation: 'A', state: 'build' }]);
  assert.ok(f.lines.some(l => /^hold Out of memory: 1\.0 GiB free, below the 4\.0 GiB a VM needs .*: its VM \(ABC-4 A\) not started/.test(l)), f.lines.join('\n'));
  const state = f.ctx.load();
  assert.deepEqual(planFor(state, state.projects[0]).memoryHeld, [{ key: 'ABC-4', variation: 'A' }]);
  reading = mac({ free: 8 });
  await runSteps(f.ctx, f.ctx.load());
  assert.ok(f.lines.some(l => /^hold memory back: pressure normal, 8\.0 GiB free/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /^script .*vm:create p ABC-4 A$/.test(l)), f.lines.join('\n'));
  assert.ok(!existsSync(record));
});
