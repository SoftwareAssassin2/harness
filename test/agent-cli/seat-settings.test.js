// ASS-546: the seat-budget settings' commands — project:set-share (AC1), machine:set-limits (AC2),
// project:set-ticket-isolation (AC3), harness:set-budget (AC4) — each validating before it writes, writing nothing
// on bad input, holding the lock the file's other writers take (update_json's "<file>.lock") from its read to its
// write, writing the file whole (temp + rename), printing what changed, and listed by --help (AC5). Run on fixture
// copies (PROJECTS_DIR, HARNESS_FILE), never the live data folder (AC7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devEnvironmentsErrors, isolationOf, devEnvironments } from '../../src/control/dev-environments.js';
import { resolveShares } from '../../src/control/seat-budget.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const json = file => JSON.parse(readFileSync(file, 'utf8'));

const WS = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' };
const VM = { id: 'vm-1', 'gcp-project': 'g', zone: 'z', 'max-cpu-percent': 80 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'seat-settings-'));
  const projects = join(dir, 'projects'), harness = join(dir, 'harness.json');
  const bodies = {
    alpha: { name: 'Alpha', 'dev-environments': { mode: 'vm+workstation', workstations: [WS], 'cloud-vms': [VM] } },
    beta: { name: 'Beta', share: 40 },
    gamma: { name: 'Gamma', share: 30 },
  };
  for (const [id, body] of Object.entries(bodies)) {
    mkdirSync(join(projects, id), { recursive: true });
    writeFileSync(join(projects, id, 'project.json'), JSON.stringify(body, null, 4));
  }
  writeFileSync(harness, JSON.stringify({ 'max-agents': 8, 'max-memory-percent': 90 }, null, 4));
  const env = extra => ({ env: { ...process.env, PROJECTS_DIR: projects, HARNESS_FILE: harness, ...extra } });
  return {
    dir, projects, harness,
    file: id => join(projects, id, 'project.json'),
    project: id => json(join(projects, id, 'project.json')),
    agent: (args, extra) => run(AGENT, args, env(extra)),
    agentChild: (args, extra) => execFile(AGENT, args, env(extra)),
  };
}

// Every file in the fixture, byte for byte: a refused command writes nothing anywhere.
const snapshot = dir => {
  const out = {};
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.endsWith('.lock')) out[p] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};
async function refuses(f, args, pattern) {
  const before = snapshot(f.dir);
  await assert.rejects(f.agent(args), pattern);
  assert.deepEqual(snapshot(f.dir), before, `${args.join(' ')} wrote nothing`);
}

