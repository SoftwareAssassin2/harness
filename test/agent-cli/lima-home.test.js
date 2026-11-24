// lima_home (lima-home.bash, ASS-273): the folder every Lima VM lives in, for
// every bash command that runs limactl or reads a VM's files — LIMA_HOME,
// else the untracked harness.local.json's lima-home (ASS-281:
// HARNESS_LOCAL_FILE, else beside the harness.json in use), else
// harness.json's (HARNESS_FILE, or the file given), else ~/.lima. Sourcing vm.bash or golden.bash exports LIMA_HOME so resolved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', '..', 'src', 'agent-cli');
const harness = (json, name = 'harness.json') => {
  const file = join(mkdtempSync(join(tmpdir(), 'lima-home-')), name);
  writeFileSync(file, JSON.stringify(json));
  return file;
};
const base = () => { const env = { ...process.env, HOME: '/home/me' }; delete env.LIMA_HOME; return env; };
const ask = (helper, script, env) => run('bash', ['-c', `source "${join(CLI, helper)}" && ${script}`], { env }).then(r => r.stdout);

test('lima_home: LIMA_HOME wins; else harness.json\'s lima-home; else ~/.lima', async () => {
  const file = harness({ 'lima-home': '/vms' });
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), LIMA_HOME: '/env', HARNESS_FILE: file }), '/env\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: file }), '/vms\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: harness({}) }), '/home/me/.lima\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: join(tmpdir(), 'no-such-harness.json') }), '/home/me/.lima\n');
  assert.equal(await ask('lima-home.bash', `lima_home_default "${file}"`, { ...base(), HARNESS_FILE: harness({}) }), '/vms\n');   // a harness.json named outright (move-data)
});

test('lima_home: harness.local.json\'s lima-home comes between LIMA_HOME and harness.json\'s (ASS-281)', async () => {
  const file = harness({ 'lima-home': '/vms' });
  const local = harness({ 'lima-home': '/local' }, 'harness.local.json');
  const none = join(tmpdir(), 'no-such-harness.local.json');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), LIMA_HOME: '/env', HARNESS_FILE: file, HARNESS_LOCAL_FILE: local }), '/env\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: file, HARNESS_LOCAL_FILE: local }), '/local\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: harness({}), HARNESS_LOCAL_FILE: local }), '/local\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: file, HARNESS_LOCAL_FILE: harness({}, 'harness.local.json') }), '/vms\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: file, HARNESS_LOCAL_FILE: none }), '/vms\n');
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: harness({}), HARNESS_LOCAL_FILE: none }), '/home/me/.lima\n');
});

test('lima_home: without HARNESS_LOCAL_FILE, harness.local.json is the one beside the harness.json in use, or beside the one named (ASS-281)', async () => {
  const file = harness({ 'lima-home': '/vms' });
  writeFileSync(join(file, '..', 'harness.local.json'), JSON.stringify({ 'lima-home': '/local' }));
  assert.equal(await ask('lima-home.bash', 'lima_home', { ...base(), HARNESS_FILE: file }), '/local\n');
  assert.equal(await ask('lima-home.bash', `lima_home_default "${file}"`, { ...base(), HARNESS_FILE: harness({}) }), '/local\n');
});

test('vm.bash and golden.bash export LIMA_HOME so resolved, for every limactl they run', async () => {
  const file = harness({ 'lima-home': '/vms' });
  for (const helper of ['vm.bash', join('vm', 'golden.bash')]) {
    assert.equal(await ask(helper, 'bash -c \'echo "$LIMA_HOME"\'', { ...base(), HARNESS_FILE: file }), '/vms\n', helper);
    assert.equal(await ask(helper, 'bash -c \'echo "$LIMA_HOME"\'', { ...base(), HARNESS_FILE: harness({}) }), '/home/me/.lima\n', helper);
    assert.equal(await ask(helper, 'bash -c \'echo "$LIMA_HOME"\'', { ...base(), LIMA_HOME: '/env', HARNESS_FILE: file }), '/env\n', helper);
  }
});

// ASS-578: a project's own Lima folder, project.json's lima-home.
const projectsWith = homes => {
  const dir = mkdtempSync(join(tmpdir(), 'lima-projects-'));
  for (const [id, home] of Object.entries(homes)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'project.json'), JSON.stringify(home === undefined ? { name: id } : { name: id, 'lima-home': home }));
  }
  return dir;
};

test('ASS-578: lima_home <project> is its project.json lima-home, else the harness-wide folder; lima_homes lists every folder in use once', async () => {
  const own = mkdtempSync(join(tmpdir(), 'own-lima-'));
  const env = { ...base(), LIMA_HOME: '/env', HARNESS_FILE: harness({}), PROJECTS_DIR: projectsWith({ a: own, b: undefined, c: `${own}/`, d: 'relative/lima' }) };
  assert.equal(await ask('lima-home.bash', 'lima_home a', env), `${own}\n`);
  assert.equal(await ask('lima-home.bash', 'lima_home b', env), '/env\n');
  assert.equal(await ask('lima-home.bash', 'lima_home c', env), `${own}\n`, 'a trailing slash dropped');
  await assert.rejects(ask('lima-home.bash', 'lima_home d', env), /not an absolute path/);
  assert.equal(await ask('lima-home.bash', 'lima_homes', env), `/env\n${own}\n`, 'the harness-wide one first, then each own one once; a relative one never');
  // No project: LIMA_HOME as before (ASS-273); HARNESS_LIMA_HOME, once a command made LIMA_HOME a project's, stays the harness-wide one.
  assert.equal(await ask('lima-home.bash', 'lima_home', env), '/env\n');
  assert.equal(await ask('lima-home.bash', 'lima_use a && echo "$LIMA_HOME $HARNESS_LIMA_HOME" && lima_home b', env), `${own} /env\n/env\n`);
});

test('ASS-578: a lima-home that is not writable (an unmounted disk\'s folder) is refused, naming it', async () => {
  const locked = mkdtempSync(join(tmpdir(), 'locked-'));
  chmodSync(locked, 0o555);
  const env = { ...base(), HARNESS_FILE: harness({}), PROJECTS_DIR: projectsWith({ a: join(locked, 'lima') }) };
  try {
    await assert.rejects(ask('lima-home.bash', 'lima_home a', env), /lima-home '.*\/lima' is not writable/);
    assert.match(await ask('lima-home.bash', 'lima_home_problem a || true', env), /not writable/);
  } finally { chmodSync(locked, 0o755); }
});

test('ASS-578: lima_vm_home finds the folder holding an instance, LIMA_HOME\'s first, else where a new one would go', async () => {
  const wide = mkdtempSync(join(tmpdir(), 'wide-lima-')), own = mkdtempSync(join(tmpdir(), 'own-lima-'));
  mkdirSync(join(wide, 'abc-1-a')); mkdirSync(join(own, 'golden-a')); mkdirSync(join(own, 'abc-2-a'));
  const env = { ...base(), LIMA_HOME: wide, HARNESS_FILE: harness({}), PROJECTS_DIR: projectsWith({ a: own, b: undefined }) };
  assert.equal(await ask('lima-home.bash', 'lima_vm_home abc-1-a', env), `${wide}\n`);
  assert.equal(await ask('lima-home.bash', 'lima_vm_home golden-a', env), `${own}\n`);
  assert.equal(await ask('lima-home.bash', 'lima_vm_home abc-2-a', env), `${own}\n`);
  assert.equal(await ask('lima-home.bash', 'lima_vm_home abc-9-a', env), `${wide}\n`);
});
