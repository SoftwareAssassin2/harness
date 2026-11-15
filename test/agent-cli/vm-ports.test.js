// ASS-467 (and ASS-465): every VM keeps an ssh port (ssh.localPort in its
// lima.yaml) no other instance under LIMA_HOME pins. free_port skips every
// port pinned there, running or stopped, as well as those in use now;
// vm:start re-pins a stopped VM whose port another instance pins or
// something holds; vm:ports lists the pins and their clashes, and --fix
// re-pins the clashing stopped VMs. limactl is test/support/fake-limactl.js,
// LIMA_HOME its instances folder, each pin a lima.yaml there. VM_PORT_TRY
// offers chosen ports first, as the kernel's listen(0) might.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, AGENT } from './harness-fixture.js';
import { lima } from './vm-fixture.js';

const VM_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm.bash');
const pinOf = (l, vm) => Number(/^\s+localPort:\s*(\d+)/m.exec(readFileSync(join(l.v.instances, vm, 'lima.yaml'), 'utf8'))[1]);
// A port free now, and a listener holding one, closed by close().
const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const hold = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => done({ port: s.address().port, close: () => new Promise(c => s.close(c)) })); });
// distinctFree(n) — n different ports free now.
const distinctFree = async n => { const ports = new Set(); while (ports.size < n) ports.add(await freePort()); return [...ports]; };

test('ASS-465 AC1 / ASS-467 AC1: free_port never returns a port pinned in any instance\'s lima.yaml (a stopped one\'s, no listener on it), nor one in use now', async () => {
  const l = lima();
  const [pinned, other] = await distinctFree(2);
  l.v.instance('x', 'Stopped', String(pinned));
  const held = await hold();
  try {
    const ask = async (tries) => (await run('bash', ['-c', 'source "$0"; free_port', VM_BASH], { env: { ...l.env, VM_PORT_TRY: tries } })).stdout.trim();
    assert.equal(await ask(`${pinned} ${held.port} ${other}`), String(other), 'the pinned and the held ports passed over');
    const any = Number(await ask(`${pinned}`));
    assert.ok(any > 1024 && any !== pinned, `then any other free port: ${any}`);
    // A pin in a lima.yaml with nothing else beside the instance counts too; an instance pinning none (0) holds none back.
    mkdirSync(join(l.v.instances, 'y'), { recursive: true });
    writeFileSync(join(l.v.instances, 'y', 'lima.yaml'), `images: []\nssh:\n  # pinned\n  localPort: ${other}\nmounts: []\n`);
    l.v.instance('golden-q', 'Running');
    const third = Number(await ask(`${pinned} ${other}`));
    assert.ok(third !== pinned && third !== other);
    assert.deepEqual((await run('bash', ['-c', 'source "$0"; pinned_ports | sort', VM_BASH], { env: l.env })).stdout.trim().split('\n').sort(),
      [`x\t${pinned}`, `y\t${other}`].sort());
  } finally { await held.close(); }
});

test('ASS-465 AC2 / ASS-467 AC1: vm:create pins its clone to a port no other instance pins, under the harness-wide ssh port lock', async () => {
  const l = lima();
  l.mount();
  const [taken, next] = await distinctFree(2);
  l.v.instance('xyz-10-a', 'Stopped', String(taken));   // another project's, stopped: its port free on the Mac now
  await run(AGENT, ['vm:create', 'p', 'ABC-3', 'A'], { env: { ...l.env, VM_PORT_TRY: `${taken} ${next}` } });
  assert.equal(pinOf(l, 'abc-3-a'), next);
  const set = l.v.calls().find(c => c.argv?.[0] === 'clone').argv.at(-1);
  assert.match(set, new RegExp(`\\.ssh\\.localPort = ${next}$`));
  assert.ok(existsSync(join(l.f.dir, 'vm-ports.lock')), 'the lock beside harness.json');
  // Both scripts that clone pin through the pinned-aware allocator, under the lock.
  for (const script of ['create.sh', 'test-repos.sh']) {
    const text = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', script), 'utf8');
    assert.match(text, /lock_ports [\w:-]+ \|\| exit 1[^\n]*\n\s*ssh="\$\(free_port\)" \|\| exit 1/, script);
    assert.doesNotMatch(text, /listen\(0/, script);
  }
});

test('ASS-467 AC2: vm:start re-pins a stopped VM whose port another VM pins too, or something holds, to a free one before starting it, and says so', async () => {
  const l = lima();
  l.mount();
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  const first = pinOf(l, 'abc-3-a');
  // Another VM, running, pinned to the same port.
  l.v.instance('xyz-20-a', 'Running', String(first));
  writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'Stopped');
  const { stderr } = await l.cli('vm:start', 'p', 'ABC-3', 'A');
  const second = pinOf(l, 'abc-3-a');
  assert.notEqual(second, first);
  assert.equal(pinOf(l, 'xyz-20-a'), first, 'the other VM keeps its port');
  assert.match(stderr, new RegExp(`vm:start: abc-3-a's ssh port ${first} is pinned by xyz-20-a too; re-pinned to ${second}`));
  assert.equal(readFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'utf8'), 'Running');
  assert.ok(readFileSync(join(l.v.dir, 'sandbox-profile'), 'utf8').includes(`localhost:${second}"`), 'the sandbox lets it reach its new port');
  const calls = l.v.calls().map(c => c.argv?.[0]);
  assert.ok(calls.lastIndexOf('edit') < calls.lastIndexOf('start'), 're-pinned before it starts');
  // Something else on the Mac holding its port: re-pinned the same way.
  writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'Stopped');
  const held = await hold();
  try {
    await run('bash', ['-c', `sed -i.bak 's/localPort: .*/localPort: ${held.port}/' "$0"`, join(l.v.instances, 'abc-3-a', 'lima.yaml')]);
    const again = await l.cli('vm:start', 'p', 'ABC-3', 'A');
    assert.match(again.stderr, new RegExp(`abc-3-a's ssh port ${held.port} is held by another process now; re-pinned to ${pinOf(l, 'abc-3-a')}`));
    assert.notEqual(pinOf(l, 'abc-3-a'), held.port);
  } finally { await held.close(); }
  // A VM with a port of its own starts as it is: nothing re-pinned.
  writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'Stopped');
  const kept = pinOf(l, 'abc-3-a');
  const quiet = await l.cli('vm:start', 'p', 'ABC-3', 'A');
  assert.doesNotMatch(quiet.stderr, /re-pinned/);
  assert.equal(pinOf(l, 'abc-3-a'), kept);
});

