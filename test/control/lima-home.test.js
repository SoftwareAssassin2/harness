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

// ASS-578: a project's own Lima folder (project.json lima-home).
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { limaHomes, projectLimaHome, vmLimaHome, limaHomeProblem, limaFor } from '../../src/control/machine-lima.js';
import { matchInstances } from '../../src/control/host-memory.js';
import { checkLimaHomes } from '../../src/control/lima-home-check.js';
import { loadGolden, dataFiles } from '../../src/tui/load.js';

const projectsWith = homes => {
  const dir = mkdtempSync(join(tmpdir(), 'lima-projects-'));
  for (const [id, home] of Object.entries(homes)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'project.json'), JSON.stringify(home === undefined ? { name: id } : { name: id, 'lima-home': home }));
  }
  return dir;
};

test('ASS-578: projectLimaHome is a project\'s lima-home, else the harness-wide folder; limaHomes every folder in use, the harness-wide first', () => {
  const own = realpathSync(mkdtempSync(join(tmpdir(), 'own-lima-')));
  const env = { LIMA_HOME: '/env', HARNESS_FILE: harness({}), PROJECTS_DIR: projectsWith({ a: own, b: undefined, c: `${own}/`, d: 'relative' }) };
  assert.equal(projectLimaHome('a', env), own);
  assert.equal(projectLimaHome('b', env), '/env');
  assert.equal(projectLimaHome('d', env), '/env', 'one that can\'t be used: the harness-wide folder (control logs it; the bash commands refuse it)');
  assert.deepEqual(limaHomes(env), ['/env', own]);
  // HARNESS_LIMA_HOME (lima-home.bash's, beside a project's LIMA_HOME) is the harness-wide one.
  assert.deepEqual(limaHomes({ ...env, HARNESS_LIMA_HOME: '/wide', LIMA_HOME: own }), ['/wide', own]);
});

test('ASS-578: vmLimaHome is the folder holding the instance (limaFor sets it as LIMA_HOME, per call); one nowhere goes harness-wide', () => {
  const wide = realpathSync(mkdtempSync(join(tmpdir(), 'wide-'))), own = realpathSync(mkdtempSync(join(tmpdir(), 'own-')));
  mkdirSync(join(wide, 'abc-1-a')); mkdirSync(join(own, 'abc-2-a'));
  const env = { LIMA_HOME: wide, HARNESS_FILE: harness({}), PROJECTS_DIR: projectsWith({ a: own }) };
  assert.equal(vmLimaHome('abc-1-a', env), wide);
  assert.equal(vmLimaHome('abc-2-a', env), own);
  assert.equal(vmLimaHome('abc-9-a', env), wide);
  assert.equal(limaFor('abc-2-a', env).LIMA_HOME, own);
});

test('ASS-578 AC2: the memory and CPU readings match VM processes to instances in every Lima folder in use', () => {
  const lsof = ['p101', 'n/wide/abc-1-a/disk', 'p102', 'n/big-disk/lima/golden-x/disk', 'p103', 'n/elsewhere/x/disk'].join('\n');
  const procs = new Map([[101, 1], [102, 2], [103, 3]]);
  assert.deepEqual([...matchInstances(lsof, ['/wide', '/big-disk/lima/'], procs)], [['abc-1-a', 1], ['golden-x', 2]]);
  assert.deepEqual([...matchInstances(lsof, '/wide', procs)], [['abc-1-a', 1]], 'one folder, as before');
});

test('ASS-578: control names a lima-home that is not an absolute path or not writable in its log, once, and when it is fixed', () => {
  const locked = mkdtempSync(join(tmpdir(), 'locked-'));
  chmodSync(locked, 0o555);
  try {
    assert.match(limaHomeProblem('relative/lima'), /not an absolute path/);
    assert.match(limaHomeProblem(join(locked, 'lima')), /not writable/);
    assert.equal(limaHomeProblem(join(tmpdir(), 'not-yet', 'lima')), null, 'not there yet but makeable: fine');
    assert.equal(limaHomeProblem(undefined), null);
    const logs = [], ctx = { memory: {}, log: (phase, text) => logs.push(`${phase}: ${text}`) };
    const state = home => ({ projects: [{ id: 'p', json: home === undefined ? {} : { 'lima-home': home } }] });
    checkLimaHomes(ctx, state('relative/lima'));
    checkLimaHomes(ctx, state('relative/lima'));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^lima-home: p: project\.json lima-home "relative\/lima" is not an absolute path/);
    checkLimaHomes(ctx, state(join(locked, 'lima')));
    assert.match(logs[1], /not writable/);
    checkLimaHomes(ctx, state(undefined));
    assert.match(logs[2], /^lima-home: p: project\.json lima-home unset/);
    checkLimaHomes(ctx, state(undefined));
    assert.equal(logs.length, 3);
  } finally { chmodSync(locked, 0o755); }
});

test('ASS-578: the dashboard reads a project\'s golden image from its own Lima folder, and watches it there', () => {
  const wide = mkdtempSync(join(tmpdir(), 'wide-')), own = mkdtempSync(join(tmpdir(), 'own-'));
  mkdirSync(join(own, 'golden-p'));
  writeFileSync(join(own, 'golden-p', 'golden-image.json'), JSON.stringify({ 'built-at': '2026-11-24T00:00:00Z' }));
  const golden = loadGolden('p', { 'golden-image': {}, 'lima-home': own }, wide);
  assert.deepEqual(golden, { name: 'golden-p', 'built-at': '2026-11-24T00:00:00Z', home: own });
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  assert.ok(dataFiles(root, { projects: [{ id: 'p', golden }], workflows: [], project: 0, day: null }, wide).includes(join(own, 'golden-p')));
});
