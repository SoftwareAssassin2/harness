// work:write and work:append (ASS-181 AC2): an agent writes a report or the
// change log into the ticket's folder through one locked command, the content
// on stdin — the variation's own file (<name> with -<variation> before its
// extension: execution-plan.md for A is execution-plan-A.md), or with "-" the
// ticket's. Only a plain name the harness does not manage itself is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'work-write-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-5'), { recursive: true });
  return { dir, folder: join(dir, 'p', 'work', 'ABC-5') };
}
// Runs agent.sh with `input` on stdin: { code, stdout, stderr }.
function cli(dir, input, ...args) {
  return new Promise(resolve => {
    const child = execFile(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('work:write puts stdin, whole, in the variation\'s own file — <name>-<V>.<ext> — replacing it; "-" is the ticket\'s own <name>', async () => {
  const { dir, folder } = projects();
  assert.equal((await cli(dir, '# Plan\n', 'work:write', 'p', 'abc-5', 'A', 'execution-plan.md')).code, 0);
  assert.equal(readFileSync(join(folder, 'execution-plan-A.md'), 'utf8'), '# Plan\n');
  assert.equal((await cli(dir, '# Plan, again\n', 'work:write', 'p', 'ABC-5', 'A', 'execution-plan.md')).code, 0);
  assert.equal(readFileSync(join(folder, 'execution-plan-A.md'), 'utf8'), '# Plan, again\n');
  assert.equal((await cli(dir, 'B\'s\n', 'work:write', 'p', 'ABC-5', 'B', 'execution-plan.md')).code, 0);
  assert.equal(readFileSync(join(folder, 'execution-plan-B.md'), 'utf8'), 'B\'s\n', 'another variation never touches A\'s');
  assert.equal(readFileSync(join(folder, 'execution-plan-A.md'), 'utf8'), '# Plan, again\n');
  assert.equal((await cli(dir, 'three\n', 'work:write', 'p', 'ABC-5', '-', 'estimate.md')).code, 0);
  assert.equal(readFileSync(join(folder, 'estimate.md'), 'utf8'), 'three\n');
  assert.ok(!existsSync(join(folder, 'execution-plan.md')), 'no unsuffixed file');
  assert.deepEqual(readdirSync(folder).filter(f => !/\.(md|lock)$/.test(f)), [], 'no temp file left behind');
});

test('work:append adds stdin to the end of the variation\'s file (made when missing), a newline after it when it has none', async () => {
  const { dir, folder } = projects();
  assert.equal((await cli(dir, '- built the CLI\n', 'work:append', 'p', 'ABC-5', 'A', 'change-log.md')).code, 0);
  assert.equal((await cli(dir, '- and its tests', 'work:append', 'p', 'ABC-5', 'A', 'change-log.md')).code, 0);
  assert.equal(readFileSync(join(folder, 'change-log-A.md'), 'utf8'), '- built the CLI\n- and its tests\n');
  assert.ok(!existsSync(join(folder, 'change-log.md')));
});

test('work:append: appenders at once, each under the file\'s lock, never lose or interleave an entry', async () => {
  const { dir, folder } = projects();
  const entry = i => `${String(i).padStart(2, '0')} ${'x'.repeat(20_000)}\n`;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => cli(dir, entry(i), 'work:append', 'p', 'ABC-5', 'A', 'change-log.md')));
  assert.deepEqual(results.map(r => r.code), Array(12).fill(0), results.map(r => r.stderr).join(''));
  const lines = readFileSync(join(folder, 'change-log-A.md'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.toSorted(), Array.from({ length: 12 }, (_, i) => entry(i).trimEnd()));
});

test('a name is refused unless plain — ^[a-z0-9][a-z0-9-]*\\.(md|txt|log|json)$ — writing nothing', async () => {
  const { dir, folder } = projects();
  for (const name of ['../escape.md', 'sub/x.md', '.hidden.md', 'Upper.md', 'x.sh', 'x.md.sh', 'x', '-x.md', 'x..md', '', '/tmp/x.md']) {
    for (const command of ['work:write', 'work:append']) {
      const r = await cli(dir, 'x\n', command, 'p', 'ABC-5', 'A', name);
      assert.equal(r.code, 1, `${command} ${name}`);
      assert.match(r.stderr, new RegExp(`${command}: invalid name`), `${command} ${name}`);
    }
  }
  assert.deepEqual(readdirSync(folder), []);
});

test('a name the harness manages itself is refused, as given or as the variation\'s', async () => {
  const { dir, folder } = projects();
  for (const [variation, name] of [['A', 'ticket.json'], ['-', 'ticket.json'], ['-', 'acceptance-criteria.json'], ['A', 'acceptance-criteria.json'], ['-', 'questions-and-answers.json'],
    ['-', 'demo-plan-a.json'], ['A', 'demo-plan.json'], ['-', 'automated-tests-a.json'], ['A', 'automated-tests.json'], ['A', 'automated-test-results.md'],
    ['-', 'jira-comments.json'], ['-', 'collaboration.json']]) {
    const r = await cli(dir, '{}\n', 'work:write', 'p', 'ABC-5', variation, name);
    assert.equal(r.code, 1, `${variation} ${name}`);
    assert.match(r.stderr, /work:write: .* is the harness's own: not written/, `${variation} ${name}`);
  }
  // requirements-history.jsonl and *.lock fail the name's own shape first.
  for (const name of ['requirements-history.jsonl', 'change-log.md.lock']) assert.match((await cli(dir, 'x\n', 'work:write', 'p', 'ABC-5', '-', name)).stderr, /invalid name/);
  assert.deepEqual(readdirSync(folder), []);
});

test('the file must resolve inside the ticket\'s work folder: a symlink out is refused; so is a bad project, ticket or variation, a missing folder, or nothing on stdin', async () => {
  const { dir, folder } = projects();
  const outside = join(dir, 'outside.md');
  writeFileSync(outside, 'mine\n');
  symlinkSync(outside, join(folder, 'code-review-A.md'));
  assert.match((await cli(dir, 'x\n', 'work:write', 'p', 'ABC-5', 'A', 'code-review.md')).stderr, /not in ABC-5's work folder/);
  assert.match((await cli(dir, 'x\n', 'work:append', 'p', 'ABC-5', 'A', 'code-review.md')).stderr, /not in ABC-5's work folder/);
  assert.equal(readFileSync(outside, 'utf8'), 'mine\n');
  assert.match((await cli(dir, 'x\n', 'work:write', '..', 'ABC-5', 'A', 'x.md')).stderr, /invalid project/);
  assert.match((await cli(dir, 'x\n', 'work:write', 'p', '../ABC-5', 'A', 'x.md')).stderr, /invalid ticket/);
  assert.match((await cli(dir, 'x\n', 'work:write', 'p', 'ABC-5', 'A/..', 'x.md')).stderr, /invalid variation/);
  assert.match((await cli(dir, 'x\n', 'work:write', 'p', 'ABC-9', 'A', 'x.md')).stderr, /ABC-9 has no work folder/);
  assert.match((await cli(dir, 'x\n', 'work:write', 'p', 'ABC-5', 'A')).stderr, /usage: work:write/);
  assert.match((await cli(dir, '', 'work:write', 'p', 'ABC-5', 'A', 'x.md')).stderr, /nothing on stdin/);
  assert.match((await cli(dir, '', 'work:append', 'p', 'ABC-5', 'A', 'x.md')).stderr, /nothing on stdin/);
  assert.ok(!existsSync(join(folder, 'x-A.md')));
});

// ASS-182 AC2: a confined host agent writes only temp, so a health check's or memory check's report (a run's folder, run-<id>) goes through work:write too.
test('ASS-182 AC2: work:write takes a run\'s folder — run-<id>, as named — for the ticket key: a health or memory check\'s report', async () => {
  const { dir } = projects();
  const run = join(dir, 'p', 'work', 'run-0a1b2c3d-4e5f');
  mkdirSync(run);
  assert.equal((await cli(dir, '# Harness\n', 'work:write', 'p', 'run-0a1b2c3d-4e5f', '-', 'harness.md')).code, 0);
  assert.equal(readFileSync(join(run, 'harness.md'), 'utf8'), '# Harness\n');
});

// ASS-182: the VM's /mnt/ticket is read-only, so Take Screenshots saves each image through agent.sh, the PNG on stdin.
test('ASS-182: work:add-screenshot puts a PNG from stdin, byte for byte, in screenshots/<merge request id>/ — or, for "-", screenshots/ — under a plain .png name', async () => {
  const { dir, folder } = projects();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0x10]);
  assert.equal((await cli(dir, png, 'work:add-screenshot', 'p', 'abc-5', 'A', '2', 'criterion-1.png')).code, 0);
  assert.deepEqual(readFileSync(join(folder, 'screenshots', '2', 'criterion-1.png')), png);
  assert.equal((await cli(dir, png, 'work:add-screenshot', 'p', 'ABC-5', 'A', '-', 'criterion-2.png')).code, 0);
  assert.deepEqual(readFileSync(join(folder, 'screenshots', 'criterion-2.png')), png);
  for (const [id, name, why] of [['2', '../x.png', /invalid name/], ['2', 'x.md', /invalid name/], ['../2', 'x.png', /invalid merge request id/], ['0', 'x.png', /invalid merge request id/]])
    assert.match((await cli(dir, png, 'work:add-screenshot', 'p', 'ABC-5', 'A', id, name)).stderr, why, `${id} ${name}`);
  const empty = await cli(dir, '', 'work:add-screenshot', 'p', 'ABC-5', 'A', '2', 'criterion-3.png');
  assert.notEqual(empty.code, 0);
  assert.ok(!existsSync(join(folder, 'screenshots', '2', 'criterion-3.png')));
  assert.deepEqual(readdirSync(join(folder, 'screenshots', '2')), ['criterion-1.png'], 'no temp file left behind');
});

// ASS-228: operator-review-<V>.md is the operator's notes from Human Review
// rejections, appended by ticket:human-review alone: no agent writes or appends it.
test('ASS-228 AC2: operator-review.md is the operator\'s own — work:write and work:append refuse it, as given or as the variation\'s, writing nothing', async () => {
  const { dir, folder } = projects();
  for (const command of ['work:write', 'work:append']) {
    for (const [variation, name] of [['A', 'operator-review.md'], ['-', 'operator-review-a.md'], ['-', 'operator-review.md']]) {
      const r = await cli(dir, 'x\n', command, 'p', 'ABC-5', variation, name);
      assert.equal(r.code, 1, `${command} ${variation} ${name}`);
      assert.match(r.stderr, new RegExp(`${command}: .* is the harness's own: not written`), `${command} ${variation} ${name}`);
    }
  }
  assert.deepEqual(readdirSync(folder), []);
});
