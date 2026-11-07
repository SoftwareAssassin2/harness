// A real VM, end to end (ASS-74 AC3, AC4, AC6): run only with
// HARNESS_VM_TESTS=1, on the Mac the VMs run on — it needs Lima, the
// golden-harness image, the keychain items ~/.harness/vm-credentials.json
// declares for the harness, and the network (master is fetched). It makes a
// throwaway VM, iso-1-a, for a ticket ISO-1 of a temp copy of the harness
// project, through vm:create, and deletes it after. From inside it: the
// forwarder answers for its ticket and refuses another; its project's zot
// (a stand-in on the project's registry port) answers; another of the Mac's
// services does not, on its loopback (through host.lima.internal) nor on
// its vzNAT address (which needs vm:firewall --install: pf); the ticket's
// folder is at /mnt/ticket, read-only (ASS-182), and nothing else of the Mac's is.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limaHome } from '../../src/control/vm.js';
import { startForwarder } from '../../src/control/forwarder.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const VM = 'iso-1-a', LIMA = { ...process.env, LIMA_HOME: limaHome() };
const skip = process.env.HARNESS_VM_TESTS !== '1' && 'set HARNESS_VM_TESTS=1 to run against a real VM';
const free = () => new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const listen = (port, host) => new Promise(resolve => { const s = http.createServer((q, r) => r.end(`mac service ${port}\n`)).listen(port, host, () => resolve(s)); });
const servers = [];
const deleteVm = () => { try { execFileSync('limactl', ['delete', '-f', VM], { env: LIMA, stdio: 'ignore' }); } catch { /* none */ } };
// inVm(command) — bash in the VM: { code, out }.
const inVm = command => run('limactl', ['shell', '--workdir', '/', VM, '--', 'bash', '-c', command], { env: LIMA }).then(r => ({ code: 0, out: r.stdout.trim() }), e => ({ code: e.code, out: `${e.stdout}${e.stderr}`.trim() }));
const reach = url => inVm(`curl -s -m 5 ${url}`);

after(() => { for (const s of servers) s.close(); if (!skip) deleteVm(); });

// makeVm() — a throwaway iso-1-a for ticket ISO-1 of a temp copy of the harness
// project, through vm:create, with stand-in services on free ports: { made, dir, env, zotPort, loopbackPort, everyPort }.
const makeVm = async () => {
  deleteVm();
  const dir = mkdtempSync(join(tmpdir(), 'iso-'));
  const project = JSON.parse(readFileSync(join(ROOT, 'data', 'projects', 'harness', 'project.json'), 'utf8'));
  const [forwarderPort, zotPort, loopbackPort, everyPort] = [await free(), await free(), await free(), await free()];
  mkdirSync(join(dir, 'projects', 'harness', 'sprints', 'sprint-1'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'harness', 'project.json'), JSON.stringify({ ...project, registry: { ...project.registry, port: zotPort } }));
  writeFileSync(join(dir, 'projects', 'harness', 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(join(dir, 'projects', 'harness', 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [{ key: 'ISO-1', variations: [{ name: 'A', 'harness-status': { state: 'setup', 'state-engine': 'harness-development' } }] }] }));
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'forwarder-port': forwarderPort, 'vm-disk-limit-gb': 1000 }));
  writeFileSync(join(dir, 'assignments.json'), JSON.stringify({ assignments: [] }));
  const env = { ...LIMA, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json'), ASSIGNMENTS_FILE: join(dir, 'assignments.json'), HARNESS_HOME: join(dir, 'home'), ACLI_DISABLED: '1' };
  servers.push(await startForwarder({ root: ROOT, env, port: forwarderPort }), await listen(zotPort, '127.0.0.1'), await listen(loopbackPort, '127.0.0.1'), await listen(everyPort, '0.0.0.0'));

  const made = JSON.parse((await run(AGENT, ['vm:create', 'harness', 'ISO-1', 'A'], { env })).stdout);
  return { made, dir, env, zotPort, loopbackPort, everyPort };
};

