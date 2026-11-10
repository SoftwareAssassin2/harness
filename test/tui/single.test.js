// One dashboard at a time (ASS-338): the real src/tui/main.js in a
// pseudo-terminal (test/support/pty.js), with a HOME and HARNESS_HOME of the
// test's own, so it never sees a real running harness. A second dashboard
// finds the first's run-tui.pid and stops dead: the red, centred message,
// nothing started, no key but Ctrl-C.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inPty } from '../support/pty.js';
import { refusal, MESSAGE } from '../../src/tui/single.js';

const MAIN = join(import.meta.dirname, '..', '..', 'src', 'tui', 'main.js');
const RED = '\x1b[31m';

// A HOME of its own, its HARNESS_HOME inside it.
function home() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tui-single-')));
  const harness = join(dir, '.harness');
  return { dir, harness, env: { ...process.env, HOME: dir, HARNESS_HOME: harness } };
}
// Every file under `dir`, relative to it.
const files = (dir, at = '') => readdirSync(join(dir, at), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(dir, join(at, e.name)) : [join(at, e.name)]).sort();

// A live process that ps shows running a tui/main.js: the "other dashboard" holding the claim.
const holders = [];
after(() => { for (const h of holders) h.kill('SIGKILL'); });
function holder() {
  const dir = mkdtempSync(join(tmpdir(), 'tui-holder-'));
  mkdirSync(join(dir, 'tui'));
  writeFileSync(join(dir, 'tui', 'main.js'), 'setTimeout(() => {}, 600000);');
  const child = spawn(process.execPath, [join(dir, 'tui', 'main.js')], { stdio: 'ignore' });
  holders.push(child);
  return child.pid;
}

test('ASS-338 AC2: refusal(columns, rows) clears the screen and draws the message in red, centred both ways', () => {
  assert.equal(MESSAGE, 'The harness is running in another process. Only one harness can run at a time.');
  assert.equal(refusal(100, 30), `\x1b[2J\x1b[15;12H${RED}${MESSAGE}\x1b[0m`);
  assert.equal(refusal(78, 1), `\x1b[2J\x1b[1;1H${RED}${MESSAGE}\x1b[0m`);
});

test('ASS-338 AC2: narrower than the message, it is wrapped at spaces, each line centred, the lines centred together', () => {
  assert.equal(refusal(50, 10), `\x1b[2J`
    + `\x1b[5;5H${RED}The harness is running in another process.\x1b[0m`
    + `\x1b[6;8H${RED}Only one harness can run at a time.\x1b[0m`);
});

test('ASS-338 AC2: with a live claim held by another dashboard, the dashboard shows only the red centred message, starts nothing, ignores every key but Ctrl-C, and Ctrl-C ends it non-zero (not 75)', async () => {
  const h = home();
  mkdirSync(h.harness);
  const other = holder();
  writeFileSync(join(h.harness, 'run-tui.pid'), `${other}\n`);
  const r = await inPty({
    argv: [process.execPath, MAIN], env: h.env, cols: 100, rows: 30,
    steps: [
      { wait: 1500 }, { mark: 'shown' }, { children: 'shown' },
      ...['q', 'Q', '\r', '\x1b', '/', 'c', ' ', '!', '\x04', '\t'].map(send => ({ send })), { wait: 500 }, { mark: 'keys' },
      { resize: [120, 40] }, { wait: 500 }, { mark: 'resized' },
      { send: '\x03' },
    ],
  });
  assert.ok(r.marks.shown.includes(`\x1b[2J\x1b[15;12H${RED}${MESSAGE}\x1b[0m`), JSON.stringify(r.marks.shown));
  assert.doesNotMatch(r.marks.shown.replace(MESSAGE, ''), /[A-Za-z]{3,}/, 'nothing but the message is drawn');
  assert.deepEqual(r.children.shown, [], 'no control, downloader or chat started');
  assert.equal(r.marks.keys, r.marks.shown, 'the keys drew nothing');
  assert.ok(r.marks.resized.slice(r.marks.keys.length).includes(`\x1b[2J\x1b[20;22H${RED}${MESSAGE}\x1b[0m`), 're-centred on resize');
  assert.notEqual(r.status, null, 'Ctrl-C ended it');
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, 75);
  assert.ok(r.output.endsWith('\x1b[?25h\x1b[?1049l'), 'the terminal restored');
  // The claim is the other dashboard's still; nothing else written: no logs, no data.
  assert.equal(readFileSync(join(h.harness, 'run-tui.pid'), 'utf8'), `${other}\n`);
  assert.deepEqual(files(h.dir), ['.harness/run-tui.pid']);
});

// A checkout of the harness's code with no project (src, engines, prompts and
// harness.json copied; data/projects empty, no assignment), so a dashboard that does start
// runs no control and its downloader syncs nothing: never the real data.
function checkout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tui-root-')));
  const repo = join(import.meta.dirname, '..', '..');
  for (const dir of ['src', 'engines', 'prompts']) cpSync(join(repo, dir), join(root, dir), { recursive: true });
  mkdirSync(join(root, 'data', 'projects'), { recursive: true });
  cpSync(join(repo, 'data', 'harness.json'), join(root, 'data', 'harness.json'));
  writeFileSync(join(root, 'data', 'assignments.json'), JSON.stringify({ assignments: [] }));
  return join(root, 'src', 'tui', 'main.js');
}
// A pid no process has: a child's, once it has ended.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => child.once('close', resolve));
  return child.pid;
}

test('ASS-338 AC1/AC4: a single dashboard claims run-tui.pid with its pid, starts as today (its downloader running), and Q releases the claim', async () => {
  const h = home();
  const pidfile = join(h.harness, 'run-tui.pid');
  const r = await inPty({
    argv: [process.execPath, checkout()], env: h.env, timeout: 15000,
    steps: [{ wait: 2500 }, { file: 'running', path: pidfile }, { children: 'running' }, { send: 'Q' }],
  });
  assert.equal(r.files.running, `${r.pid}\n`);
  assert.equal(r.children.running.length, 1, 'the downloader');
  assert.equal(r.status, 0, r.output);
  assert.equal(existsSync(pidfile), false, 'released');
});

test('ASS-338 AC1: a claim whose process is gone, or is not a dashboard (its pid reused), is stale: the dashboard takes it over and starts', async () => {
  for (const stale of [await deadPid(), process.pid]) {
    const h = home();
    const pidfile = join(h.harness, 'run-tui.pid');
    mkdirSync(h.harness);
    writeFileSync(pidfile, `${stale}\n`);
    const r = await inPty({
      argv: [process.execPath, checkout()], env: h.env, timeout: 15000,
      steps: [{ wait: 2500 }, { file: 'running', path: pidfile }, { children: 'running' }, { send: 'Q' }],
    });
    assert.equal(r.files.running, `${r.pid}\n`, `stale ${stale}`);
    assert.equal(r.children.running.length, 1);
    assert.equal(r.status, 0, r.output);
    assert.equal(existsSync(pidfile), false);
  }
});
