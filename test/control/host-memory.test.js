// The memory hold (ASS-398): before control starts or creates a VM it reads
// the Mac's available memory (vm_stat, ctx.availableMemory — replaced here,
// never the real Mac's) against harness.json's memory-free-hold-gib, or the
// VM's configured memory (its golden image template.yaml) plus
// memory-free-margin-gib; below it the VM is not started, its variation waits
// as for a slot with no failure counted, and the project's hold is recorded
// for the dashboard (memory-hold.json) until it lifts by itself. Driven as
// tick-vm-lifecycle.test.js: the real grouped engines; agent.sh a recorder;
// limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { superviseVms, awaitsVm, VM_WAIT } from '../../src/control/vm-lifecycle.js';
import { runSteps } from '../../src/control/steps.js';
import { createContext } from '../../src/control/tick.js';
import { parseVmStat, parseMemory, vmMemoryBytes, memoryNeed, MEMORY_READ_EVERY } from '../../src/control/host-memory.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const GIB = 2 ** 30;
const ENGINE = 'example-development-grouped';
const at = (state, sub) => ({ state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) });
const BUILDING = at('build', ['grouped-build', 'generate-solution']);

// p on example-development-grouped with a golden image whose template.yaml
// gives its VMs `memory`; ABC-3's variations as `variations` gives them
// ({ name: [harness-status, VM status or null, extra] }), each VM abc-3-<name>;
// agent.sh calls recorded; the Mac's available memory free(bytes).
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
  let now = Date.parse('2026-11-12T10:00:00Z'), bytes = 64 * GIB, reads = 0;
  f.ctx.now = () => new Date(now);
  f.ctx.availableMemory = async () => { reads++; return bytes; };
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); return ''; };
  return {
    f, v, calls, file,
    free: b => { bytes = b; },
    reads: () => reads,
    later: ms => { now += ms; },
    record: () => (existsSync(file('projects', 'p', 'memory-hold.json')) ? JSON.parse(readFileSync(file('projects', 'p', 'memory-hold.json'), 'utf8')) : null),
    holds: () => f.lines.filter(l => /^hold /.test(l)),
    pass: async () => {
      const before = calls.length;
      await superviseVms(f.ctx, f.ctx.load());
      await Promise.all([...f.ctx.memory.vms.values()].map(r => r.job));
      return calls.slice(before).sort();
    },
  };
}

