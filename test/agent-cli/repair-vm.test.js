// ASS-427 — the commands grouped-blocked's Repair the VM path runs on the Mac:
// vm:run (the fix made in the ticket's own VM, from a script file), vm:hold
// (the operator keeps a ticket's VM running to work in it by hand),
// vm:golden-add-tool (a missing tool named in project.json's golden-image
// tools, so a build without it fails), vm:credentials-declare (a non-secret
// VM-setup declaration added to ~/.harness/vm-credentials.json and applied to
// the ticket's VM at once: ABC-897's undeclared @example npm registry) and
// vm:golden-followup (the source fix carried into a rebuild nobody waits for,
// one build per project at a time, its result logged on the ticket). Lima is
// test/support/fake-limactl.js (vm-fixture.js); HOME a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, AGENT } from './harness-fixture.js';
import { lima, edit } from './vm-fixture.js';

const outcome = promise => promise.then(r => ({ code: 0, out: r.stdout, stderr: r.stderr }), e => ({ code: e.code, out: e.stdout, stderr: e.stderr }));
const json = r => JSON.parse(r.out);
const LOADED_MS = 60_000;
async function until(check, ms = LOADED_MS) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise(r => setTimeout(r, 100)); }
  return check();
}

// The lima() fixture with p's golden image defined and built from it now (generation g2), ABC-3 A's VM made;
// a temp folder for the agent's script files; HOME's vm-credentials.json as `credentials` gives it.
async function setup({ credentials } = {}) {
  const l = lima();
  l.mount();
  l.v.inVm('claude', 'exit 0');
  const at = (...rest) => join(l.f.dir, ...rest);
  const folder = at('projects', 'p', 'golden-image');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'template.yaml'), 'vmType: vz\n');
  writeFileSync(join(folder, 'provision.sh'), '#!/bin/bash\nsudo apt-get install -y jq\n');
  chmodSync(join(folder, 'provision.sh'), 0o755);
  edit(at('projects', 'p', 'project.json'), p => { p['golden-image'] = { folder: 'projects/p/golden-image', tools: ['pnpm'] }; });
  if (credentials) writeFileSync(join(l.home, '.harness', 'vm-credentials.json'), JSON.stringify(credentials));
  const agent = (...args) => outcome(run(AGENT, args, { env: l.env }));
  const hash = async () => JSON.parse((await run(AGENT, ['vm:golden-stale', 'p'], { env: l.env })).stdout).hash;
  const label = async (fields = {}) => writeFileSync(join(l.v.instances, 'golden-p', 'golden-image.json'), JSON.stringify({ project: 'p', hash: await hash(), 'built-at': '2026-11-14T08:00:00Z', generation: 'g2', ...fields }));
  await label();
  await agent('vm:create', 'p', 'ABC-3', 'A');
  const tmp = mkdtempSync(join(tmpdir(), 'agent-tmp-'));
  const file = (name, content) => { writeFileSync(join(tmp, name), content); return join(tmp, name); };
  const log = () => (existsSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md')) ? readFileSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md'), 'utf8') : '');
  const variation = () => JSON.parse(readFileSync(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8')).features.find(t => t.key === 'ABC-3').variations.find(v => v.name === 'A');
  // A build vm:build-golden-start started, still going (this process its pid); ended() its exit recorded.
  const building = () => writeFileSync(at('projects', 'p', 'golden-build-run.json'), JSON.stringify({ pid: process.pid, 'started-at': '2026-11-14T09:00:00Z' }));
  const ended = code => writeFileSync(at('projects', 'p', 'golden-build-run.exit'), `${code}\n`);
  const followup = () => (existsSync(at('projects', 'p', 'golden-followup.json')) ? JSON.parse(readFileSync(at('projects', 'p', 'golden-followup.json'), 'utf8')).entries : []);
  return { ...l, at, folder, agent, label, file, log, variation, building, ended, followup, tmp };
}

test('ASS-427 AC1: vm:run runs the agent\'s script file in the ticket\'s own VM — its output printed, its exit returned, the script and its exit logged; no VM, or one never up, exit 3, nothing run; no file, exit 1', async () => {
  const s = await setup();
  const fix = s.file('fix.sh', 'set -e\necho "installing bats"\nmkdir -p "$HARNESS_VM_ROOT/usr/bin" && printf "#!/bin/sh\\necho bats 1.11\\n" > "$HARNESS_VM_ROOT/usr/bin/bats"\n');
  const before = s.v.calls().length;
  const ok = await s.agent('vm:run', 'p', 'abc-3', 'A', fix);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.out, /installing bats/);
  assert.ok(existsSync(s.vmFile('usr', 'bin', 'bats')), 'run in the VM');
  const shell = s.v.calls().slice(before).filter(c => c.vm === 'abc-3-a' && c.argv.join(' ') === 'bash -s');
  assert.equal(shell.length, 1, 'through limactl shell <its VM> -- bash -s, the script on stdin');
  assert.match(s.log(), /Blocked, Repair the VM\nvm:run in abc-3-a: exit 0\. The script:\n```bash\nset -e\necho "installing bats"/);
  const failing = await s.agent('vm:run', 'p', 'ABC-3', 'A', s.file('check.sh', 'echo "bats: not found" >&2; exit 127\n'));
  assert.equal(failing.code, 127);
  assert.match(failing.out, /bats: not found/);
  assert.match(s.log(), /vm:run in abc-3-a: exit 127/);
  assert.match((await s.agent('vm:run', 'p', 'ABC-3', 'A', join(s.tmp, 'none.sh'))).stderr, /no script file/);
  writeFileSync(join(s.v.instances, 'abc-3-a', 'status'), 'Stopped');
  const down = await outcome(run(AGENT, ['vm:run', 'p', 'ABC-3', 'A', fix], { env: { ...s.env, VM_RUN_WAIT_SECONDS: '0' } }));
  assert.equal(down.code, 3);
  assert.match(down.stderr, /abc-3-a is not running and reachable after 0s: nothing run/);
  edit(s.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => { delete sprint.features.find(t => t.key === 'ABC-3').variations[0].vm; });
  const none = await s.agent('vm:run', 'p', 'ABC-3', 'A', fix);
  assert.equal(none.code, 3);
  assert.match(none.stderr, /ABC-3 A has no VM yet: nothing to fix in place/);
});

test('ASS-427 AC7: vm:hold on records who holds the variation\'s VM running since when (and why), logged; off removes it; anything else refused, nothing written', async () => {
  const s = await setup();
  const on = await s.agent('vm:hold', 'p', 'ABC-3', 'A', 'on', 'adding bats by hand');
  assert.equal(on.code, 0, on.stderr);
  const hold = s.variation()['vm-hold'];
  assert.deepEqual([hold.note, typeof hold.by, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(hold.since)], ['adding bats by hand', 'string', true]);
  assert.deepEqual(json(on), { project: 'p', ticket: 'ABC-3', variation: 'A', vm: 'abc-3-a', hold });
  assert.match(s.log(), /Blocked, VM hold\nvm:hold on by [^:]+: adding bats by hand: control keeps abc-3-a running, starting it when stopped, until vm:hold p ABC-3 A off\./);
  const off = await s.agent('vm:hold', 'p', 'ABC-3', 'A', 'off');
  assert.equal(off.code, 0, off.stderr);
  assert.equal(s.variation()['vm-hold'], undefined);
  assert.equal(json(off).hold, null);
  assert.match(s.log(), /vm:hold off by [^:]+: abc-3-a is left to its step's rules again/);
  for (const args of [['maybe'], ['off', 'a note'], []]) assert.equal((await s.agent('vm:hold', 'p', 'ABC-3', 'A', ...args)).code, 1, args.join(' '));
  assert.match((await s.agent('vm:hold', 'p', 'ABC-9', 'A', 'on')).stderr, /no ABC-9 variation A/);
});

test('ASS-427 AC2: vm:golden-add-tool adds a missing tool to project.json\'s golden-image tools (the build\'s tools check), once; refuses a name that is no command', async () => {
  const s = await setup();
  const added = await s.agent('vm:golden-add-tool', 'p', 'bats');
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(json(added), { project: 'p', tool: 'bats', tools: ['pnpm', 'bats'], added: true });
  assert.deepEqual(json(await s.agent('vm:golden-add-tool', 'p', 'bats')), { project: 'p', tool: 'bats', tools: ['pnpm', 'bats'], added: false });
  assert.deepEqual(JSON.parse(readFileSync(s.at('projects', 'p', 'project.json'), 'utf8'))['golden-image'].tools, ['pnpm', 'bats']);
  for (const bad of ['bats; rm -rf /', '../x', '']) assert.equal((await s.agent('vm:golden-add-tool', 'p', bad)).code, 1, bad);
  edit(s.at('projects', 'q', 'project.json'), p => { delete p['golden-image']; });
  assert.match((await s.agent('vm:golden-add-tool', 'q', 'bats')).stderr, /q has no golden-image/);
});

const GITLAB = { claude: { 'keychain-service': 'Claude Token (Test)' }, gitlab: { 'keychain-service': 'GitLab PAT (Test)', host: 'gitlab.com' } };

test('ASS-427 AC2/AC5: vm:credentials-declare adds an undeclared gitlab npm registry (scope → project id) to ~/.harness/vm-credentials.json, its mode and the other entries kept, and writes the ticket\'s VM\'s npmrc at once (vm:credentials) — ABC-897', async () => {
  const s = await setup({ credentials: { p: GITLAB, other: { claude: { 'keychain-service': 'X' } } } });
  const file = join(s.home, '.harness', 'vm-credentials.json');
  chmodSync(file, 0o600);
  assert.ok(!existsSync(s.vmFile('run', 'harness', 'npmrc')), 'no npmrc: no registry declared');
  const r = await s.agent('vm:credentials-declare', 'p', 'ABC-3', 'A', 'npm-registry', '@example', '11223344');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), { project: 'p', kind: 'npm-registry', scope: '@example', id: '11223344', declared: true, applied: true });
  const now = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(now.p.gitlab, { 'keychain-service': 'GitLab PAT (Test)', host: 'gitlab.com', 'npm-registries': { '@example': '11223344' } });
  assert.deepEqual(now.other, { claude: { 'keychain-service': 'X' } }, 'every other project as it was');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'its mode kept');
  assert.match(readFileSync(s.vmFile('run', 'harness', 'npmrc'), 'utf8'), /^@example:registry=https:\/\/gitlab\.com\/api\/v4\/projects\/11223344\/packages\/npm\/\n\/\/gitlab\.com\/api\/v4\/projects\/11223344\/packages\/npm\/:_authToken=\$\{GITLAB_TOKEN\}\n$/, 'the VM set up with it now, its token by reference');
  assert.match(s.log(), /Blocked, Repair the VM\nvm:credentials-declare: gitlab npm-registries @example → GitLab project 11223344 added to [^\n]*: every later VM of p gets it as it starts\. Applied in abc-3-a now/);
  const again = await s.agent('vm:credentials-declare', 'p', 'ABC-3', 'A', 'npm-registry', '@example-activity', '55667788');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).p.gitlab['npm-registries'], { '@example': '11223344', '@example-activity': '55667788' }, again.stderr);
  assert.equal(json(await s.agent('vm:credentials-declare', 'p', 'ABC-3', 'A', 'npm-registry', '@example', '11223344')).declared, false, 'the same: nothing to add');
  // Its VM stopped: declared, applied when it next starts.
  writeFileSync(join(s.v.instances, 'abc-3-a', 'status'), 'Stopped');
  const stopped = json(await s.agent('vm:credentials-declare', 'p', 'ABC-3', 'A', 'npm-registry', '@example-ui', '1'));
  assert.deepEqual([stopped.declared, stopped.applied], [true, false]);
  assert.match(stopped['not-applied'], /abc-3-a is not running/);
});

test('ASS-427 AC5: vm:credentials-declare never touches a secret or the operator\'s decisions — refused (exit 3, nothing changed) without a gitlab credential declared, or for a scope declared with another id; bad scopes, ids and kinds refused', async () => {
  const s = await setup({ credentials: { p: { claude: { 'keychain-service': 'Claude Token (Test)' } } } });
  const file = join(s.home, '.harness', 'vm-credentials.json'), before = readFileSync(file, 'utf8');
  const nogitlab = await s.agent('vm:credentials-declare', 'p', 'ABC-3', 'A', 'npm-registry', '@example', '11223344');
  assert.equal(nogitlab.code, 3);
  assert.match(nogitlab.stderr, /p declares no gitlab credential [^\n]*the operator declares gitlab \(its keychain item\) first/);
  assert.equal(readFileSync(file, 'utf8'), before);
  writeFileSync(file, JSON.stringify({ p: { ...GITLAB, gitlab: { ...GITLAB.gitlab, 'npm-registries': { '@example': '1' } } } }));
  const other = await s.agent('vm:credentials-declare', 'p', 'ABC-3', 'A', 'npm-registry', '@example', '11223344');
  assert.equal(other.code, 3);
  assert.match(other.stderr, /already declares @example as GitLab project 1, not 11223344: changing it is the operator's decision/);
  assert.match(s.log(), /vm:credentials-declare refused/);
  for (const args of [['npm-registry', 'example', '1'], ['npm-registry', '@Example', '1'], ['npm-registry', '@example', 'abc'], ['keychain-service', 'GitLab PAT', 'x'], ['npm-registry', '@example']]) {
    assert.equal((await s.agent('vm:credentials-declare', 'p', 'ABC-3', 'A', ...args)).code, 1, args.join(' '));
  }
});

test('ASS-427 AC2/AC6: vm:golden-followup with the ticket starts the rebuild of a changed definition at once, never waiting on it; once that build ends its result is logged on the ticket — failed, or rebuilt with its checks passed — and the entry dropped', async () => {
  // No VM credentials declared for p: the build vm:build-golden-start starts fails at its first check, before any VM is made.
  const s = await setup({ credentials: {} });
  writeFileSync(join(s.folder, 'provision.sh'), '#!/bin/bash\nsudo apt-get install -y jq bats\n');   // Repair the VM's source fix
  const started = await s.agent('vm:golden-followup', 'p', 'ABC-3', 'A');
  assert.equal(started.code, 0, started.stderr);
  assert.deepEqual([json(started).started, json(started).status, json(started).waiting], [true, 'building', 1]);
  assert.match(s.followup()[0].build, /^\d{4}-/, 'the entry records the build started for it');
  assert.match(s.log(), /Blocked, Rebuild the Source\nStarted golden-p's rebuild with the fix \(vm:build-golden-start, [^)]+\)\. Nobody waits for it: this ticket goes on on its fixed VM/);
  assert.ok(await until(() => existsSync(s.at('projects', 'p', 'golden-build-run.exit'))), 'the build ended');
  const failed = json(await s.agent('vm:golden-followup', 'p'));
  assert.deepEqual([failed.reported, failed.waiting, failed.started], [[{ ticket: 'ABC-3', variation: 'A', result: 'failed' }], 0, false]);
  assert.match(s.log(), /golden-p's rebuild with the fix failed \(exit 1\): see [^\n]*golden-image-build\.log[^\n]*This ticket's VM keeps its fix; later VMs are cloned from the older image/);
  // Again, the build succeeding: rebuilt, its checks (the tools check among them) passed.
  await s.agent('vm:golden-followup', 'p', 'ABC-3', 'A');
  assert.ok(await until(() => existsSync(s.at('projects', 'p', 'golden-build-run.exit'))));
  await s.label({ 'built-at': '2026-11-14T10:00:00Z', generation: 'g3' });
  s.ended(0);
  const rebuilt = json(await s.agent('vm:golden-followup', 'p'));
  assert.deepEqual(rebuilt.reported, [{ ticket: 'ABC-3', variation: 'A', result: 'rebuilt' }]);
  assert.match(s.log(), /golden-p rebuilt with the fix \(built-at 2026-11-14T10:00:00Z, generation g3\): its build's checks passed, the tools check \(project\.json golden-image\.tools\) among them\. Later VMs are cloned from it\./);
  assert.deepEqual(s.followup(), []);
});

test('ASS-427 AC2: a VM-setup fix needs no rebuild — the image current with its definition, the entry is logged so and dropped, nothing started', async () => {
  const s = await setup({ credentials: {} });
  const r = json(await s.agent('vm:golden-followup', 'p', 'ABC-3', 'A'));
  assert.deepEqual([r.status, r.started, r.waiting], ['current', false, 0]);
  assert.match(s.log(), /No rebuild needed: golden-p is current with its definition \(the fix was to the VM's setup, or needed no image change\)/);
  assert.ok(!existsSync(s.at('projects', 'p', 'golden-build-run.json')), 'nothing started');
});

test('ASS-427 AC3: one build per project at a time — while one runs, a definition change is queued (vm:golden-write) and the ticket\'s entry waits, nothing started; once it ends, vm:golden-followup (control\'s) writes the queue into the definition and starts the rebuild', async () => {
  const s = await setup({ credentials: {} });
  s.building();
  const write = await s.agent('vm:golden-write', 'p', 'provision.sh', s.file('provision.sh', '#!/bin/bash\nsudo apt-get install -y jq bats\n'));   // ASS-428's file form
  assert.equal(JSON.parse(write.out).queued, true, write.stderr);
  const waiting = json(await s.agent('vm:golden-followup', 'p', 'ABC-3', 'A'));
  assert.deepEqual([waiting.status, waiting.started, waiting.waiting, waiting.queued, waiting.applied], ['building', false, 1, 1, []]);
  assert.match(readFileSync(join(s.folder, 'provision.sh'), 'utf8'), /install -y jq\n$/, 'the definition untouched while it builds');
  assert.match(s.log(), /golden-p is being built now \(one build per project at a time\): the fix's definition change waits in golden-queue, and the rebuild with it starts once that build ends\. This ticket goes on on its fixed VM; it does not wait\./);
  assert.equal(json(await s.agent('vm:golden-followup', 'p')).started, false, 'still building: nothing');
  rmSync(s.at('projects', 'p', 'golden-build-run.json'));   // that build ended
  const after = json(await s.agent('vm:golden-followup', 'p'));
  assert.deepEqual([after.applied, after.started, after.queued, after.waiting], [['provision.sh'], true, 0, 1]);
  assert.equal(readFileSync(join(s.folder, 'provision.sh'), 'utf8'), '#!/bin/bash\nsudo apt-get install -y jq bats\n');
  assert.ok(!existsSync(s.at('projects', 'p', 'golden-queue', 'provision.sh')));
  assert.match(s.log(), /Started golden-p's rebuild with the fix \(vm:build-golden-start, [^)]+\), the queued provision\.sh written into its definition first\./);
  assert.ok(await until(() => existsSync(s.at('projects', 'p', 'golden-build-run.exit'))));
});

test('ASS-427 AC3: vm:golden-followup carries a queued change into a rebuild with no ticket waiting (control\'s run); a start the disk hold refuses leaves the entry waiting, logged once, for the next run', async () => {
  const s = await setup({ credentials: {} });
  mkdirSync(s.at('projects', 'p', 'golden-queue'), { recursive: true });
  writeFileSync(s.at('projects', 'p', 'golden-queue', 'images.txt'), 'registry.example.com/app:1@sha256:abc\n');
  writeFileSync(s.at('disk-space.json'), JSON.stringify({ level: 'hold', 'free-bytes': 1e9 }));
  const env = { ...s.env, DISK_SPACE_FILE: s.at('disk-space.json') };
  const held = JSON.parse((await run(AGENT, ['vm:golden-followup', 'p', 'ABC-3', 'A'], { env })).stdout);
  assert.deepEqual([held.started, held.waiting], [false, 1]);
  assert.deepEqual([s.followup()[0].build, s.followup()[0].refused], [null, true], 'left waiting');
  assert.match(s.log(), /golden-p's rebuild could not start yet: vm:build-golden-start: Disk nearly full[^\n]*It is tried again \(control, every minute\) until it starts; this ticket does not wait\./);
  await run(AGENT, ['vm:golden-followup', 'p'], { env });
  assert.equal(s.log().match(/could not start yet/g).length, 1, 'said once');
  assert.ok(!existsSync(s.at('projects', 'p', 'golden-build-run.json')), 'nothing started');
  assert.deepEqual(held.applied, ['images.txt'], 'the queue written whatever the start');
});