// Holds <file>.lock from another process (as update_json's writers take it) until released or the test ends.
function holdLock(t, file) {
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${file}.lock`]);
  t.after(() => holder.kill('SIGKILL'));
  return new Promise(resolve => holder.stdout.once('data', () => resolve(holder)));
}
const pending = (promise, ms = 500) => Promise.race([promise.then(() => false, () => false), new Promise(r => setTimeout(r, ms, true))]);
const exited = child => new Promise((resolve, reject) => {
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.on('exit', code => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`exit ${code}: ${stderr}`))));
});

test('ASS-546 AC1: project:set-share sets, changes and removes a share, printing the change and the set shares\' total; control reads it', async () => {
  const f = fixture();
  const set = await f.agent(['project:set-share', 'alpha', '20']);
  assert.equal(set.stdout.trim(), 'alpha: share unset → 20 (set shares add up to 90: alpha 20, beta 40, gamma 30)');
  assert.equal(f.project('alpha').share, 20);
  assert.equal((await f.agent(['project:set-share', 'alpha', '12.5'])).stdout.trim(), 'alpha: share 20 → 12.5 (set shares add up to 82.5: alpha 12.5, beta 40, gamma 30)');
  assert.equal((await f.agent(['project:set-share', 'beta', '0'])).stdout.trim(), 'beta: share 40 → 0 (set shares add up to 42.5: alpha 12.5, beta 0, gamma 30)');
  const { shares } = resolveShares(['alpha', 'beta', 'gamma'].map(id => ({ id, share: f.project(id).share })));
  assert.deepEqual([...shares.values()], [12.5, 0, 30]);
  const none = await f.agent(['project:set-share', 'alpha', 'none']);
  assert.equal(none.stdout.trim(), 'alpha: share 12.5 → unset (set shares add up to 30: beta 0, gamma 30)');
  assert.equal('share' in f.project('alpha'), false);
  assert.equal(f.project('alpha')['dev-environments'].workstations[0].id, 'ws-1');   // the rest kept
  // up to 100 exactly is allowed
  await f.agent(['project:set-share', 'alpha', '70']);
  assert.equal(f.project('alpha').share, 70);
});

test('ASS-546 AC1: project:set-share refuses a sum over 100 naming the projects, a value out of 0–100 or not a number, and an unknown project, writing nothing', async () => {
  const f = fixture();
  await refuses(f, ['project:set-share', 'alpha', '31'], /alpha's share 31 would make the projects' set shares add up to 101, over 100: alpha 31, beta 40, gamma 30; nothing written/);
  await refuses(f, ['project:set-share', 'beta', '71'], /add up to 101, over 100: beta 71, gamma 30/);
  for (const bad of ['101', '-1', 'abc', '', '05', '1e2', '50%']) await refuses(f, ['project:set-share', 'alpha', bad], /the share must be a percentage from 0 to 100/);
  await refuses(f, ['project:set-share', 'nope', '10'], /invalid project 'nope'/);
  await refuses(f, ['project:set-share', '../beta', '10'], /invalid project/);
  await refuses(f, ['project:set-share', 'alpha'], /usage: project:set-share <project> <percent\|none>/);
  // a share control ignores (not a number from 0 to 100) is not counted
  writeFileSync(f.file('gamma'), JSON.stringify({ share: 'lots' }));
  await f.agent(['project:set-share', 'alpha', '60']);
  assert.equal(f.project('alpha').share, 60);
});

test('ASS-546 AC2: machine:set-limits sets and clears a workstation\'s and a cloud VM\'s limits, printing each change; dev-environments still valid', async () => {
  const f = fixture();
  const ws = await f.agent(['machine:set-limits', 'alpha', 'ws-1', '--memory', '60', '--cpu', '75']);
  assert.equal(ws.stdout.trim(), 'alpha: workstation ws-1: max-memory-percent unset → 60, max-cpu-percent unset → 75');
  assert.deepEqual(f.project('alpha')['dev-environments'].workstations[0], { ...WS, 'max-memory-percent': 60, 'max-cpu-percent': 75 });
  const vm = await f.agent(['machine:set-limits', 'alpha', 'vm-1', '--memory', '100']);
  assert.equal(vm.stdout.trim(), 'alpha: cloud VM vm-1: max-memory-percent unset → 100');
  assert.deepEqual(f.project('alpha')['dev-environments']['cloud-vms'][0], { ...VM, 'max-memory-percent': 100 });
  const parsed = devEnvironments(f.project('alpha'));
  assert.deepEqual(parsed.workstations.map(w => [w['max-memory-percent'], w['max-cpu-percent']]), [[60, 75], [100, 80]]);
  // --clear with --cpu: only the CPU limit left; --clear alone: back on harness.json's
  assert.equal((await f.agent(['machine:set-limits', 'alpha', 'ws-1', '--clear', '--cpu', '50'])).stdout.trim(), 'alpha: workstation ws-1: max-memory-percent 60 → unset, max-cpu-percent 75 → 50');
  assert.equal((await f.agent(['machine:set-limits', 'alpha', 'vm-1', '--clear'])).stdout.trim(), 'alpha: cloud VM vm-1: max-memory-percent 100 → unset, max-cpu-percent 80 → unset');
  assert.deepEqual(f.project('alpha')['dev-environments']['cloud-vms'][0], { id: 'vm-1', 'gcp-project': 'g', zone: 'z' });
  assert.equal((await f.agent(['machine:set-limits', 'alpha', 'vm-1', '--clear'])).stdout.trim(), 'alpha: cloud VM vm-1: unchanged');
  assert.deepEqual(devEnvironmentsErrors(f.project('alpha')), []);
});

test('ASS-546 AC2: machine:set-limits refuses an unknown machine id (naming the project\'s), a value out of 1–100, a bad option, writing nothing', async () => {
  const f = fixture();
  await refuses(f, ['machine:set-limits', 'alpha', 'ws-9', '--cpu', '50'], /alpha has no workstation or cloud VM 'ws-9' \(it has: ws-1, vm-1\); nothing written/);
  await refuses(f, ['machine:set-limits', 'beta', 'ws-1', '--cpu', '50'], /beta has no workstation or cloud VM 'ws-1' \(it has: none\)/);
  for (const bad of ['0', '101', 'x', '-5', '']) await refuses(f, ['machine:set-limits', 'alpha', 'ws-1', '--memory', bad], /--memory must be a percentage from 1 to 100/);
  await refuses(f, ['machine:set-limits', 'alpha', 'ws-1', '--cpu', '50', '--memory', '200'], /--memory must be a percentage/);
  await refuses(f, ['machine:set-limits', 'alpha', 'ws-1'], /usage: machine:set-limits/);
  await refuses(f, ['machine:set-limits', 'alpha', 'ws-1', '--disk', '5'], /usage: machine:set-limits/);
  await refuses(f, ['machine:set-limits', 'alpha', 'ws-1', '--cpu'], /usage: machine:set-limits/);
  await refuses(f, ['machine:set-limits', 'nope', 'ws-1', '--cpu', '5'], /invalid project 'nope'/);
});

test('ASS-557 AC1: machine:set-limits sets and clears a machine\'s disk hold and warn levels (GB), refusing a bad value or a hold above the warn', async () => {
  const f = fixture();
  assert.equal((await f.agent(['machine:set-limits', 'alpha', 'ws-1', '--disk-hold', '5', '--disk-warn', '20'])).stdout.trim(), 'alpha: workstation ws-1: disk-free-hold-gb unset → 5, disk-free-warn-gb unset → 20');
  assert.deepEqual(devEnvironments(f.project('alpha')).workstations[0], { ...WS, 'disk-free-hold-gb': 5, 'disk-free-warn-gb': 20 });
  for (const bad of ['0', '-1', 'x', '']) await refuses(f, ['machine:set-limits', 'alpha', 'ws-1', '--disk-hold', bad], /--disk-hold must be a positive number of GB/);
  await refuses(f, ['machine:set-limits', 'alpha', 'ws-1', '--disk-hold', '30'], /disk-free-hold-gb would be above its disk-free-warn-gb; nothing written/);
  assert.equal(f.project('alpha')['dev-environments'].workstations[0]['disk-free-hold-gb'], 5, 'nothing written');
  assert.equal((await f.agent(['machine:set-limits', 'alpha', 'ws-1', '--clear'])).stdout.trim(), 'alpha: workstation ws-1: disk-free-hold-gb 5 → unset, disk-free-warn-gb 20 → unset');
  assert.deepEqual(devEnvironmentsErrors(f.project('alpha')), []);
});

test('ASS-546 AC3: project:set-ticket-isolation sets either value (making dev-environments where there is none), which control reads; anything else is refused', async () => {
  const f = fixture();
  assert.equal((await f.agent(['project:set-ticket-isolation', 'alpha', 'separate'])).stdout.trim(), 'alpha: ticket isolation one-at-a-time (default) → separate');
  assert.equal(isolationOf(devEnvironments(f.project('alpha'))), 'separate');
  assert.equal(f.project('alpha')['dev-environments'].mode, 'vm+workstation');   // the rest kept
  assert.equal((await f.agent(['project:set-ticket-isolation', 'alpha', 'one-at-a-time'])).stdout.trim(), 'alpha: ticket isolation separate → one-at-a-time');
  assert.equal(isolationOf(devEnvironments(f.project('alpha'))), 'one-at-a-time');
  await f.agent(['project:set-ticket-isolation', 'beta', 'separate']);
  assert.deepEqual(f.project('beta')['dev-environments'], { 'ticket-isolation': 'separate' });
  assert.deepEqual(devEnvironmentsErrors(f.project('beta')), []);
  await refuses(f, ['project:set-ticket-isolation', 'alpha', 'shared'], /the isolation must be one-at-a-time or separate, got 'shared'/);
  await refuses(f, ['project:set-ticket-isolation', 'nope', 'separate'], /invalid project 'nope'/);
  await refuses(f, ['project:set-ticket-isolation', 'alpha'], /usage: project:set-ticket-isolation/);
  writeFileSync(f.file('gamma'), JSON.stringify({ 'dev-environments': 'vm' }));
  await refuses(f, ['project:set-ticket-isolation', 'gamma', 'separate'], /gamma's dev-environments is not an object; nothing written/);
});

test('ASS-546 AC4: harness:set-budget sets the memory and CPU budget in harness.json, printing each change; bad input writes nothing', async () => {
  const f = fixture();
  assert.equal((await f.agent(['harness:set-budget', '--cpu', '70'])).stdout.trim(), 'harness budget: max-cpu-percent 90 (default) → 70');
  assert.equal((await f.agent(['harness:set-budget', '--memory', '85', '--cpu', '70'])).stdout.trim(), 'harness budget: max-memory-percent 90 → 85');
  assert.equal((await f.agent(['harness:set-budget', '--memory', '85'])).stdout.trim(), 'harness budget: unchanged');
  assert.deepEqual(json(f.harness), { 'max-agents': 8, 'max-memory-percent': 85, 'max-cpu-percent': 70 });
  for (const bad of ['0', '100.5', 'ninety', '']) await refuses(f, ['harness:set-budget', '--memory', bad], /--memory must be a percentage from 1 to 100/);
  await refuses(f, ['harness:set-budget'], /usage: harness:set-budget \[--memory <percent>\] \[--cpu <percent>\]/);
  await refuses(f, ['harness:set-budget', '--disk', '5'], /usage/);
  await refuses(f, ['harness:set-budget', '--memory', '50', '--cpu', '0'], /--cpu must be/);   // one bad value: neither written
  writeFileSync(f.harness, '{ not json');
  await refuses(f, ['harness:set-budget', '--cpu', '50'], /is not valid JSON; nothing written/);
});

test('ASS-546 AC5: each command writes its file whole through a temp file renamed over it, in update_json\'s format', async () => {
  const f = fixture();
  for (const [args, file] of [
    [['project:set-share', 'alpha', '10'], f.file('alpha')],
    [['machine:set-limits', 'alpha', 'ws-1', '--cpu', '50'], f.file('alpha')],
    [['project:set-ticket-isolation', 'alpha', 'separate'], f.file('alpha')],
    [['harness:set-budget', '--cpu', '50'], f.harness],
  ]) {
    const inode = statSync(file).ino;
    await f.agent(args);
    assert.notEqual(statSync(file).ino, inode, `${args[0]} renamed a new file over the old one`);
    assert.match(readFileSync(file, 'utf8'), /^\{\n {4}"/);
  }
  assert.deepEqual(readdirSync(join(f.projects, 'alpha')).toSorted(), ['project.json', 'project.json.lock']);   // no temp file left
});

test('ASS-546 AC5, AC7: with another writer holding the file\'s lock, each command waits and keeps that writer\'s change; timed out, it writes nothing', async t => {
  const f = fixture();
  for (const [args, file, check, later] of [
    [['project:set-share', 'alpha', '10'], f.file('alpha'), j => j.share === 10, ['project:set-share', 'alpha', '20']],
    [['machine:set-limits', 'alpha', 'vm-1', '--memory', '50'], f.file('alpha'), j => j['dev-environments']['cloud-vms'][0]['max-memory-percent'] === 50, ['machine:set-limits', 'alpha', 'vm-1', '--memory', '60']],
    [['project:set-ticket-isolation', 'alpha', 'separate'], f.file('alpha'), j => j['dev-environments']['ticket-isolation'] === 'separate', ['project:set-ticket-isolation', 'alpha', 'one-at-a-time']],
    [['harness:set-budget', '--memory', '75'], f.harness, j => j['max-memory-percent'] === 75, ['harness:set-budget', '--memory', '60']],
  ]) {
    const holder = await holdLock(t, file);
    const child = f.agentChild(args, { JSON_LOCK_TIMEOUT: '600' });
    const done = exited(child);
    assert.equal(await pending(done), true, `${args[0]} waits for the lock`);
    // the other writer's change, made while it holds the lock
    writeFileSync(file, JSON.stringify({ ...json(file), 'other-writer': args[0] }, null, 4));
    holder.kill('SIGKILL');
    await done;
    const after = json(file);
    assert.equal(after['other-writer'], args[0], `${args[0]} kept the other writer's change`);
    assert.ok(check(after), `${args[0]} made its own change`);

    const again = await holdLock(t, file);
    const before = readFileSync(file, 'utf8');
    await assert.rejects(f.agent(later, { JSON_LOCK_TIMEOUT: '1' }), /timed out/);
    assert.equal(readFileSync(file, 'utf8'), before, `${args[0]} timed out wrote nothing`);
    again.kill('SIGKILL');
  }
});

test('ASS-546 AC5: --help lists the four commands with their usage', async () => {
  const { stdout } = await run(AGENT, ['--help']);
  for (const usage of [
    /project:set-share .*project:set-share <project> <percent\|none>/,
    /machine:set-limits .*machine:set-limits <project> <machine-id> \[--memory <percent>\] \[--cpu <percent>\] \[--disk-hold <gb>\] \[--disk-warn <gb>\] \[--clear\]/,   // ASS-557: the disk levels
    /project:set-ticket-isolation .*project:set-ticket-isolation <project> one-at-a-time\|separate/,
    /harness:set-budget .*harness:set-budget \[--memory <percent>\] \[--cpu <percent>\]/,
  ]) assert.match(stdout, usage);
});
