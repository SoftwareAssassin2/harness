// ASS-515: `npm test` runs the suite through test/run.sh, which gives the run
// one folder of its own, /tmp/harness-test.XXXXXX, as TMPDIR and removes it on
// exit — pass, fail or interrupt — keeping node's exit status. Each case runs
// the wrapper on a throwaway fixture test file (kept in this test's own folder,
// outside test/**) that reports the TMPDIR it saw and the folders it made; the
// checks are on that reported folder, not a /tmp listing, so a concurrent run
// can't flake them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const RUN_DIR = /^\/tmp\/harness-test\.[A-Za-z0-9]{6}$/;

// A fixture test file: makes a mkdtemp folder, a read-only folder with a file
// in it, and (not on macOS) a bash `mktemp -d` folder; writes its report; then `end`.
function fixture(t, end = '') {
  const dir = mkdtempSync(join(tmpdir(), 'runsh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.test.js');
  const report = join(dir, 'report.json');
  writeFileSync(file, `
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
test('fixture', async () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
  const ro = path.join(a, 'ro');
  fs.mkdirSync(ro); fs.writeFileSync(path.join(ro, 'f'), 'x'); fs.chmodSync(ro, 0o555);
  // macOS's mktemp with no template ignores TMPDIR (the per-user /var/folders/…/T, never /tmp); elsewhere it follows TMPDIR.
  const b = process.platform === 'darwin' ? [] : [execFileSync('mktemp', ['-d']).toString().trim()];
  fs.writeFileSync(process.env.RUNSH_REPORT, JSON.stringify({ TMPDIR: process.env.TMPDIR, tmpdir: os.tmpdir(), made: [a, ro, ...b] }));
  ${end}
});
`);
  return { file, report };
}

// Without NODE_TEST_CONTEXT: else the inner node --test reports to this runner, not to its stdout.
const env = report => { const e = { ...process.env, RUNSH_REPORT: report }; delete e.NODE_TEST_CONTEXT; return e; };

function checkReport(report) {
  assert.ok(existsSync(report), 'the fixture ran under bash test/run.sh and wrote its report');
  const r = JSON.parse(readFileSync(report, 'utf8'));
  assert.match(r.TMPDIR, RUN_DIR);
  assert.equal(r.tmpdir, r.TMPDIR);
  for (const d of r.made) assert.ok(d.startsWith(r.TMPDIR + '/'), `${d} is under ${r.TMPDIR}`);
  return r;
}

test('ASS-515 AC1: a passing run gets its own /tmp/harness-test.XXXXXX TMPDIR, exits 0, runs only the file given, and leaves nothing behind', t => {
  const { file, report } = fixture(t);
  const out = spawnSync('bash', ['test/run.sh', file], { cwd: ROOT, env: env(report), encoding: 'utf8', timeout: 120000 });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /\btests 1\b/);
  const r = checkReport(report);
  assert.ok(!existsSync(r.TMPDIR), `${r.TMPDIR} removed`);
});

test('ASS-515 AC2: a failing run keeps node\'s exit status (1) and still removes its folder', t => {
  const { file, report } = fixture(t, "require('node:assert').fail('on purpose');");
  const out = spawnSync('bash', ['test/run.sh', file], { cwd: ROOT, env: env(report), encoding: 'utf8', timeout: 120000 });
  assert.equal(out.status, 1, out.stdout + out.stderr);
  const r = checkReport(report);
  assert.ok(!existsSync(r.TMPDIR), `${r.TMPDIR} removed`);
});

test('ASS-515 AC2: an interrupted run (SIGTERM to its process group) still removes its folder', async t => {
  const { file, report } = fixture(t, 'await new Promise(r => setTimeout(r, 600000));');
  const child = spawn('bash', ['test/run.sh', file], { cwd: ROOT, env: env(report), detached: true, stdio: 'ignore' });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  for (let i = 0; i < 300 && !existsSync(report) && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
  const r = checkReport(report);
  process.kill(-child.pid, 'SIGTERM');
  const done = await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 30000))]);
  assert.notEqual(done, 'timeout', 'the wrapper exits on SIGTERM');
  assert.ok(done.code !== 0, 'not a success');
  assert.ok(!existsSync(r.TMPDIR), `${r.TMPDIR} removed`);
});

test('ASS-515 AC1: no test makes its temp folder under a hard-coded /tmp (it would escape the run\'s TMPDIR)', () => {
  const files = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.js$/.test(n) && files.push(p); } };
  walk(join(ROOT, 'test'));
  const found = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/mkdtemp(Sync)?\(\s*['"`]\/tmp/.test(line)) found.push(`${relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

test('ASS-515: npm test runs the suite through test/run.sh', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'bash test/run.sh');
});