test('a VM made by vm:create reaches the forwarder (for its ticket alone) and its zot, nothing else of the Mac\'s, and only its ticket\'s folder', { skip, timeout: 300_000 }, async () => {
  const { made, dir, zotPort, loopbackPort, everyPort } = await makeVm();  assert.equal(made.name, VM);
  // AC3: the forwarder, for this ticket only.
  assert.deepEqual(await inVm('agent.sh ticket:questions-answered harness ISO-1'), { code: 0, out: '{"ticket":"ISO-1","open":0}' });
  const refused = await inVm('agent.sh ticket:questions-answered harness ISO-2');
  assert.equal(refused.code, 77);
  assert.match(refused.out, /refused by the host: ticket "ISO-2" is not this VM's ISO-1/);
  // AC6: the forwarder and zot answer; nothing else of the Mac's does, by either way.
  assert.equal((await reach(`http://host.lima.internal:${zotPort}/`)).out, `mac service ${zotPort}`);
  assert.notEqual((await reach(`http://host.lima.internal:${loopbackPort}/`)).code, 0, 'the Mac\'s loopback, through host.lima.internal');
  assert.notEqual((await reach(`http://host.lima.internal:${everyPort}/`)).code, 0, 'a service on every address, through host.lima.internal');
  // AC4: the ticket's folder, to read; no more of the Mac.
  const folder = join(dir, 'projects', 'harness', 'work', 'ISO-1');
  writeFileSync(join(folder, 'from-mac.txt'), 'hello vm\n');
  assert.equal((await inVm('cat /mnt/ticket/from-mac.txt')).out, 'hello vm');
  // ASS-182 AC1: read-only — a VM agent writes the ticket's files only through its agent.sh.
  assert.notEqual((await inVm('echo from the vm > /mnt/ticket/from-vm.txt')).code, 0);
  assert.equal(existsSync(join(folder, 'from-vm.txt')), false);
  assert.equal((await inVm(`findmnt -rn -o TARGET -t virtiofs,9p,fuse.sshfs | grep -v '^/mnt/lima-' | tr '\\n' ' '`)).out, '/mnt/ticket');
  assert.equal((await inVm(`ls /Volumes /Users 2>&1 | wc -l; test -e '${ROOT}' || echo absent`)).out.split('\n').pop(), 'absent');   // the Mac's checkout of the harness
  assert.ok(existsSync(join(dir, 'home', 'vm-tokens.json')));
  // Last, being the half only pf (vm:firewall --install, sudo) closes.
  assert.notEqual((await reach(`http://192.168.64.1:${everyPort}/`)).code, 0, 'a service on every address, by vzNAT: needs vm:firewall --install');
});

// ASS-71 AC1: a VM vm:create made is logged in with its project's declared
// credentials — git can push (dry run, nothing is pushed) and gh can read the
// harness's repository, claude answers, and commits carry the declared identity.
test('a VM made by vm:create is logged in: git push and gh reach the harness repository, claude answers, commits carry the declared identity', { skip, timeout: 300_000 }, async () => {
  const { made } = await makeVm();
  assert.equal(made.name, VM);
  const declared = JSON.parse(readFileSync(join(process.env.HOME, '.harness', 'vm-credentials.json'), 'utf8')).harness;
  const push = await inVm('cd /repos/harness && git push --dry-run origin HEAD:refs/heads/vm-credentials-probe 2>&1');
  assert.equal(push.code, 0, push.out);
  const gh = await inVm('cd /repos/harness && gh repo view --json nameWithOwner -q .nameWithOwner');
  // The harness's own repository, as its origin on the Mac names it (owner/name).
  const origin = /[:/]([^/:]+\/[^/]+?)(\.git)?$/.exec(execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())[1];
  assert.deepEqual(gh, { code: 0, out: origin });
  const claude = await inVm('claude -p "Reply with the single word ready." 2>&1');
  assert.equal(claude.code, 0, claude.out);
  assert.match(claude.out, /ready/i);
  assert.equal((await inVm('git config --global user.email')).out, declared.git['user-email']);
});

// ASS-68 AC7: Setup's first step asks the VM for the setup-complete marker,
// its last step writes it; a fresh VM has none, and a restarted one keeps it.
test('a fresh VM holds no setup-complete marker; vm:mark-setup-complete writes it, and vm:setup-complete then says so, after a restart too', { skip, timeout: 300_000 }, async () => {
  const { env } = await makeVm();
  const complete = () => run(AGENT, ['vm:setup-complete', 'harness', 'ISO-1', 'A'], { env }).then(() => true, e => { assert.equal(e.code, 1, e.stderr); return false; });
  assert.equal(await complete(), false);
  await run(AGENT, ['vm:mark-setup-complete', 'harness', 'ISO-1', 'A'], { env });
  assert.equal(await complete(), true);
  execFileSync('limactl', ['stop', VM], { env: LIMA, stdio: 'ignore' });
  assert.equal(await complete(), false, 'a stopped VM is not complete — vm:setup-complete never starts it');
  await run(AGENT, ['vm:start', 'harness', 'ISO-1', 'A'], { env });
  assert.equal(await complete(), true, 'the marker survives a restart');
});