test('ASS-467 AC3: vm:ports lists every pinned port and its clashes, changing nothing; --fix re-pins the clashing stopped VMs, the running one keeping its port', async () => {
  const l = lima();
  const [shared, own, lone] = await distinctFree(3);
  l.v.instance('xyz-20-a', 'Running', String(shared));
  l.v.instance('xyz-10-a', 'Stopped', String(shared));
  l.v.instance('q-1-a', 'Stopped', String(own));
  l.v.instance('r-1-a', 'Stopped', String(lone));
  l.v.instance('r-2-a', 'Stopped', String(lone));
  // xyz-10-a belongs to project q: --fix takes q's VM lock as it re-pins it.
  writeFileSync(join(l.f.dir, 'projects', 'q', 'vms.json'), JSON.stringify({ 'xyz-10-a': { ticket: 'XYZ-10', variation: 'A', state: 'Stopped' } }));
  const held = await hold();
  l.v.instance('s-1-a', 'Stopped', String(held.port));
  try {
    const report = await run(AGENT, ['vm:ports'], { env: l.env }).then(() => assert.fail('a clash exits 1'), e => e);
    assert.equal(report.code, 1);
    const out = JSON.parse(report.stdout);
    assert.deepEqual(out.vms.find(v => v.name === 'q-1-a'), { name: 'q-1-a', port: own, status: 'Stopped' });
    assert.equal(out.vms.length, 6);
    assert.deepEqual(new Set(out.clashes.map(c => JSON.stringify(c))), new Set([
      { port: shared, vms: ['xyz-10-a', 'xyz-20-a'], keeps: 'xyz-20-a', reason: 'shared' },
      { port: lone, vms: ['r-1-a', 'r-2-a'], keeps: 'r-1-a', reason: 'shared' },
      { port: held.port, vms: ['s-1-a'], keeps: null, reason: 'held' },
    ].map(c => JSON.stringify(c))));
    assert.deepEqual(out.repinned, []);
    assert.match(report.stderr, new RegExp(`vm:ports: port ${shared} clashes \\(shared\\): xyz-10-a, xyz-20-a; xyz-20-a keeps it`));
    assert.ok(!l.v.calls().some(c => c.argv?.[0] === 'edit'), 'the report changes nothing');
    assert.equal(pinOf(l, 'xyz-10-a'), shared);

    const { stdout, stderr } = await run(AGENT, ['vm:ports', '--fix'], { env: l.env });
    const fixed = JSON.parse(stdout);
    assert.deepEqual(fixed.clashes, []);
    assert.deepEqual(fixed.repinned.map(r => [r.name, r.from]).sort(), [['r-2-a', lone], ['s-1-a', held.port], ['xyz-10-a', shared]]);
    for (const r of fixed.repinned) assert.equal(pinOf(l, r.name), r.to);
    assert.equal(pinOf(l, 'xyz-20-a'), shared);
    assert.equal(pinOf(l, 'r-1-a'), lone);
    assert.equal(pinOf(l, 'q-1-a'), own);
    const ports = fixed.vms.map(v => v.port);
    assert.equal(new Set(ports).size, ports.length, 'every port pinned once');
    assert.match(stderr, /vm:ports: xyz-10-a's ssh port \d+ is pinned by xyz-20-a too; re-pinned to \d+/);
  } finally { await held.close(); }
  // Nothing left to fix: exit 0, nothing moved.
  const clean = JSON.parse((await run(AGENT, ['vm:ports', '--fix'], { env: l.env })).stdout);
  assert.deepEqual([clean.clashes, clean.repinned], [[], []]);
});

test('ASS-467 AC3: a running VM sharing a port is never re-pinned by --fix: Lima reads lima.yaml only as it starts', async () => {
  const l = lima();
  const [port] = await distinctFree(1);
  l.v.instance('a-1-a', 'Running', String(port));
  l.v.instance('b-1-a', 'Running', String(port));
  const e = await run(AGENT, ['vm:ports', '--fix'], { env: l.env }).then(() => assert.fail('the clash remains'), x => x);
  assert.equal(e.code, 1);
  assert.deepEqual(JSON.parse(e.stdout).repinned, []);
  assert.equal(pinOf(l, 'b-1-a'), port);
});
