// ASS-540: the run-target commands — code:hand-over (a ticket's branch from where its last step ran to where its next
// runs: local-vm → local-worktree → local-vm with its work intact, the worktree made on first use, the workspace held
// by one ticket), code:remove-worktree, vm_of on a Mac target, project:set-run-targets and project:migrate-run-targets.
// Real git: a bare origin, the project's workspace cloned from it, and a fake Lima VM whose /repos/<repo> is a clone too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

// world() — the fixture's project p with a workspace cloned from a bare origin ("origin.git", so the VM's checkout is
// /repos/origin), ABC-3 A's VM a fake Lima instance whose /repos/origin is another clone on change/ABC-3.A-1.
function world() {
  const f = fixture(), vm = fakeVm();
  const dir = mkdtempSync(join(tmpdir(), 'rt-'));
  const origin = join(dir, 'origin.git'), ws = join(dir, 'workspace');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=master', origin]);
  execFileSync('git', ['clone', '--quiet', origin, ws], { stdio: 'ignore' });
  writeFileSync(join(ws, 'README.md'), 'hi\n');
  git(ws, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '.'); git(ws, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first'); git(ws, 'push', '-q', '-u', 'origin', 'master');
  git(ws, 'remote', 'set-head', 'origin', 'master');
  const inVm = join(vm.root, 'repos', 'origin');
  mkdirSync(join(vm.root, 'repos'), { recursive: true });
  execFileSync('git', ['clone', '--quiet', origin, inVm], { stdio: 'ignore' });
  git(inVm, 'checkout', '-q', '-b', 'change/ABC-3.A-1');
  vm.instance('abc-3-a', 'Running');
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: ws }] }));
  const env = { ...f.env, ...vm.env, ...IDENTITY };
  const agent = (...args) => run(AGENT, args, { env });
  return { ...f, vm, ws, origin, inVm, env, agent, project: () => JSON.parse(readFileSync(file, 'utf8')) };
}
const commit = (dir, name, text) => { writeFileSync(join(dir, name), text); execFileSync('git', ['-C', dir, 'add', name]); execFileSync('git', ['-C', dir, 'commit', '-q', '-m', `add ${name}`], { env: { ...process.env, ...IDENTITY } }); };