test('ASS-398 AC1: vm_stat\'s free, inactive and speculative pages times its page size are the available memory', () => {
  const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3000.
Pages active:                            900000.
Pages inactive:                            5000.
Pages speculative:                         2000.
Pages throttled:                              0.
Pages wired down:                        200000.
Pages purgeable:                            100.
`;
  assert.equal(parseVmStat(out), (3000 + 5000 + 2000) * 16384);
  assert.throws(() => parseVmStat('nothing here'), /vm_stat: unexpected output/);
});

test('ASS-398 AC1: a Lima memory size is read in binary units; the VM\'s is its golden image template.yaml\'s, Lima\'s 4 GiB without; the need is that plus the margin, or harness.json\'s memory-free-hold-gib', () => {
  assert.equal(parseMemory('4GiB'), 4 * GIB);
  assert.equal(parseMemory('10GiB'), 10 * GIB);
  assert.equal(parseMemory('4096MiB'), 4 * GIB);
  assert.equal(parseMemory('8G'), 8 * GIB);
  assert.equal(parseMemory('lots'), null);
  const h = holding({}, { memory: '"10GiB"' });
  const project = h.f.ctx.load().projects[0];
  assert.equal(vmMemoryBytes(h.f.ctx, project), 10 * GIB);
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: {} }, project), { bytes: 12 * GIB, why: 'its configured 10.0 GiB plus a 2 GiB margin' });
  assert.equal(memoryNeed(h.f.ctx, { harness: { 'memory-free-margin-gib': 1 } }, project).bytes, 11 * GIB);
  assert.deepEqual(memoryNeed(h.f.ctx, { harness: { 'memory-free-hold-gib': 3 } }, project), { bytes: 3 * GIB, why: "harness.json's memory-free-hold-gib" });
  assert.equal(vmMemoryBytes(holding({}, { memory: null }).f.ctx, project), 4 * GIB);
  assert.equal(vmMemoryBytes(h.f.ctx, { json: {} }), 4 * GIB);
});

test('ASS-398 AC1: control reads the Mac\'s memory with vm_stat, off with HOST_MEMORY_DISABLED=1 (the test fixtures\' env)', () => {
  assert.equal(createContext({ root: '/nowhere', env: { HOST_MEMORY_DISABLED: '1' } }).availableMemory, null);
  assert.equal(typeof createContext({ root: '/nowhere', env: {} }).availableMemory, 'function');
});

test('ASS-398 AC1/AC3: short of memory no VM is started or recreated — stops go on, no failure counted — the hold logged once and recorded; its variation waits as for a slot past VM_WAIT; once memory frees the hold lifts by itself, logged with why and when, and the VMs start', async () => {
  const h = holding({
    A: [BUILDING, 'Stopped'],
    B: [BUILDING, null],                                                      // deleted to make room
    E: [at('release', ['grouped-release-example', 'team-code-review']), 'Running'],
  });
  h.free(60 * 2 ** 20);                                                      // 60 MiB: below 4 GiB + 2 GiB
  assert.deepEqual(await h.pass(), ['vm:stop p abc-3-e']);
  assert.deepEqual(h.holds(), ['hold Out of memory: 0.1 GiB available on this Mac, below the 6.0 GiB a p VM needs (its configured 4.0 GiB plus a 2 GiB margin): abc-3-a not started — no p VM starts or is created until there is; its variation waits as for a slot, no failure counted']);
  assert.ok(h.f.lines.includes('vm p abc-3-a: not started: out of memory; waits as for a slot'), h.f.lines.join('\n'));
  assert.ok(h.f.lines.includes('vm p abc-3-b: not recreated: out of memory; waits as for a slot'), h.f.lines.join('\n'));
  assert.equal(h.f.ctx.memory.vms.get('p').held.size, 0, 'no failure counted, no backoff');
  assert.deepEqual(h.record(), { since: '2026-11-12T10:00:00Z', 'available-bytes': 60 * 2 ** 20, 'need-bytes': 6 * GIB, vm: 'abc-3-a' });
  // Its steps wait as for a slot: not judged, past VM_WAIT too.
  const state = h.f.ctx.load(), project = state.projects[0], a = project.tickets[0].variations.find(v => v.name === 'A');
  h.later(VM_WAIT + MEMORY_READ_EVERY);
  assert.deepEqual(await h.pass(), ['vm:stop p abc-3-e']);
  assert.equal(awaitsVm(h.f.ctx, state, project, a, 'ABC-3 A build'), true);
  assert.ok(!h.f.lines.some(l => /is not running after/.test(l)), h.f.lines.join('\n'));
  assert.equal(h.holds().length, 1, 'logged once');
  assert.equal(h.f.lines.filter(l => /abc-3-a: not started: out of memory/.test(l)).length, 1, 'said once per VM');

  h.free(16 * GIB);
  h.later(MEMORY_READ_EVERY);
  assert.deepEqual(await h.pass(), ['vm:create p ABC-3 B', 'vm:start p ABC-3 A', 'vm:stop p abc-3-e']);
  assert.ok(h.holds().includes('hold memory back: 16.0 GiB available, at or above the 6.0 GiB a p VM needs — the out-of-memory hold lifted at 2026-11-12T10:02:20Z (held since 2026-11-12T10:00:00Z); VMs start again'), h.holds().join('\n'));
  assert.equal(h.record(), null, 'its record removed');
  assert.equal(awaitsVm(h.f.ctx, h.f.ctx.load(), project, a, 'ABC-3 A build'), false);
});

test('ASS-398 AC3: the hold lifts on its own once memory frees, though no VM waits to start any more; the memory is read at most every 10 seconds; a record an earlier control left is removed', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'] });
  h.free(GIB);
  await h.pass();
  assert.ok(h.record());
  const reads = h.reads();
  await h.pass();
  assert.equal(h.reads(), reads, 'read again only after MEMORY_READ_EVERY');
  writeFileSync(h.file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [], features: [] }));
  h.free(8 * GIB);
  h.later(MEMORY_READ_EVERY);
  await h.pass();
  assert.ok(h.holds().some(l => /^hold memory back: 8\.0 GiB available/.test(l)), h.holds().join('\n'));
  assert.equal(h.record(), null);
  writeFileSync(h.file('projects', 'p', 'memory-hold.json'), '{"since":"2026-11-01T00:00:00Z"}');   // a previous control's
  await h.pass();
  assert.equal(h.record(), null);
});

test('ASS-398 AC1: harness.json\'s memory-free-hold-gib sets the threshold; with enough memory nothing is held and nothing logged', async () => {
  const h = holding({ A: [BUILDING, 'Stopped'] }, { harness: { 'memory-free-hold-gib': 1 } });
  h.free(2 * GIB);                                                            // below 4 GiB + 2, above the 1 GiB set
  assert.deepEqual(await h.pass(), ['vm:start p ABC-3 A']);
  assert.deepEqual(h.holds(), []);
  assert.equal(h.record(), null);
});

test('ASS-398 AC1: a script step that creates a VM (vm:create) waits, not run, while memory is short — said once, no failure — the hold on; it runs once memory frees', async () => {
  const f = controlFixture();
  const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.find(s => s.id === 'build').action.command = 'echo vm:create {project} {ticket} {variation}';
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': hs('build'), 'state-changes': [] }] });
  });
  let now = Date.parse('2026-11-12T10:00:00Z'), bytes = GIB;
  f.ctx.now = () => new Date(now);
  f.ctx.availableMemory = async () => bytes;
  for (let i = 0; i < 3; i++) { await runSteps(f.ctx, f.ctx.load()); now += MEMORY_READ_EVERY; }
  assert.equal(f.lines.filter(l => l === 'steps ABC-4 A build: waits: out of memory').length, 1, f.lines.join('\n'));
  assert.ok(!f.lines.some(l => /^script .*vm:create/.test(l)), f.lines.join('\n'));
  assert.ok(existsSync(join(f.dir, 'projects', 'p', 'memory-hold.json')));
  assert.ok(f.lines.some(l => /^hold Out of memory: 1\.0 GiB available on this Mac, below the 6\.0 GiB a p VM needs .*: its VM not started/.test(l)), f.lines.join('\n'));
  bytes = 8 * GIB;
  await runSteps(f.ctx, f.ctx.load());
  assert.ok(f.lines.some(l => /^hold memory back: 8\.0 GiB available/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /^script .*vm:create p ABC-4 A$/.test(l)), f.lines.join('\n'));
  assert.ok(!existsSync(join(f.dir, 'projects', 'p', 'memory-hold.json')));
});
