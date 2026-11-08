// project:set-wait-for-dependencies (ASS-301): a project's wait-for-dependencies
// (ASS-195; absent is off) switched on or off: project.json's
// "wait-for-dependencies" set true or false under its lock, written atomically,
// the rest of the file as it was, the project and new value printed as JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const USAGE = /usage: project:set-wait-for-dependencies <project> <on\|off>/;

// A projects/ folder with project p, its project.json written as the tracked ones are.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'wfd-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'e', 'work-sources': [{ name: 'T', 'key-prefix': 'ABC' }], 'max-agents': 20 }, null, 4) + '\n');
  return dir;
}
const set = (dir, ...args) => run(AGENT, ['project:set-wait-for-dependencies', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const text = dir => readFileSync(join(dir, 'p', 'project.json'), 'utf8');
const withFlag = (before, value) => before.replace(/\n}\n$/, `,\n    "wait-for-dependencies": ${value}\n}\n`);
const printed = stdout => {
  assert.equal(stdout.trim().split('\n').length, 1, stdout);
  return JSON.parse(stdout);
};

test('ASS-301 AC1: on writes "wait-for-dependencies": true, nothing else, and prints the project and value as JSON', async () => {
  const dir = projects();
  const before = text(dir);
  assert.deepEqual(printed((await set(dir, 'p', 'on')).stdout), { project: 'p', 'wait-for-dependencies': true });
  assert.equal(text(dir), withFlag(before, true));
});

test('ASS-301 AC1: off, the field absent, writes "wait-for-dependencies": false, nothing else, and prints it as JSON', async () => {
  const dir = projects();
  const before = text(dir);
  assert.deepEqual(printed((await set(dir, 'p', 'off')).stdout), { project: 'p', 'wait-for-dependencies': false });
  assert.equal(text(dir), withFlag(before, false));
});

test('ASS-301 AC1: on then off flips the value in place — the key not duplicated, the rest as it was', async () => {
  const dir = projects();
  const before = text(dir);
  await set(dir, 'p', 'on');
  assert.deepEqual(printed((await set(dir, 'p', 'off')).stdout), { project: 'p', 'wait-for-dependencies': false });
  assert.equal(text(dir), withFlag(before, false));
});

test('ASS-301 AC1: a write leaves no temp file beside project.json (its lock file aside)', async () => {
  const dir = projects();
  await set(dir, 'p', 'on');
  assert.deepEqual(readdirSync(join(dir, 'p')).filter(n => n !== 'project.json' && n !== 'project.json.lock'), []);
});

test('ASS-301 AC4: a repeat of the same value succeeds, prints the same JSON and leaves the file as it was', async () => {
  for (const value of ['off', 'on']) {
    const dir = projects();
    const first = (await set(dir, 'p', value)).stdout;
    const after = text(dir);
    const second = (await set(dir, 'p', value)).stdout;
    assert.equal(second, first);
    assert.equal(text(dir), after);
  }
});

// Refused: non-zero exit, the usage line on stderr, nothing on stdout, project.json untouched.
async function refused(dir, args, message) {
  const before = text(dir);
  await assert.rejects(set(dir, ...args), e => {
    assert.notEqual(e.code, 0);
    assert.match(e.stderr, USAGE, `${JSON.stringify(args)}: ${e.stderr}`);
    if (message) assert.match(e.stderr, message, `${JSON.stringify(args)}: ${e.stderr}`);
    assert.equal(e.stdout.trim(), '', `${JSON.stringify(args)}: ${e.stdout}`);
    return true;
  });
  assert.equal(text(dir), before);
}

test('ASS-301 AC2: an unknown, path-traversing or empty project is refused with a usage message, project.json untouched', async () => {
  const dir = projects();
  await refused(dir, ['q', 'on'], /project:set-wait-for-dependencies: invalid project 'q'/);
  await refused(dir, ['../p', 'on'], /invalid project/);
  await refused(dir, ['', 'on']);
});

test('ASS-301 AC2: a value other than on or off is refused with a usage message, project.json untouched', async () => {
  const dir = projects();
  for (const value of ['false', 'true', 'ON', '']) {
    await refused(dir, ['p', value], new RegExp(`the value must be on or off, got '${value}'`));
  }
});

test('ASS-301 AC2: missing or extra arguments are refused with the usage message, project.json untouched', async () => {
  const dir = projects();
  for (const args of [['p'], [], ['p', 'on', 'x']]) await refused(dir, args);
});

test('ASS-301 AC3: agent.sh --help lists project:set-wait-for-dependencies with its usage, in the project: group', async () => {
  const lines = (await run(AGENT, ['--help'])).stdout.split('\n');
  const start = lines.indexOf('project:');
  assert.ok(start >= 0, 'no project: group');
  const next = lines.findIndex((l, i) => i > start && /^[a-z-]+:$/.test(l));
  const group = lines.slice(start + 1, next < 0 ? undefined : next);
  assert.ok(group.some(l => l.includes('project:set-wait-for-dependencies <project> <on|off>')), group.join('\n'));
});