test('ASS-540 AC5, AC4: a ticket moving local-vm → local-worktree → local-vm has its branch committed by each and pulled by the next, its work intact; the worktree is made on first use and removed once done', async () => {
  const f = world();
  await f.agent('ticket:set-vm', 'p', 'ABC-3', 'A', 'abc-3-a', '');
  // Its first step on local-vm: committed in the VM, plus a file left uncommitted.
  commit(f.inVm, 'one.txt', 'from the VM\n');
  writeFileSync(join(f.inVm, 'loose.txt'), 'left over\n');
  const first = JSON.parse((await f.agent('code:hand-over', 'p', 'ABC-3', 'A', 'local-worktree')).stdout);
  // ASS-553 AC4: made from the harness's own clone (data/projects/p/checkouts/origin), never the operator's checkout.
  const clone = join(f.dir, 'projects', 'p', 'checkouts', 'origin'), folder = join(clone, '.worktrees', 'ABC-3');
  assert.deepEqual(first, { from: 'local-vm', to: 'local-worktree', branch: 'change/ABC-3.A-1', folder });
  assert.equal(readFileSync(join(folder, 'one.txt'), 'utf8'), 'from the VM\n');
  assert.equal(readFileSync(join(folder, 'loose.txt'), 'utf8'), 'left over\n');   // committed on the way, not lost
  assert.match(git(f.inVm, 'log', '-1', '--format=%s'), /^ABC-3: work left uncommitted on local-vm$/);
  let v = f.variation('A');
  assert.deepEqual([v['run-target'].target, v.build.branch, v.build['worktree-folder'], v.build['worktree-by']], ['local-worktree', 'change/ABC-3.A-1', folder, 'run-target']);
  // On local-worktree a step commits; back to local-vm the VM's checkout has it.
  commit(folder, 'two.txt', 'from the Mac\n');
  const back = JSON.parse((await f.agent('code:hand-over', 'p', 'ABC-3', 'A', 'local-vm')).stdout);
  assert.deepEqual(back, { from: 'local-worktree', to: 'local-vm', branch: 'change/ABC-3.A-1', folder: null });
  assert.equal(git(f.inVm, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3.A-1');
  for (const [name, text] of [['one.txt', 'from the VM\n'], ['loose.txt', 'left over\n'], ['two.txt', 'from the Mac\n']]) assert.equal(readFileSync(join(f.inVm, name), 'utf8'), text);
  assert.equal(f.variation('A')['run-target'].target, 'local-vm');
  // Done: the worktree local-worktree made goes, the branch stays.
  assert.deepEqual(JSON.parse((await f.agent('code:remove-worktree', 'p', 'ABC-3', 'A')).stdout), { removed: folder });
  assert.ok(!existsSync(folder));
  v = f.variation('A');
  assert.deepEqual([v.build['worktree-folder'], v.build['worktree-by'], git(clone, 'rev-parse', '--verify', 'change/ABC-3.A-1').length], [null, null, 40]);
  // ASS-553 AC4: the operator's checkout never got the branch nor a worktree.
  assert.equal(git(f.ws, 'branch', '--list', 'change/*'), '');
  assert.ok(!existsSync(join(f.ws, '.worktrees')));
});

test('ASS-540 AC4: local-workspace runs in the project\'s checkout, one ticket at a time per project; leaving it pushes the branch and gives the workspace back', async () => {
  const f = world();
  const out = JSON.parse((await f.agent('code:hand-over', 'p', 'ABC-3', 'A', 'local-workspace')).stdout);
  assert.deepEqual([out.to, out.branch, out.folder], ['local-workspace', 'change/ABC-3', f.ws]);
  assert.equal(git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3');
  assert.equal(f.project()['local-environments'][0]['active-branch'], 'change/ABC-3');
  // another ticket's variation may not take it meanwhile
  await assert.rejects(f.agent('code:hand-over', 'p', 'ABC-3', 'B', 'local-workspace'), e => /the workspace is held by change\/ABC-3/.test(e.stderr));
  commit(f.ws, 'w.txt', 'in the workspace\n');
  await f.agent('code:hand-over', 'p', 'ABC-3', 'A', 'local-worktree');
  assert.equal(git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master');   // given back
  assert.equal(f.project()['local-environments'][0]['active-branch'], undefined);
  const wt = join(realpathSync(join(f.dir, 'projects', 'p', 'checkouts', 'origin')), '.worktrees', 'ABC-3');   // ASS-553: the harness's own clone's
  assert.equal(readFileSync(join(wt, 'w.txt'), 'utf8'), 'in the workspace\n');
  assert.equal(git(f.origin, 'rev-parse', 'change/ABC-3'), git(wt, 'rev-parse', 'HEAD'));   // pushed
});

test('ASS-553 AC4: code:create-worktree keeps a recorded worktree made in the workspace; --harness-clone makes new ones in the clone, cloned once and fetched as needed', async () => {
  const f = world();
  const clone = join(f.dir, 'projects', 'p', 'checkouts', 'origin');
  // Variation A: a branch in the clone, then a worktree from it.
  const branch = JSON.parse((await f.agent('code:create-branch', 'p', 'ABC-3', 'A', '--harness-clone')).stdout);
  assert.deepEqual(branch, { branch: 'change/ABC-3', created: true });
  assert.ok(existsSync(join(clone, '.git')), 'cloned');
  assert.equal(git(f.ws, 'branch', '--list', 'change/*'), '', "the operator's checkout untouched");
  const made = JSON.parse((await f.agent('code:create-worktree', 'p', 'ABC-3', 'A', '--harness-clone')).stdout);
  assert.equal(realpathSync(made.folder), realpathSync(join(clone, '.worktrees', 'ABC-3')));
  // Cloned once: a commit on origin since is fetched into the same clone, not a new one.
  const head = git(clone, 'rev-parse', 'HEAD');
  commit(f.ws, 'later.txt', 'later\n'); git(f.ws, 'push', '-q', 'origin', 'master');
  await f.agent('code:hand-over', 'p', 'ABC-3', 'A', 'local-worktree');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), head, 'the clone itself is not re-made');
  assert.equal(git(clone, 'rev-parse', 'origin/master'), git(f.origin, 'rev-parse', 'master'), 'fetched');
  // Variation B: a worktree recorded in the workspace (made before the switch) is kept by code:create-worktree.
  git(f.ws, 'branch', 'change/ABC-3.B', 'master');
  const old = join(f.ws, '.worktrees', 'ABC-3.B');
  git(f.ws, 'worktree', 'add', '--quiet', old, 'change/ABC-3.B');
  const sprint = readdirSync(join(f.dir, 'projects', 'p', 'sprints')).map(d => join(f.dir, 'projects', 'p', 'sprints', d, 'sprint.json')).find(existsSync);
  const data = JSON.parse(readFileSync(sprint, 'utf8'));
  for (const t of [...(data.features ?? []), ...(data.bugs ?? []), ...(data.spikes ?? [])]) for (const v of t.variations ?? []) if (t.key === 'ABC-3' && v.name === 'B') v.build = { ...(v.build ?? {}), branch: 'change/ABC-3.B', worktree: 'ABC-3.B', 'worktree-folder': old };
  writeFileSync(sprint, JSON.stringify(data));
  const kept = JSON.parse((await f.agent('code:create-worktree', 'p', 'ABC-3', 'B', '--harness-clone')).stdout);
  assert.deepEqual([kept.folder, kept.created], [old, false]);
  const moved = JSON.parse((await f.agent('code:hand-over', 'p', 'ABC-3', 'B', 'local-worktree')).stdout);
  assert.equal(moved.folder, old, 'the old worktree goes on being used');
  assert.deepEqual(JSON.parse((await f.agent('code:remove-worktree', 'p', 'ABC-3', 'B')).stdout), { removed: old });
  assert.ok(!existsSync(old));
  assert.equal(git(f.ws, 'worktree', 'list').split('\n').length, 1, 'removed from the workspace it belonged to');
});

test('ASS-540 AC4: a command a step runs on a Mac run target finds no machine (vm_of), so it works on the Mac', async () => {
  const f = world();
  await f.agent('ticket:set-vm', 'p', 'ABC-3', 'A', 'abc-3-a', '');
  const code = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'code.bash');
  const ask = target => execFileSync('bash', ['-c', `source "${code}" && vm_of t p ABC-3 A`], { encoding: 'utf8', env: { ...f.env, ...(target ? { HARNESS_RUN_TARGET: target } : {}) } }).trim();
  assert.deepEqual([ask(), ask('local-vm'), ask('local-worktree'), ask('local-workspace')], ['abc-3-a', 'abc-3-a', '', '']);
});

test('ASS-540 AC8: project:set-run-targets validates and writes dev-environments.run-targets whole, the mode removed; a wrong list writes nothing', async () => {
  const f = fixture();
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'dev-environments': { mode: 'vm' } }));
  const agent = (...args) => run(AGENT, args, { env: f.env });
  assert.equal((await agent('project:set-run-targets', 'p', 'local-worktree', 'local-vm')).stdout, 'p: run targets local-worktree local-vm\n');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['dev-environments'], { 'run-targets': ['local-worktree', 'local-vm'] });
  const before = readFileSync(file, 'utf8');
  await assert.rejects(agent('project:set-run-targets', 'p', 'workstation'), e => /project:set-run-targets: dev-environments\.run-targets lists workstation, but dev-environments\.workstations lists no workstation/.test(e.stderr));
  await assert.rejects(agent('project:set-run-targets', 'p', 'local-vm', 'nope'), e => /unknown run target "nope"/.test(e.stderr));
  await assert.rejects(agent('project:set-run-targets', 'p', 'local-substrate'), e => /no Substrate cluster/.test(e.stderr));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('ASS-540 AC8: project:migrate-run-targets writes each project\'s run-targets from its mode and removes the mode; --dry-run writes nothing; idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-rt-'));
  const ws = { id: 'w', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
  const projects = { a: { name: 'a' }, b: { name: 'b', 'dev-environments': { mode: 'vm+workstation', workstations: [ws] } }, c: { name: 'c', 'dev-environments': { 'run-targets': ['local-worktree'] } } };
  for (const [id, json] of Object.entries(projects)) { mkdirSync(join(dir, id)); writeFileSync(join(dir, id, 'project.json'), JSON.stringify(json)); }
  const env = { ...process.env, PROJECTS_DIR: dir };
  const read = id => JSON.parse(readFileSync(join(dir, id, 'project.json'), 'utf8'));
  const dry = (await run(AGENT, ['project:migrate-run-targets', '--dry-run'], { env })).stdout;
  assert.equal(dry, 'a: run-targets local-vm (from mode unset (vm)) (dry run: not written)\nb: run-targets workstation, cloud-vm, local-vm (from mode vm+workstation) (dry run: not written)\nc: nothing to change\n');
  assert.deepEqual(read('b'), projects.b);
  await run(AGENT, ['project:migrate-run-targets'], { env });
  assert.deepEqual(read('a')['dev-environments'], { 'run-targets': ['local-vm'] });
  assert.deepEqual(read('b')['dev-environments'], { workstations: [ws], 'run-targets': ['workstation', 'cloud-vm', 'local-vm'] });
  assert.deepEqual(read('c'), projects.c);
  assert.equal((await run(AGENT, ['project:migrate-run-targets'], { env })).stdout, 'a: nothing to change\nb: nothing to change\nc: nothing to change\n');
});

test('ASS-553: project:set-pool-choice writes dev-environments.pool-choice; another value writes nothing', async () => {
  const f = fixture();
  const file = join(f.dir, 'projects', 'p', 'project.json');
  const agent = (...args) => run(AGENT, args, { env: f.env });
  assert.equal((await agent('project:set-pool-choice', 'p', 'remote-first')).stdout, 'p: pool choice first (default) → remote-first\n');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))['dev-environments']['pool-choice'], 'remote-first');
  assert.equal((await agent('project:set-pool-choice', 'p', 'most-room')).stdout, 'p: pool choice remote-first → most-room\n');
  const before = readFileSync(file, 'utf8');
  await assert.rejects(agent('project:set-pool-choice', 'p', 'random'), e => /must be first, most-room or remote-first/.test(e.stderr));
  assert.equal(readFileSync(file, 'utf8'), before);
});
