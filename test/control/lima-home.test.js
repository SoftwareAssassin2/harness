// The folder every Lima VM lives in is a setting (ASS-273): the LIMA_HOME env
// var, else the untracked harness.local.json's lima-home (ASS-281:
// HARNESS_LOCAL_FILE, else beside the harness.json in use), else
// harness.json's (HARNESS_FILE, else data/harness.json), else ~/.lima, Lima's
// own default — in JS (vm.js limaHome, limaEnv) as in bash
// (agent-cli/lima-home.bash). No source names a machine's own volume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limaHome, limaEnv } from '../../src/control/vm.js';

const ROOT = join(import.meta.dirname, '..', '..');
const harness = (json, name = 'harness.json') => {
  const file = join(mkdtempSync(join(tmpdir(), 'lima-home-')), name);
  writeFileSync(file, JSON.stringify(json));
  return file;
};
const none = join(tmpdir(), 'no-such-harness.local.json');

test('limaHome: LIMA_HOME wins; else harness.json\'s lima-home; else ~/.lima', () => {
  const file = harness({ 'lima-home': '/vms' });
  assert.equal(limaHome({ LIMA_HOME: '/env', HARNESS_FILE: file, HOME: '/home/me' }), '/env');
  assert.equal(limaHome({ HARNESS_FILE: file, HOME: '/home/me' }), '/vms');
  assert.equal(limaHome({ HARNESS_FILE: harness({}), HOME: '/home/me' }), '/home/me/.lima');
  assert.equal(limaHome({ HARNESS_FILE: join(tmpdir(), 'no-such-harness.json'), HOME: '/home/me' }), '/home/me/.lima');
});

test('limaHome: harness.local.json\'s lima-home comes between LIMA_HOME and harness.json\'s (ASS-281)', () => {
  const file = harness({ 'lima-home': '/vms' });
  const local = harness({ 'lima-home': '/local' }, 'harness.local.json');
  assert.equal(limaHome({ LIMA_HOME: '/env', HARNESS_FILE: file, HARNESS_LOCAL_FILE: local, HOME: '/home/me' }), '/env');
  assert.equal(limaHome({ HARNESS_FILE: file, HARNESS_LOCAL_FILE: local, HOME: '/home/me' }), '/local');
  assert.equal(limaHome({ HARNESS_FILE: harness({}), HARNESS_LOCAL_FILE: local, HOME: '/home/me' }), '/local');
  assert.equal(limaHome({ HARNESS_FILE: file, HARNESS_LOCAL_FILE: harness({}, 'harness.local.json'), HOME: '/home/me' }), '/vms');
  assert.equal(limaHome({ HARNESS_FILE: file, HARNESS_LOCAL_FILE: none, HOME: '/home/me' }), '/vms');
  assert.equal(limaHome({ HARNESS_FILE: harness({}), HARNESS_LOCAL_FILE: none, HOME: '/home/me' }), '/home/me/.lima');
});

test('limaHome: without HARNESS_LOCAL_FILE, harness.local.json is the one beside the harness.json in use (ASS-281)', () => {
  const file = harness({ 'lima-home': '/vms' });
  writeFileSync(join(file, '..', 'harness.local.json'), JSON.stringify({ 'lima-home': '/local' }));
  assert.equal(limaHome({ HARNESS_FILE: file, HOME: '/home/me' }), '/local');
});

test('limaEnv sets LIMA_HOME from the same resolution, and keeps one already set', () => {
  const file = harness({ 'lima-home': '/vms' });
  assert.equal(limaEnv({ HARNESS_FILE: file, HOME: '/home/me' }).LIMA_HOME, '/vms');
  assert.equal(limaEnv({ HARNESS_FILE: harness({}), HOME: '/home/me' }).LIMA_HOME, '/home/me/.lima');
  const env = { LIMA_HOME: '/env', HARNESS_FILE: file };
  assert.equal(limaEnv(env), env);
});

test('data/harness.local.json is gitignored, so a machine\'s own lima-home never shows as a change (ASS-281)', () => {
  assert.equal(execFileSync('git', ['-C', ROOT, 'check-ignore', 'data/harness.local.json'], { encoding: 'utf8' }), 'data/harness.local.json\n');
});

test('the tracked data/harness.json sets no lima-home (ASS-277): a fresh checkout\'s VMs go to ~/.lima, an operator\'s own folder is set in their copy or LIMA_HOME', () => {
  // As committed, not the operator's working copy, which may set their own.
  assert.equal(JSON.parse(execFileSync('git', ['-C', ROOT, 'show', 'HEAD:data/harness.json'], { encoding: 'utf8' }))['lima-home'], undefined);
});

test('no source file names a /Volumes/ folder: the Lima folder is never defaulted to one', () => {
  let hits = '';
  try { hits = execFileSync('git', ['-C', ROOT, 'grep', '-nE', '/Volumes/[A-Za-z]', '--', 'src'], { encoding: 'utf8' }); } catch (e) { if (e.status !== 1) throw e; }
  assert.equal(hits, '');
});
