// One harness at a time (ASS-338, src/single-instance.js): a pid file under
// a folder of the test's own, claimed, refused while a live owner holds it,
// taken over once its process is gone or no longer the owner, and released.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { claim, release, runs } from '../src/single-instance.js';

const pidfile = () => join(mkdtempSync(join(tmpdir(), 'single-')), 'home', 'run-tui.pid');

test('ASS-338 AC1: claim makes the folder and writes the pid file with our pid', () => {
  const file = pidfile();
  assert.deepEqual(claim(file, { pid: 111, owner: () => true }), { claimed: true });
  assert.equal(readFileSync(file, 'utf8'), '111\n');
});

test('ASS-338 AC1: a claim held by a live owner is refused, naming its pid, and left as it is', () => {
  const file = pidfile();
  claim(file, { pid: 111, owner: () => true });
  assert.deepEqual(claim(file, { pid: 222, owner: pid => pid === 111 }), { claimed: false, pid: 111 });
  assert.equal(readFileSync(file, 'utf8'), '111\n');
});

test('ASS-338 AC1: a claim whose process is gone, or is not the owner (its pid reused), is stale and taken over', () => {
  for (const owner of [() => false, pid => pid === 999]) {
    const file = pidfile();
    claim(file, { pid: 111, owner: () => true });
    assert.deepEqual(claim(file, { pid: 222, owner }), { claimed: true });
    assert.equal(readFileSync(file, 'utf8'), '222\n');
  }
});

test('ASS-338 AC1: an unreadable or empty pid file is stale too', () => {
  const file = pidfile();
  claim(file, { pid: 111, owner: () => true });
  writeFileSync(file, 'junk');
  assert.deepEqual(claim(file, { pid: 222, owner: () => true }), { claimed: true });
  assert.equal(readFileSync(file, 'utf8'), '222\n');
});

test('ASS-338 AC1: release removes the file only while it names us; claiming again after it works (a restart)', () => {
  const file = pidfile();
  claim(file, { pid: 111, owner: () => true });
  release(file, 222);
  assert.equal(readFileSync(file, 'utf8'), '111\n');
  release(file, 111);
  assert.equal(existsSync(file), false);
  release(file, 111);   // nothing there: no error
  assert.deepEqual(claim(file, { pid: 333, owner: () => true }), { claimed: true });
});

// `n` processes claiming `file` at the same moment (each spins until `at`),
// each holding on a second so the others find it alive: what each got.
const SINGLE = join(import.meta.dirname, '..', 'src', 'single-instance.js');
function racers(file, n) {
  const at = Date.now() + 800;
  const code = `import { claim } from ${JSON.stringify(SINGLE)};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
while (Date.now() < ${at});
console.log(JSON.stringify(claim(${JSON.stringify(file)}, { owner: alive })));
setTimeout(() => {}, 1000);`;
  return Promise.all(Array.from({ length: n }, () => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => resolve(JSON.parse(out)));
  })));
}

test('ASS-338 AC1: of several started at the same moment, exactly one wins — with no file, and with a stale one', async () => {
  for (const stale of [false, true]) {
    const file = pidfile();
    if (stale) claim(file, { pid: 999999, owner: () => true });   // no such process
    const results = await racers(file, 6);
    assert.equal(results.filter(r => r.claimed).length, 1, JSON.stringify(results));
  }
});

test('ASS-338 AC1: runs(script) is true only for a live process whose command runs that script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'single-'));
  mkdirSync(join(dir, 'tui'));
  writeFileSync(join(dir, 'tui', 'main.js'), 'setTimeout(() => {}, 60000);');
  const child = spawn(process.execPath, [join(dir, 'tui', 'main.js')], { stdio: 'ignore' });
  try {
    assert.equal(runs('tui/main.js')(child.pid), true);
    assert.equal(runs('downloader/main.js')(child.pid), false);
  } finally {
    child.kill();
  }
  await new Promise(resolve => child.once('close', resolve));
  assert.equal(runs('tui/main.js')(child.pid), false);
});
