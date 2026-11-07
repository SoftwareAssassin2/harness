// automated-tests:record (ASS-180 AC1): the agent records the automated
// tests it wrote for a ticket variation through one locked CLI command, the
// JSON list on stdin — automated-tests-<V>.json. [] (manual-only, ASS-49)
// is accepted verbatim; otherwise every element must be an object with
// string "list" and "run". Nothing else is written; invalid input is refused
// with the file left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'at-record-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-5'), { recursive: true });
  return { dir, folder: join(dir, 'p', 'work', 'ABC-5') };
}
function cli(dir, input, ...args) {
  return new Promise(resolve => {
    const child = execFile(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}
const file = (folder, variation) => join(folder, `automated-tests-${variation}.json`);
const snapshot = folder => readdirSync(folder).filter(f => !f.endsWith('.lock')).sort().map(f => `${f}\n${readFileSync(join(folder, f), 'utf8')}`).join('\n---\n');

test('automated-tests:record writes stdin verbatim into automated-tests-<V>.json, replacing an existing one', async () => {
  const { dir, folder } = projects();
  const list = '[{"list":"pnpm nx test web --list","run":"pnpm nx test web"}]';
  const r = await cli(dir, list, 'automated-tests:record', 'p', 'abc-5', 'A');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(file(folder, 'A'), 'utf8'), list, 'byte-equal, not reformatted');
  const next = '[\n  {"list":"a","run":"b"},\n  {"list":"c","run":"d"}\n]\n';
  assert.equal((await cli(dir, next, 'automated-tests:record', 'p', 'ABC-5', 'A')).code, 0);
  assert.equal(readFileSync(file(folder, 'A'), 'utf8'), next, 'replaced byte-for-byte');
  assert.deepEqual(readdirSync(folder).filter(f => !/\.(json|lock)$/.test(f)), [], 'no stray temp');
});

test('automated-tests:record accepts [] (manual-only, ASS-49) verbatim', async () => {
  const { dir, folder } = projects();
  assert.equal((await cli(dir, '[]', 'automated-tests:record', 'p', 'ABC-5', 'A')).code, 0);
  assert.equal(readFileSync(file(folder, 'A'), 'utf8'), '[]');
  assert.equal((await cli(dir, '[]\n', 'automated-tests:record', 'p', 'ABC-5', 'B')).code, 0);
  assert.equal(readFileSync(file(folder, 'B'), 'utf8'), '[]\n');
});

test('ASS-227 AC1: automated-tests:record accepts an entry marked "reproduces": true (red on master by design) verbatim', async () => {
  const { dir, folder } = projects();
  const list = '[{"list":"echo parity","run":"./parity.sh","reproduces":true},{"list":"a","run":"b","reproduces":false}]';
  assert.equal((await cli(dir, list, 'automated-tests:record', 'p', 'ABC-5', 'A')).code, 0);
  assert.equal(readFileSync(file(folder, 'A'), 'utf8'), list);
});

test('automated-tests:record writes variation B\'s file, leaving A\'s alone', async () => {
  const { dir, folder } = projects();
  const a = '[{"list":"a","run":"A"}]';
  await cli(dir, a, 'automated-tests:record', 'p', 'ABC-5', 'A');
  const b = '[{"list":"b","run":"B"}]';
  assert.equal((await cli(dir, b, 'automated-tests:record', 'p', 'ABC-5', 'B')).code, 0);
  assert.equal(readFileSync(file(folder, 'A'), 'utf8'), a);
  assert.equal(readFileSync(file(folder, 'B'), 'utf8'), b);
});

test('automated-tests:record refuses bad shapes, exit 1, naming the expected shape and left-as-it-was, nothing written', async () => {
  const { dir, folder } = projects();
  const good = '[{"list":"a","run":"b"}]';
  await cli(dir, good, 'automated-tests:record', 'p', 'ABC-5', 'A');
  const before = snapshot(folder);
  for (const [name, body] of [
    ['not JSON', 'not json\n'],
    ['object', '{}'],
    ['missing run', '[{"list":"x"}]'],
    ['non-string list', '[{"list":1,"run":"y"}]'],
    ['non-object element', '["x"]'],
    ['two JSON values', '[] []'],
    ['empty stdin', ''],
    ['nested array', '[[{"list":"a","run":"b"}]]'],
    ['non-boolean reproduces', '[{"list":"a","run":"b","reproduces":"true"}]'],
  ]) {
    const r = await cli(dir, body, 'automated-tests:record', 'p', 'ABC-5', 'A');
    assert.equal(r.code, 1, `${name}: expected exit 1 — got ${JSON.stringify(r)}`);
    assert.match(r.stderr, /automated-tests:record/, name);
    assert.match(r.stderr, /left as it was/, name);
  }
  assert.equal(snapshot(folder), before, 'nothing on disk changed');
});

test('automated-tests:record refuses bad project, ticket, variation and missing work folder', async () => {
  const { dir, folder } = projects();
  for (const [args, pat] of [
    [['../p', 'ABC-5', 'A'], /invalid project/],
    [['p', '../ABC-5', 'A'], /invalid ticket/],
    [['p', 'ABC-5', 'A/..'], /invalid variation/],
    [['p', 'ABC-9', 'A'], /no work folder|has no work/],
  ]) {
    const r = await cli(dir, '[]', 'automated-tests:record', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, pat, args.join(' '));
  }
  const outside = join(dir, 'outside.json');
  writeFileSync(outside, '[]');
  symlinkSync(outside, join(folder, 'automated-tests-A.json'));
  const r = await cli(dir, '[{"list":"x","run":"y"}]', 'automated-tests:record', 'p', 'ABC-5', 'A');
  assert.equal(r.code, 1, 'a symlink out of the work folder is refused');
  assert.equal(readFileSync(outside, 'utf8'), '[]', 'the outside file is untouched');
});

test('automated-tests:record locks beside the file and queues under a held lock', async () => {
  const { dir, folder } = projects();
  const target = file(folder, 'A');
  // Pre-create the lock holder.
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${target}.lock`]);
  await new Promise(resolve => holder.stdout.once('data', () => resolve()));
  try {
    const env = { ...process.env, PROJECTS_DIR: dir, JSON_LOCK_TIMEOUT: '1' };
    const pending = new Promise(resolve => {
      const c = execFile(AGENT, ['automated-tests:record', 'p', 'ABC-5', 'A'], { env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
      c.stdin.end('[]');
    });
    const result = await pending;
    assert.equal(result.code, 1, 'the held lock makes the write refuse within the timeout');
    assert.ok(!existsSync(target), 'the file was not written');
  } finally { holder.kill('SIGKILL'); }
  assert.ok(existsSync(`${target}.lock`), 'the lock file sits beside the target');
});

test('work:write still refuses automated-tests-<V>.json (WORK_MANAGED unchanged)', async () => {
  const { dir } = projects();
  const r = await cli(dir, '[]', 'work:write', 'p', 'ABC-5', 'A', 'automated-tests.json');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /work:write: .* is the harness's own/);
});
