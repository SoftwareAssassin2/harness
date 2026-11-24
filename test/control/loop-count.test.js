// ASS-526: the loops control has finished since it started
// (src/control/loop-count.js), written after every loop for the dashboard's
// bottom-right counter: 0 at start, one more per loop, a throwing loop too,
// 99 on to 100 (the dashboard shows 0), 0 again after a restart, a failed
// write logged once per streak; and control itself (main.js) writing it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loopCounter, loopCountFile, LOOP_COUNT_FILE } from '../../src/control/loop-count.js';
import { controlFixture } from './control-fixture.js';
import { until, within } from '../support/until.js';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'loop-count-')), LOOP_COUNT_FILE);

test('ASS-526 AC2, AC7: 0 is written at the start, then one more after each finished loop; past 99 the whole count is kept (100), which the dashboard shows as 0', () => {
  const file = tmpFile();
  const c = loopCounter({ file, pid: 4242, now: () => new Date('2026-11-22T01:00:00Z') });
  assert.deepEqual(read(file), { 'control-pid': 4242, started: '2026-11-22T01:00:00.000Z', loops: 0 });
  c.finished();
  assert.equal(read(file).loops, 1);
  for (let i = 1; i < 99; i++) c.finished();
  assert.equal(read(file).loops, 99);
  c.finished();
  assert.equal(read(file).loops, 100);
  assert.equal(c.loops(), 100);
  assert.deepEqual(readdirSync(join(file, '..')), [LOOP_COUNT_FILE]);   // written by rename: no temporary file left
});

test('ASS-526 AC4, AC7: a new counter on the same file (a restarted control) starts again at 0', () => {
  const file = tmpFile();
  const first = loopCounter({ file, pid: 1 });
  for (let i = 0; i < 7; i++) first.finished();
  assert.equal(read(file).loops, 7);
  loopCounter({ file, pid: 2 });
  assert.deepEqual([read(file).loops, read(file)['control-pid']], [0, 2]);
});

test('ASS-526: a write that fails is logged once per streak and never throws; the count goes on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-count-'));
  const said = [];
  const c = loopCounter({ file: join(dir, 'gone', LOOP_COUNT_FILE), log: (phase, text) => said.push(`${phase} ${text}`) });
  c.finished(); c.finished();
  assert.equal(said.length, 1);
  assert.match(said[0], /^error loop-count: .*gone\/loop-count\.json: ENOENT.*; the loop goes on/);
  assert.equal(c.loops(), 2);
});

test('ASS-526: loopCountFile is the project\'s folder, or HARNESS_HOME without a project', () => {
  assert.equal(loopCountFile({ paths: { projects: '/d/projects' }, home: '/h', project: 'acme-shop' }), '/d/projects/acme-shop/loop-count.json');
  assert.equal(loopCountFile({ paths: { projects: '/d/projects' }, home: '/h', project: null }), '/h/loop-count.json');
});

// Control as the supervisor runs it (as tick-stats.test.js runs it): max-agents 0, its own HARNESS_HOME.
const MAIN = join(import.meta.dirname, '..', '..', 'src', 'control', 'main.js');
const children = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });
function processFixture() {
  const f = controlFixture();
  writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...f.harness(), 'max-agents': 0 }));
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  return { ...f, home, env: { ...f.env, HARNESS_HOME: home } };
}
function run(f, args, env = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...f.env, CONTROL_TEST_TICK_LINES: '1', ...env } });
  children.push(child);
  const lines = [];
  createInterface({ input: child.stdout }).on('line', line => lines.push(line));
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, lines, exit };
}
const ticksIn = lines => lines.filter(l => / test tick ran$/.test(l)).length;

test('ASS-526 AC1, AC3, AC7: control --project writes its finished loops to data/projects/<project>/loop-count.json: 1 after --once', async () => {
  const f = processFixture();
  const control = run(f, ['--once', '--project', 'p', '--tick-ms', '50']);
  assert.deepEqual(await within(control.exit), { code: 0, signal: null });
  const s = read(join(f.dir, 'projects', 'p', LOOP_COUNT_FILE));
  assert.deepEqual([s.loops, s['control-pid']], [1, control.child.pid]);
  assert.ok(!existsSync(join(f.home, LOOP_COUNT_FILE)));
});

test('ASS-526 AC3, AC4, AC7: every loop counts, the two that throw too, the file matching each loop as it ends; a restarted control starts at 0', async () => {
  const f = processFixture();
  const file = join(f.home, LOOP_COUNT_FILE);
  const control = run(f, ['--tick-ms', '50'], { CONTROL_TEST_FAULT: 'tick' });
  try {
    assert.ok(await until(() => existsSync(file)), control.lines.join('\n'));
    assert.ok(await until(() => ticksIn(control.lines) >= 4), control.lines.join('\n'));
    control.child.stdin.end();
    assert.deepEqual(await within(control.exit), { code: 0, signal: null });
    assert.equal(control.lines.filter(l => / error the tick failed, control goes on: /.test(l)).length, 2);
    assert.equal(read(file).loops, ticksIn(control.lines), control.lines.join('\n'));   // the thrown ones counted
  } finally { control.child.kill('SIGKILL'); }
  // Started again, it writes 0 before its first loop ends: seen while that first loop is still to finish.
  const again = run(f, ['--tick-ms', '50']);
  try {
    assert.ok(await until(() => existsSync(file) && read(file)['control-pid'] === again.child.pid), again.lines.join('\n'));
    const first = read(file).loops;
    assert.ok(first <= ticksIn(again.lines) + 1 && first < 3, `${first}`);
    again.child.stdin.end();
    assert.deepEqual(await within(again.exit), { code: 0, signal: null });
    assert.equal(read(file).loops, ticksIn(again.lines));
  } finally { again.child.kill('SIGKILL'); }
});
