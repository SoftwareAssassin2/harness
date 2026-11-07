// vm:create, vm:start and ticket:set-vm (ASS-74): a ticket variation's VM,
// cloned from its project's golden image with only the ticket's folder
// mounted, started (under the sandbox that keeps it off the Mac's other
// services), logged in (vm:credentials), given its forwarder token and
// agent.sh, its repositories checked out on master once, and recorded on the
// variation. limactl is test/support/fake-limactl.js; the VM's root a folder
// (HARNESS_VM_ROOT) holding real git checkouts; `security` and
// `sandbox-exec` are fakes on the Mac's PATH, sudo, findmnt, mountpoint and
// ip in the VM's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';
import { lima, git, edit } from './vm-fixture.js';

const sha = t => createHash('sha256').update(t).digest('hex');
const CLIENT = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', 'in-vm', 'agent.sh'), 'utf8');

test('vm:create p ABC-3 A clones golden-p into abc-3-a with only the ticket\'s folder mounted, read-only (ASS-182), at /mnt/ticket; starts it sandboxed; logs it in before master is checked out in each repository; and records it', async () => {
  const l = lima();
  l.mount();
  const out = JSON.parse((await l.cli('vm:create', 'p', 'ABC-3', 'A')).stdout);
  assert.deepEqual(out, { name: 'abc-3-a', ip: '192.168.64.15', created: true });
  const calls = l.v.calls();
  const clone = calls.find(c => c.argv?.[0] === 'clone');
  assert.deepEqual(clone.argv.slice(0, 4), ['clone', '--tty=false', 'golden-p', 'abc-3-a']);
  const set = clone.argv[clone.argv.indexOf('--set') + 1];
  const mounts = JSON.parse(/\.mounts\s*=\s*(\[.*?\])\s*\|/.exec(set)[1]);
  assert.deepEqual(mounts, [{ location: l.folder, mountPoint: '/mnt/ticket', writable: false }], 'the ticket folder alone, read-only: no harness repo, no home, no scratch mount');
  const sshPort = /\.ssh\.localPort\s*=\s*(\d+)/.exec(set)[1];
  assert.ok(Number(sshPort) > 1024);
  // Started under the sandbox: its host agent reaches the Mac's loopback only at the forwarder, zot and its own ssh port.
  assert.deepEqual(calls.filter(c => c.argv?.[0] === 'start').map(c => c.argv), [['start', '--tty=false', 'abc-3-a']]);
  const profile = readFileSync(join(l.v.dir, 'sandbox-profile'), 'utf8');
  assert.match(profile, /\(deny network-outbound \(remote ip "\*:\*"\)\)/);
  assert.deepEqual([...profile.matchAll(/remote ip "localhost:(\d+)"/g)].map(m => m[1]).sort(), ['5101', '7787', sshPort].sort());
  // Logged in (vm:credentials) before anything touches the repositories.
  const shells = calls.filter(c => c.vm === 'abc-3-a');
  const credentials = shells.findIndex(c => c.argv.join(' ') === 'bash -s');
  const checkout = shells.findIndex(c => c.argv.includes('harness') && c.argv.includes('example-corpus'));
  assert.ok(credentials >= 0 && checkout > credentials, JSON.stringify(shells));
  assert.ok(existsSync(l.vmFile('run', 'harness', 'env')));
  // Master, as origin has it now, in each.
  for (const [name, { work, branch }] of Object.entries(l.origins)) {
    assert.equal(git(l.vmFile('repos', name), 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
    assert.equal(git(l.vmFile('repos', name), 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'));
  }
  // The forwarder's token: on the VM's tmpfs; on the Mac only its hash, with the binding, 0600.
  const token = readFileSync(l.vmFile('run', 'harness', 'agent-token'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual(l.tokens(), { 'abc-3-a': { project: 'p', ticket: 'ABC-3', variation: 'A', 'ticket-folder': l.folder, 'token-sha256': sha(token), 'issued-at': l.tokens()['abc-3-a']['issued-at'] } });
  assert.equal(statSync(join(l.home, '.harness', 'vm-tokens.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(calls).includes(token), 'never on a command line');
  assert.equal(readFileSync(l.vmFile('run', 'harness', 'agent-url'), 'utf8'), 'http://host.lima.internal:7787/run\n');
  assert.equal(readFileSync(l.vmFile('usr', 'local', 'bin', 'agent.sh'), 'utf8'), CLIENT);
  // Recorded on the variation, by name and IP.
  const vm = l.f.variation('A').vm;
  assert.deepEqual({ ...vm, 'created-at': undefined }, { name: 'abc-3-a', ip: '192.168.64.15', 'created-at': undefined });
  assert.match(vm['created-at'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('ASS-62 AC4: a VM\'s host agent may also reach its own project\'s Hindsight port — and no other project\'s — so its agents reach their memory at host.lima.internal:<port>', async () => {
  const l = lima();
  l.mount();
  edit(join(l.f.dir, 'projects', 'p', 'project.json'), p => { p.hindsight = { port: 8891, 'llm-api-key': null }; });
  edit(join(l.f.dir, 'projects', 'q', 'project.json'), p => { p.hindsight = { port: 8892, 'llm-api-key': null }; });
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  const profile = readFileSync(join(l.v.dir, 'sandbox-profile'), 'utf8');
  const ports = [...profile.matchAll(/remote ip "localhost:(\d+)"/g)].map(m => m[1]);
  assert.ok(ports.includes('8891'), profile);
  assert.ok(!ports.includes('8892'), 'another project\'s Hindsight stays out of reach');
  assert.deepEqual(ports.filter(x => !['5101', '7787', '8891'].includes(x)).length, 1, 'beside them only its own ssh port');
});

test('vm:create again reuses the VM: never touches the working trees, issues a fresh token, re-records the IP, keeps created-at — running or stopped', async () => {
  const l = lima();
  l.mount();
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  const first = { token: l.tokens()['abc-3-a']['token-sha256'], at: l.f.variation('A').vm['created-at'] };
  const repo = l.vmFile('repos', 'harness');
  git(repo, 'checkout', '-q', '-b', 'change/ABC-3'); writeFileSync(join(repo, 'wip.txt'), 'in progress\n');   // Generate Solution's work
  git(l.origins.harness.work, 'commit', '-q', '--allow-empty', '-m', 'three');
  writeFileSync(join(l.v.dir, 'ip'), '192.168.64.16');
  for (const status of ['Running', 'Stopped']) {
    writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), status);
    const before = l.v.calls().length;
    assert.deepEqual(JSON.parse((await l.cli('vm:create', 'p', 'ABC-3', 'A')).stdout), { name: 'abc-3-a', ip: '192.168.64.16', created: false });
    const calls = l.v.calls().slice(before);
    assert.ok(!calls.some(c => c.argv[0] === 'clone'));
    assert.equal(calls.some(c => c.argv[0] === 'start'), status === 'Stopped', status);
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3');
    assert.equal(readFileSync(join(repo, 'wip.txt'), 'utf8'), 'in progress\n');
    assert.notEqual(l.tokens()['abc-3-a']['token-sha256'], first.token);
    assert.equal(sha(readFileSync(l.vmFile('run', 'harness', 'agent-token'), 'utf8').trim()), l.tokens()['abc-3-a']['token-sha256']);
    assert.deepEqual(l.f.variation('A').vm, { name: 'abc-3-a', ip: '192.168.64.16', 'created-at': first.at });
  }
});

test('vm:create fails, recording no IP, without the golden image, the variation, a usable mount or the repositories; a checkout that failed is tried again next time', async () => {
  const l = lima();
  await assert.rejects(l.cli('vm:create', 'p', 'ABC-3', 'Z'), /no ABC-3 variation Z in p's active sprint/);
  await assert.rejects(l.cli('vm:create', 'p', 'ABC-3', 'A'), /\/mnt\/ticket is not mounted in abc-3-a/);   // not mounted (the fake's mount is missing)
  assert.deepEqual(Object.keys(l.f.variation('A').vm).sort(), ['created-at', 'name'], 'linked on its clone (ASS-234 AC2), its IP not yet');
  l.mount();
  rmSync(join(l.v.instances, 'golden-p'), { recursive: true });
  rmSync(join(l.v.instances, 'abc-3-a'), { recursive: true });
  await assert.rejects(l.cli('vm:create', 'p', 'ABC-3', 'A'), /no golden image golden-p: build it with vm:build-golden p/);
  l.v.instance('golden-p');
  const origin = l.origins['example-corpus'].work;
  execFileSync('mv', [origin, `${origin}.gone`]);
  await assert.rejects(l.cli('vm:create', 'p', 'ABC-3', 'A'), /could not check out master/);
  assert.equal(l.f.variation('A').vm.ip, undefined);
  execFileSync('mv', [`${origin}.gone`, origin]);
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(git(l.vmFile('repos', 'example-corpus'), 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
  rmSync(l.vmFile('repos', 'harness'), { recursive: true });
  // Its clone refused (the forge stood in for by a folder that is not there: never the network).
  const unreachable = { ...l.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${origin}-missing.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/o/harness' };
  await assert.rejects(run(AGENT, ['vm:create', 'p', 'ABC-3', 'A'], { env: unreachable }), /\/repos\/harness is missing in abc-3-a, and could not clone https:\/\/github\.com\/o\/harness/);
});

test('vm:create clones a repository project.json lists that the VM lacks — one added since the golden image was built (ASS-121) — and leaves the rest as they are', async () => {
  const l = lima();
  l.mount();
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  const repo = l.vmFile('repos', 'harness');
  git(repo, 'checkout', '-q', '-b', 'change/ABC-3');   // Generate Solution's work, never touched
  const work = mkdtempSync(join(tmpdir(), 'origin-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main', work]);
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T'); git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  edit(join(l.f.dir, 'projects', 'p', 'project.json'), p => { p.repositories.push({ url: 'https://gitlab.com/g/legal-search', description: 'l' }); });
  // The forge, as the VM's login reaches it, stood in for by the local origin.
  const env = { ...l.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${work}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://gitlab.com/g/legal-search' };
  await run(AGENT, ['vm:create', 'p', 'ABC-3', 'A'], { env });
  assert.equal(git(l.vmFile('repos', 'legal-search'), 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3');
});

test('vm:start pulls again, in the VM, each images.txt image registry:push put in the project\'s zot, so a rebuild reaches every VM at its next start; a failed pull leaves the VM its image', async t => {
  const l = lima();
  l.mount();
  // The project's zot, holding one pushed rebuild: the dev container.
  const pushed = '/v2/0local/example-project/containers/devcontainer/manifests/1.8.12';
  const asked = [];
  const zot = createServer((req, res) => { asked.push(`${req.method} ${req.url}`); res.statusCode = req.url === pushed ? 200 : 404; res.end(); });
  await new Promise(r => zot.listen(0, '127.0.0.1', r));
  t.after(() => zot.close());
  const ar = 'us-central1-docker.pkg.dev/example-project';
  mkdirSync(join(l.f.dir, 'projects', 'p', 'golden-image'), { recursive: true });
  writeFileSync(join(l.f.dir, 'projects', 'p', 'golden-image', 'images.txt'), [
    '# baked in', `${ar}/containers/devcontainer:1.8.12`, `${ar}/containers/keycloak:master`, '',
    `${ar}/dockerhub/caddy:2.10.2-alpine@sha256:${'5'.repeat(64)}`, 'docker.io/library/node:24',
  ].join('\n'));
  edit(join(l.f.dir, 'projects', 'p', 'project.json'), p => { p.registry.port = zot.address().port; p.registry.upstream = { host: 'us-central1-docker.pkg.dev', credentials: 'gcloud' }; p['golden-image'] = { folder: 'projects/p/golden-image' }; });
  l.v.inVm('docker', `printf '%s\\n' "$*" >> "${l.v.dir}/docker.log"; [[ ! -f "${l.v.dir}/docker-fails" ]]`);
  const pulls = () => (existsSync(join(l.v.dir, 'docker.log')) ? readFileSync(join(l.v.dir, 'docker.log'), 'utf8').trim().split('\n') : []);

  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.deepEqual(pulls(), [`pull -q ${ar}/containers/devcontainer:1.8.12`], 'only the pushed rebuild; never a pinned digest or another registry');
  assert.deepEqual(asked.filter(r => r.startsWith('HEAD')).map(r => r.split(' ')[1]).sort(), [pushed, '/v2/0local/example-project/containers/keycloak/manifests/master']);

  writeFileSync(join(l.v.dir, 'docker-fails'), '');
  const { stdout, stderr } = await l.cli('vm:start', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(stdout).name, 'abc-3-a');
  assert.match(stderr, /could not pull us-central1-docker\.pkg\.dev\/example-project\/containers\/devcontainer:1\.8\.12.*keeps the image it has/);
  assert.equal(pulls().length, 2);
});

// ASS-215 AC1: vm:start records on the VM's vms.json row, and prints, the
// credential kind vm:credentials injected — the kind control compares with
// the one the project declares now.
test('ASS-215 AC1: vm:start prints and records the credential kind vm:credentials injected: claude, then anthropic once the declaration is switched', async () => {
  const l = lima();
  l.mount();
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  const row = () => JSON.parse(readFileSync(join(l.f.dir, 'projects', 'p', 'vms.json'), 'utf8'))['abc-3-a'];
  const first = JSON.parse((await l.cli('vm:start', 'p', 'ABC-3', 'A')).stdout);
  assert.deepEqual(first, { name: 'abc-3-a', ip: '192.168.64.15', 'credential-kind': 'claude' });
  assert.equal(row()['credential-kind'], 'claude');
  writeFileSync(join(l.home, '.harness', 'vm-credentials.json'), JSON.stringify({ p: { anthropic: { 'keychain-service': 'Anthropic API Key (Test)' } } }));
  const second = JSON.parse((await l.cli('vm:start', 'p', 'ABC-3', 'A')).stdout);
  assert.equal(second['credential-kind'], 'anthropic');
  assert.equal(row()['credential-kind'], 'anthropic');
  assert.equal(row().ticket, 'ABC-3');
});

test('ASS-215 AC1: vm:start fails, naming the step, when what vm:credentials printed is not a credential kind', async () => {
  const l = lima();
  l.mount();
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  l.v.inVm('sudo', 'echo noise; exec "$@"');   // the injection's stdout corrupted
  await assert.rejects(l.cli('vm:start', 'p', 'ABC-3', 'A'), /vm:start: .*vm:credentials/);
});

test('ticket:set-vm records the variation\'s VM, its created-at kept while the name is the same', async () => {
  const f = fixture();
  await f.agent('ticket:set-vm', 'p', 'ABC-3', 'A', 'abc-3-a', '192.168.64.5');
  const vm = f.variation('A').vm;
  assert.equal(vm.ip, '192.168.64.5');
  await f.agent('ticket:set-vm', 'p', 'abc-3', 'A', 'abc-3-a', '192.168.64.6');
  assert.deepEqual(f.variation('A').vm, { ...vm, ip: '192.168.64.6' });
  await assert.rejects(f.agent('ticket:set-vm', 'p', 'ABC-3', 'A', 'Bad Name', '1.2.3.4'), /invalid VM name/);
  await assert.rejects(f.agent('ticket:set-vm', 'p', 'ABC-3', 'Z', 'abc-3-z', '1.2.3.4'), /no ABC-3 variation Z/);
});

// AC6, the vzNAT half (the host agent's half is vm:start's sandbox, above). pfctl -n checks the rules parse, as pf would load them.
test('vm:firewall\'s pf rules let a VM on vzNAT reach the Mac only for DNS and DHCP, keeping the Mac\'s own connections to it; --install loads them through sudo, at boot too', async () => {
  const v = fakeVm();
  v.script('sudo', `printf '%s\\n' "$*" >> "${v.dir}/sudo.log"; [[ "$1" != tee ]] || cat > "${v.dir}/tee-$(basename "$2")"`);
  const rules = (await run(AGENT, ['vm:firewall'], { env: v.env })).stdout;
  assert.match(rules, /^pass out quick inet from any to 192\.168\.64\.0\/24 keep state$/m);
  assert.match(rules, /^pass in quick inet proto \{ udp, tcp \} from 192\.168\.64\.0\/24 to 192\.168\.64\.1 port 53$/m);
  assert.match(rules, /^block drop in quick inet from 192\.168\.64\.0\/24 to \{ self, 127\.0\.0\.0\/8, 10\.0\.0\.0\/8, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16, 169\.254\.0\.0\/16, 100\.64\.0\.0\/10 \}$/m);
  assert.match(rules, /^block drop in quick on bridge100 inet6 to \{ self, fc00::\/7, fe80::\/10 \}$/m);
  const file = join(v.dir, 'rules.pf');
  writeFileSync(file, rules);
  // Parses (no root needed to check); pf, and so pfctl, is the Mac's alone, where the rules are loaded.
  if (process.platform === 'darwin') execFileSync('pfctl', ['-n', '-f', file], { stdio: 'ignore' });
  await run(AGENT, ['vm:firewall', '--install'], { env: v.env });
  assert.deepEqual(readFileSync(join(v.dir, 'sudo.log'), 'utf8').trim().split('\n'), [
    'tee /etc/pf.anchors/com.harness.vm', 'pfctl -q -a com.apple/harness-vm -f /etc/pf.anchors/com.harness.vm', 'pfctl -q -E',
    'tee /Library/LaunchDaemons/com.harness.vm-firewall.plist', 'launchctl bootout system /Library/LaunchDaemons/com.harness.vm-firewall.plist', 'launchctl bootstrap system /Library/LaunchDaemons/com.harness.vm-firewall.plist']);
  assert.equal(readFileSync(join(v.dir, 'tee-com.harness.vm'), 'utf8'), rules);
  assert.match(readFileSync(join(v.dir, 'tee-com.harness.vm-firewall.plist'), 'utf8'), /<string>\/sbin\/pfctl<\/string><string>-E<\/string><string>-a<\/string><string>com\.apple\/harness-vm<\/string>/);
});

// ASS-234 AC2: the VM is linked to its variation (ticket:set-vm) right after
// its clone, before vm:start logs it in: a create that fails there leaves a
// VM control knows as the variation's, never one only the inventory knows.
test('ASS-234 AC2: vm:create links the VM to its variation right after the clone, so a create whose credentials fail leaves it linked; the next records its IP', async () => {
  const l = lima();
  l.mount();
  l.v.script('security', 'exit 44');   // the keychain item unreadable: vm:credentials fails
  await assert.rejects(l.cli('vm:create', 'p', 'ABC-3', 'A'));
  const linked = l.f.variation('A').vm;
  assert.equal(linked.name, 'abc-3-a');
  assert.equal(linked.ip, undefined);
  l.v.script('security', 'echo sk-ant-oat01-TEST');
  assert.deepEqual(JSON.parse((await l.cli('vm:create', 'p', 'ABC-3', 'A')).stdout), { name: 'abc-3-a', ip: '192.168.64.15', created: false });
  assert.deepEqual(l.f.variation('A').vm, { ...linked, ip: '192.168.64.15' });
});

// ASS-234 AC3: a VM records the golden image it was cloned from (its
// golden-image.json, copied); one reused that came from an image older than
// the last build marked a fix (vm:build-golden --fix) is recreated while its
// Setup never completed (nothing of the ticket's work in it), else kept with a warning.
test('ASS-234 AC3: vm:create recreates a reused VM cloned before the golden image\'s last fix while its Setup never completed; keeps it, warning, once it did; reuses one when the newer build fixed nothing', async () => {
  const label = (dir, json) => writeFileSync(join(l.v.instances, dir, 'golden-image.json'), JSON.stringify(json));
  const old = { project: 'p', hash: 'a'.repeat(64), 'built-at': '2026-10-01T00:00:00Z' };
  const clones = () => l.v.calls().filter(c => c.argv?.[0] === 'clone').length;
  const l = lima();
  l.mount();
  label('golden-p', old);
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.deepEqual(JSON.parse(readFileSync(join(l.v.instances, 'abc-3-a', 'golden-image.json'), 'utf8')), old, 'the image it was cloned from');

  label('golden-p', { ...old, hash: 'b'.repeat(64), 'built-at': '2026-10-10T00:00:00Z' });   // newer, but no fix
  let r = await l.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(r.stdout).created, false);
  assert.equal(clones(), 1);
  assert.doesNotMatch(r.stderr, /older/);

  const fixed = { ...old, hash: 'c'.repeat(64), 'built-at': '2026-10-20T00:00:00Z', fix: 'claude installed', 'fixed-at': '2026-10-20T00:00:00Z' };
  label('golden-p', fixed);
  writeFileSync(l.vmFile('repos', '.setup-complete'), '');   // its Setup completed: the ticket's work may be in it
  r = await l.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(r.stdout).created, false);
  assert.equal(clones(), 1);
  assert.match(r.stderr, /abc-3-a was cloned from an older golden-p than its fix of 2026-10-20T00:00:00Z \(claude installed\); it is kept/);

  rmSync(l.vmFile('repos', '.setup-complete'));
  r = await l.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(r.stdout).created, true);
  assert.equal(clones(), 2);
  assert.match(r.stderr, /abc-3-a was cloned from an older golden-p than its fix of 2026-10-20T00:00:00Z \(claude installed\), and its Setup never completed; it is recreated from golden-p/);
  assert.deepEqual(JSON.parse(readFileSync(join(l.v.instances, 'abc-3-a', 'golden-image.json'), 'utf8')), fixed);
  assert.ok(l.f.variation('A').vm['recreated-at']);
  r = await l.cli('vm:create', 'p', 'ABC-3', 'A');   // from the fixed image now
  assert.equal(JSON.parse(r.stdout).created, false);

  rmSync(join(l.v.instances, 'abc-3-a', 'golden-image.json'));   // cloned before VMs recorded their image
  r = await l.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(r.stdout).created, true);
  assert.equal(clones(), 3);
});
