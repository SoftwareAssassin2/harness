// ASS-350: a rotated key — a declared keychain item saved again, its kind
// unchanged — is noticed. vm:credentials records each injected item's keychain
// modification time on the VM's vms.json row (credential-stamps); control reads
// the stamps now (vm:credential-stamps, at most once per VM job pass per
// project) and refreshes, through vm:start, a Running, reached VM whose
// recorded stamp differs — once idle, its wait logged once, as a kind change
// is. A VM recording no stamps (started before ASS-350) is not compared.
// Driven as tick-vm-lifecycle.test.js: the real grouped engines; agent.sh a
// recorder answering as vm:start and vm:credential-stamps do; limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { superviseVms } from '../../src/control/vm-lifecycle.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ENGINE = 'example-development-grouped';
const at = (state, sub) => ({ state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) });
const BUILDING = at('build', ['grouped-build', 'generate-solution']);
const OLD = { anthropic: '20261110120000Z', github: '20261001090000Z' };

// p on example-development-grouped, ticket ABC-3's variations `names`, each VM abc-3-<name> Running; its vms.json row
// recording `rows[name]` as credential-stamps (none for null); the keychain's stamps now `keychain` (changeable via
// l.keychain), read through vm:credential-stamps, which l.reads counts; vm:start records the stamps now, as vm:credentials does.
// The clock is l.clock (ms), moved by l.advance(seconds); harness.json's credential-stamp-interval-seconds `interval` when given (ASS-356).
function stamped(names, rows, { keychain = OLD, failStamps = false, interval } = {}) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  for (const name of engineNames()) if (!existsSync(file('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), file('engines', name), { recursive: true });
  const project = JSON.parse(readFileSync(file('projects', 'p', 'project.json'), 'utf8'));
  writeFileSync(file('projects', 'p', 'project.json'), JSON.stringify({ ...project, 'execution-state-engine': ENGINE }));
  writeFileSync(file('harness.json'), JSON.stringify({ ...JSON.parse(readFileSync(file('harness.json'), 'utf8')), 'max-tickets-in-progress': null, ...(interval != null ? { 'credential-stamp-interval-seconds': interval } : {}) }));
  const v = fakeVm(f.env);
  const sprint = file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', 'ticket-system-status': 'In Progress', variations: names.map(name => {
    v.instance(`abc-3-${name.toLowerCase()}`, 'Running');
    return { name, 'harness-status': BUILDING, 'state-changes': [], vm: { name: `abc-3-${name.toLowerCase()}`, ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' } };
  }) }] }));
  const vmsFile = file('projects', 'p', 'vms.json');
  writeFileSync(vmsFile, JSON.stringify(Object.fromEntries(names.map(name => [`abc-3-${name.toLowerCase()}`,
    { ticket: 'ABC-3', variation: name, state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-11-10T00:00:00Z', 'credential-kind': 'anthropic', ...(rows[name] ? { 'credential-stamps': rows[name] } : {}) }]))));
  const home = file('harness-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'vm-credentials.json'), JSON.stringify({ p: { anthropic: { 'keychain-service': 'Example API Key' }, github: { 'keychain-service': 'Example PAT' } } }));
  f.ctx.env = { ...v.env, HARNESS_HOME: home };
  const l = { f, file, vmsFile, reads: 0, keychain, failStamps, clock: Date.parse('2026-11-10T15:00:00Z') };
  f.ctx.now = () => new Date(l.clock);
  l.advance = seconds => { l.clock += seconds * 1000; };
  const calls = [];
  f.ctx.cli = async args => {
    calls.push(args.join(' '));
    let out = '';
    if (args[0] === 'vm:credential-stamps') {
      l.reads++;
      if (l.failStamps) throw new Error('vm:credential-stamps: no declaration');
      out = JSON.stringify(l.keychain);
    } else if (args[0] === 'vm:start') {
      const name = `abc-3-${args[3].toLowerCase()}`, vms = JSON.parse(readFileSync(vmsFile, 'utf8'));
      vms[name] = { ...vms[name], 'credential-stamps': l.keychain };
      writeFileSync(vmsFile, JSON.stringify(vms));
      out = JSON.stringify({ name, ip: '192.168.64.9', 'credential-kind': 'anthropic' });
    }
    return out;
  };
  l.assign = (variation, on = true) => {
    const path = f.ctx.paths.assignments, data = JSON.parse(readFileSync(path, 'utf8'));
    data.assignments = on ? [{ 'agent-name': 'Zed', project: 'p', 'work-item': 'ABC-3', variation, 'state-engine': 'grouped-build', state: 'generate-solution', status: 'Running', 'process-id': 4242 }] : [];
    writeFileSync(path, JSON.stringify(data));
  };
  l.row = name => JSON.parse(readFileSync(vmsFile, 'utf8'))[name];
  l.pass = async () => {
    const before = calls.length;
    await superviseVms(f.ctx, f.ctx.load());
    await Promise.all([...f.ctx.memory.vms.values()].map(r => r.job));
    return calls.slice(before).filter(c => !c.startsWith('vm:credential-stamps')).sort();
  };
  return l;
}

test('ASS-350 AC2: a Running, reached, idle VM whose recorded stamp differs from the keychain\'s now is refreshed through vm:start, logged naming the item; its row takes the new stamps and the next pass leaves it be', async () => {
  const l = stamped(['A', 'B'], { A: OLD, B: OLD }, { keychain: { ...OLD, anthropic: '20261110140759Z' } });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:start p ABC-3 B']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: credentials refreshed (ABC-3 A at build; anthropic key changed)'), l.f.lines.join('\n'));
  assert.deepEqual(l.row('abc-3-a')['credential-stamps'], { ...OLD, anthropic: '20261110140759Z' });
  assert.deepEqual(await l.pass(), []);
  l.keychain = { anthropic: '20261110150000Z', github: '20261110150001Z' };
  l.advance(300);   // ASS-356: read again once the interval has passed
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:start p ABC-3 B']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: credentials refreshed (ABC-3 A at build; anthropic, github keys changed)'), l.f.lines.join('\n'));
  assert.ok(!l.f.lines.some(x => /^error /.test(x)), l.f.lines.join('\n'));
});

test('ASS-350 AC3: with an assignment on its variation the refresh waits until it is idle, logged once; then the first job after it ends refreshes it', async () => {
  const l = stamped(['A'], { A: OLD }, { keychain: { ...OLD, github: '20261110140759Z' } });
  l.assign('A');
  assert.deepEqual(await l.pass(), []);
  assert.deepEqual(await l.pass(), []);
  assert.deepEqual(l.f.lines.filter(x => /idle/.test(x)), ['vm p abc-3-a: credentials to refresh (github key changed); waits until it is idle']);
  l.assign('A', false);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: credentials refreshed (ABC-3 A at build; github key changed)'), l.f.lines.join('\n'));
  assert.equal(l.f.lines.filter(x => /idle/.test(x)).length, 1, l.f.lines.join('\n'));
});

test('ASS-350 AC4: the keychain stamps are read once per VM job pass for the project, however many VMs it has; not at all when no VM due the comparison records stamps', async () => {
  const l = stamped(['A', 'B', 'C', 'D'], { A: OLD, B: OLD, C: OLD, D: OLD });
  assert.deepEqual(await l.pass(), []);
  assert.equal(l.reads, 1);
  l.advance(300);   // ASS-356: a pass within the interval reads nothing
  assert.deepEqual(await l.pass(), []);
  assert.equal(l.reads, 2);
  const none = stamped(['A', 'B'], { A: null, B: null });
  await none.pass();
  assert.equal(none.reads, 0);
});

test('ASS-350: a VM recorded before stamps (none on its row) is not refreshed for lacking them; it gets them at its next start', async () => {
  const l = stamped(['A'], { A: null }, { keychain: { anthropic: '20261110140759Z' } });
  assert.deepEqual(await l.pass(), []);
  assert.equal(l.row('abc-3-a')['credential-stamps'], undefined);
  assert.ok(!l.f.lines.some(x => /refresh/.test(x)), l.f.lines.join('\n'));
});

test('ASS-350: an item the keychain stamps now but the row does not (newly declared), or the row stamps but the keychain read leaves out, is not a change', async () => {
  const l = stamped(['A', 'B'], { A: { anthropic: OLD.anthropic }, B: OLD }, { keychain: { github: '20261110140759Z', anthropic: OLD.anthropic } });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 B']);   // B's github changed; A records no github stamp
  l.keychain = { github: '20261110140759Z' };   // anthropic unreadable now: left out
  assert.deepEqual(await l.pass(), []);
});

test('ASS-350: a vm:credential-stamps that fails is logged once under error, compares nothing, and is read again next interval', async () => {
  const l = stamped(['A', 'B'], { A: OLD, B: OLD }, { failStamps: true });
  assert.deepEqual(await l.pass(), []);
  l.advance(300);   // ASS-356: tried again once the interval has passed
  assert.deepEqual(await l.pass(), []);
  assert.equal(l.reads, 2);
  assert.equal(l.f.lines.filter(x => /^error .*vm:credential-stamps/.test(x)).length, 1, l.f.lines.join('\n'));
});

// ASS-356: the stamps are cached per project in control memory with the time
// they were read, and read again at most once per credential-stamp-interval-seconds.
// A tick every 5 s (control's loop runs every 2–3 s; 5 keeps the test quick).
const ticks = async (l, n, seconds = 5) => { const out = []; for (let i = 0; i < n; i++) { out.push(...await l.pass()); l.advance(seconds); } return out; };

test('ASS-356 AC1: the stamps are read at most once per interval (300 s by default) over many ticks, cached in control memory with the time read', async () => {
  const l = stamped(['A', 'B'], { A: OLD, B: OLD });
  assert.deepEqual(await ticks(l, 60), []);   // 300 s of ticks
  assert.equal(l.reads, 1);
  assert.deepEqual(l.f.ctx.memory.vmStamps.get('p'), { at: Date.parse('2026-11-10T15:00:00Z'), stamps: OLD });
  await ticks(l, 60);   // the next 300 s
  assert.equal(l.reads, 2);
  assert.deepEqual(l.f.ctx.memory.vmStamps.get('p').at, Date.parse('2026-11-10T15:05:00Z'));
  const short = stamped(['A'], { A: OLD }, { interval: 60 });   // harness.json's credential-stamp-interval-seconds
  await ticks(short, 120);   // 600 s
  assert.equal(short.reads, 10);
  assert.ok(!l.f.lines.some(x => /^error /.test(x)), l.f.lines.join('\n'));
});

test('ASS-356 AC2: a key rotated within the interval is seen at the first read after it, and the VM refreshed then (idle) or once idle (busy, logged once)', async () => {
  const l = stamped(['A', 'B'], { A: OLD, B: OLD });
  l.assign('B');
  assert.deepEqual(await ticks(l, 4), []);
  l.keychain = { ...OLD, anthropic: '20261110150100Z' };
  assert.deepEqual(await ticks(l, 56), []);   // still within the interval: the cached stamps, unchanged
  assert.equal(l.reads, 1);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);   // 300 s on: read again; A refreshed, B busy
  assert.equal(l.reads, 2);
  assert.ok(l.f.lines.includes('vm p abc-3-a: credentials refreshed (ABC-3 A at build; anthropic key changed)'), l.f.lines.join('\n'));
  assert.deepEqual(await ticks(l, 8), []);
  assert.deepEqual(l.f.lines.filter(x => /idle/.test(x)), ['vm p abc-3-b: credentials to refresh (anthropic key changed); waits until it is idle']);
  l.assign('B', false);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 B']);   // the cached stamps still show it changed
  assert.equal(l.reads, 2);
});

test('ASS-356 AC3: with no running, reached VM recording stamps, no tick reads the keychain', async () => {
  const l = stamped(['A', 'B'], { A: null, B: null });
  await ticks(l, 160);
  assert.equal(l.reads, 0);
  assert.equal(l.f.ctx.memory.vmStamps?.get('p'), undefined);
});

test('ASS-356 AC4: a failed read is tried again only once the interval has passed, logged once until a read succeeds; logged again on a later failure', async () => {
  const l = stamped(['A'], { A: OLD }, { failStamps: true });
  assert.deepEqual(await ticks(l, 60), []);
  assert.equal(l.reads, 1);
  await ticks(l, 120);
  assert.equal(l.reads, 3);
  const failures = () => l.f.lines.filter(x => /^error .*vm:credential-stamps/.test(x)).length;
  assert.equal(failures(), 1, l.f.lines.join('\n'));
  l.failStamps = false;
  await ticks(l, 60);
  assert.equal(l.reads, 4);
  assert.deepEqual(l.f.ctx.memory.vmStamps.get('p').stamps, OLD);
  l.failStamps = true;
  await ticks(l, 60);
  assert.equal(l.reads, 5);
  assert.equal(failures(), 2, l.f.lines.join('\n'));
});

test('ASS-356 AC5: a VM control refreshed is not refreshed again for the same stamps, nor for stamps cached before its refresh recorded later ones', async () => {
  const l = stamped(['A'], { A: OLD }, { keychain: { ...OLD, anthropic: '20261110140759Z' } });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);
  // The key rotated again after the read but before vm:start recorded the row's stamps: the row is later than the cache.
  const later = { ...OLD, anthropic: '20261110145959Z' };
  const rows = JSON.parse(readFileSync(l.vmsFile, 'utf8'));
  rows['abc-3-a']['credential-stamps'] = later;
  writeFileSync(l.vmsFile, JSON.stringify(rows));
  l.keychain = later;
  assert.deepEqual(await ticks(l, 59), []);   // the rest of the interval on the older cached stamps
  assert.deepEqual(await ticks(l, 120), []);   // later reads: the row's own stamps
  assert.equal(l.reads, 3);
  assert.equal(l.f.lines.filter(x => /credentials refreshed/.test(x)).length, 1, l.f.lines.join('\n'));
});
