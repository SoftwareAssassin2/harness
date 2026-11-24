// A project's Substrate cluster on its workstation or cloud VM (ASS-533 AC2, AC3, AC6, AC7, AC8): substrate:up over the
// machine's one SSH connection, and workstation:setup re-applying what it keeps outside /home at every start — against
// fake workstations and cloud VMs (test/support/fake-workstation.js: a folder each, its home the /home that survives)
// whose Docker is fake-substrate.js's (containers kept in its data-root, its outside-/home files under a fake root).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { wsFixture, closeAll, edit, ID } from './workstation-fixture.js';
import { fakeSubstrateMachine, putKit } from '../support/fake-substrate.js';

after(closeAll);
const last = out => { try { return JSON.parse(String(out ?? '').trim().split('\n').pop()); } catch { return null; } };

// remote({ cloud, dataRoot, dockerdArgs }) — project p with a Substrate cluster on its running workstation ada-dev (or,
// cloud, its cloud VM vm-1), connected; Docker's data-root at a fresh start `dataRoot` ('home': under /home, as Google's
// workstation images have it; 'outside': /var/lib/docker), dockerd's command line `dockerdArgs`.
async function remote({ cloud = false, dataRoot = 'home', dockerdArgs = '/usr/bin/dockerd -p /var/run/docker.pid' } = {}) {
  const s = cloud ? wsFixture({ mode: 'workstation', ids: [], cloudVms: ['vm-1'] }) : wsFixture();
  const id = cloud ? 'vm-1' : ID;
  edit(s.at('projects', 'p', 'project.json'), j => { j['dev-environments'].substrate = { clusters: [{ machine: id }] }; });
  const dir = dirname(s.w.system(id));
  const m = fakeSubstrateMachine(dir, { persist: s.w.home(id), defaultRoot: dataRoot === 'home' ? join(s.w.home(id), '.docker_data') : join(dir, 'root', 'var', 'lib', 'docker') });
  putKit(join(s.env.HOME, '.harness', 'substrate'));
  Object.assign(s.env, m.env, { HARNESS_SUBSTRATE_DOCKERD_ARGS: dockerdArgs, HARNESS_SUBSTRATE_GRACE: '0', FAKE_SUBSTRATE_LOG: join(dir, 'substrate.log') });
  await s.cli('workstation:connect', 'p', id);
  const call = (...args) => s.result(...args).then(r => ({ ...r, json: last(r.out) }));
  const live = () => JSON.parse(readFileSync(s.at('projects', 'p', 'substrate.json'), 'utf8'))[id];
  const outside = () => ({
    daemon: existsSync(join(m.root, 'etc', 'docker', 'daemon.json')) ? JSON.parse(readFileSync(join(m.root, 'etc', 'docker', 'daemon.json'), 'utf8')) : null,
    watches: readFileSync(join(m.root, 'proc', 'sys', 'fs', 'inotify', 'max_user_watches'), 'utf8').trim(),
    instances: readFileSync(join(m.root, 'proc', 'sys', 'fs', 'inotify', 'max_user_instances'), 'utf8').trim(),
    dataRoot: m.dataRoot(),
    node: existsSync(m.node()) ? readFileSync(join(m.node(), 'state'), 'utf8').trim() : null,
    proxyArp: existsSync(m.node()) ? readFileSync(join(m.node(), 'proxy_arp'), 'utf8').trim() : null,
  });
  // restart() — the machine restarted: stopped (its connection drops), everything outside /home reset, started again by
  // connect (a new boot id).
  const restart = async () => {
    const was = s.entry(id).setup?.['checked-at'];
    s.w.setState?.(id, 'STATE_STOPPED');
    if (cloud) s.w.setStatus(id, 'TERMINATED');
    m.restart();
    for (let i = 0; i < 50 && existsSync(join(s.w.harnessHome, 'workstations', `p-${id}.sock`)); i++) await new Promise(r => setTimeout(r, 100));
    while (was && new Date().toISOString().slice(0, 19) + 'Z' <= was) await new Promise(r => setTimeout(r, 50));
    await s.cli('workstation:connect', 'p', id);
  };
  return { s, id, m, call, live, outside, restart, home: s.w.home(id) };
}

test('AC2: substrate:up on a workstation over its SSH connection sends the kit once, makes the cluster there with its kubeconfig under the workstation\'s ~/.harness, and a rerun changes nothing', async () => {
  const r = await remote();
  const up = await r.call('substrate:up', 'p', r.id);
  assert.equal(up.code, 0, up.err);
  assert.match(up.err, /sending the Substrate kit [0-9a-f]{12} \(darwin-arm64|linux-amd64/);
  assert.equal(up.json.kubeconfig, join(r.home, '.harness', 'substrate', 'p', `${r.id}.kubeconfig`));
  assert.ok(existsSync(up.json.kubeconfig));
  const did = up.json.did.join('\n');
  assert.match(did, /created the kind cluster harness-substrate/);
  assert.match(did, /installed Substrate v1\.0\.1/);
  assert.match(did, /raised fs\.inotify\.max_user_watches from 129254 to 524288/);
  assert.match(did, /raised fs\.inotify\.max_user_instances from 128 to 512/);
  assert.ok(r.m.dataRoot().startsWith(r.home), 'Docker\'s data-root was under /home already: left as it is');
  assert.equal(r.outside().daemon, null);
  assert.ok(existsSync(join(r.home, '.harness', 'substrate', 'kit', 'current', 'bin', 'kind')), 'the kit lives under /home');
  assert.equal(existsSync(join(r.s.env.HOME, '.harness', 'substrate', 'p')), false, 'nothing of the cluster\'s on the Mac');
  assert.equal(r.live().up.ok, true);
  const again = await r.call('substrate:up', 'p', r.id);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.json.did, []);
  assert.doesNotMatch(again.err, /sending the Substrate kit/);
  const h = await r.call('substrate:health', 'p', r.id);
  assert.equal(h.json.state, 'healthy');
  assert.equal(h.json.host, 'workstation');
  assert.equal(h.json['host-available-bytes'], 12 * 1024 ** 3);
});

test('AC3, AC7: on a workstation whose Docker keeps its data outside /home, setup moves its data-root under /home; after a restart (all but /home reset) setup re-applies it, and the cluster and its hibernated sandboxes are found again', async () => {
  const r = await remote({ dataRoot: 'outside' });
  const up = await r.call('substrate:up', 'p', r.id);
  assert.equal(up.code, 0, up.err);
  assert.match(up.json.did.join('\n'), /moved Docker's data-root to .*\/home\/\.docker_data/);
  assert.ok(r.m.dataRoot().startsWith(r.home));
  assert.ok(r.m.node().startsWith(r.home), 'the cluster\'s node and its /var (postgres, rustfs, snapshots) under /home');
  // A hibernated sandbox: a suspended actor and its snapshot, kept in the cluster's state.
  const k8s = r.m.k8s();
  writeFileSync(join(k8s, 'actors-harness-p.json'), JSON.stringify({ actors: [{ metadata: { name: 'ABC-3-A' }, status: { state: 'ACTOR_STATE_SUSPENDED' } }] }));
  mkdirSync(join(k8s, 'snapshots'), { recursive: true });
  writeFileSync(join(k8s, 'snapshots', 'ABC-3-A.zst'), 'memory and files');
  // AC7: setup twice — the second changes nothing of Substrate's.
  const first = JSON.parse((await r.s.cli('workstation:setup', 'p', r.id)).stdout).setup;
  assert.equal(first.ok, true, JSON.stringify(first.failed));
  assert.ok(first.did.includes(`installed the Substrate host setup (${join(r.home, 'harness', 'lib', 'substrate.sh')})`));
  const settled = r.outside();
  assert.deepEqual(settled, { daemon: { 'data-root': join(r.home, '.docker_data') }, watches: '524288', instances: '512', dataRoot: join(r.home, '.docker_data'), node: 'true', proxyArp: '1' });
  const second = JSON.parse((await r.s.cli('workstation:setup', 'p', r.id)).stdout).setup;
  assert.deepEqual(second.did.filter(d => /Substrate/.test(d)), []);
  assert.deepEqual(r.outside(), settled);
  // The restart: daemon.json gone, Docker back on /var/lib/docker, the inotify limits low, the node stopped.
  await r.restart();
  assert.equal(r.outside().daemon, null);
  assert.ok(!r.m.dataRoot().startsWith(r.home));
  const fresh = JSON.parse((await r.s.cli('workstation:setup', 'p', r.id)).stdout).setup;
  assert.equal(fresh.ok, true, JSON.stringify(fresh.failed));
  const said = fresh.did.filter(d => /^Substrate: /.test(d)).join('\n');
  assert.match(said, /moved Docker's data-root/);
  assert.match(said, /raised fs\.inotify\.max_user_watches/);
  assert.match(said, /started the cluster's node harness-substrate-control-plane \(it had stopped: the machine or Docker restarted\)/);
  assert.match(said, /set proxy ARP/);
  assert.deepEqual(r.outside(), settled, 'a freshly reset workstation ends exactly as the first setup left it');
  // The cluster and the hibernated sandbox are there.
  const h = await r.call('substrate:health', 'p', r.id);
  assert.equal(h.json.state, 'healthy', JSON.stringify(h.json.problems));
  assert.equal(readFileSync(join(r.m.k8s(), 'snapshots', 'ABC-3-A.zst'), 'utf8'), 'memory and files');
  assert.match(readFileSync(join(r.m.k8s(), 'actors-harness-p.json'), 'utf8'), /ACTOR_STATE_SUSPENDED/);
  assert.equal(h.json.usage.sandboxes, 0, 'hibernated: not active');
  // Nothing about how the workstation is stood up was touched: gcloud was only asked to describe, start and ssh.
  assert.deepEqual([...new Set(r.s.w.gcloudCalls().map(c => c.argv?.[1] ?? c[1]))].filter(v => !['describe', 'start', 'ssh'].includes(v)), []);
});

test('AC7: a workstation whose own config starts dockerd with --data-root outside /home fails setup, named, and is left as it is', async () => {
  const r = await remote({ dataRoot: 'outside', dockerdArgs: '/usr/bin/dockerd --data-root /var/lib/docker' });
  const up = await r.call('substrate:up', 'p', r.id);
  assert.equal(up.code, 1);
  assert.match(up.err, /docker data-root: Docker keeps its data in .*\/var\/lib\/docker, outside .*, and the workstation's own config starts dockerd with --data-root, which the harness does not change/);
  assert.equal(r.outside().daemon, null);
  assert.deepEqual(r.m.sudoCalls().filter(c => /docker|daemon/.test(c)), []);
  const setup = await r.s.result('workstation:setup', 'p', r.id);
  assert.equal(setup.code, 1);
  assert.match(setup.err, /Substrate docker data-root/);
});

test('a cloud VM keeps its whole disk: its Docker data-root is left where it is; its cluster comes up over IAP like a workstation\'s; health without a connection checks nothing', async () => {
  const r = await remote({ cloud: true, dataRoot: 'outside' });
  const up = await r.call('substrate:up', 'p', r.id);
  assert.equal(up.code, 0, up.err);
  assert.doesNotMatch(up.json.did.join('\n'), /data-root/);
  assert.equal(r.outside().daemon, null);
  assert.equal((await r.call('substrate:health', 'p', r.id)).json.host, 'cloud-vm');
  // Before its idle disconnect, control stops the node so the VM's own idle check can pass; the next setup starts it.
  const stop = await r.call('substrate:stop', 'p', r.id);
  assert.equal(stop.code, 0, stop.err);
  assert.match(stop.json.did[0], /stopped the cluster's node harness-substrate-control-plane \(its state kept: the next setup starts it\)/);
  assert.equal(r.outside().node, 'false');
  const setup = JSON.parse((await r.s.cli('workstation:setup', 'p', r.id)).stdout).setup;
  assert.ok(setup.did.some(d => /^Substrate: started the cluster's node/.test(d)), JSON.stringify(setup.did));
  assert.equal(r.outside().node, 'true');
  await r.s.cli('workstation:disconnect', 'p', r.id);
  const h = await r.call('substrate:health', 'p', r.id);
  assert.equal(h.code, 3);
  assert.equal(r.live().state, 'not-connected');
});

test('AC8: on a remote machine too, ~/.kube/config is never read or written: every call is given the cluster\'s own kubeconfig', async () => {
  const r = await remote();
  mkdirSync(join(r.home, '.kube'), { recursive: true });
  writeFileSync(join(r.home, '.kube', 'config'), 'current-context: theirs\n');
  assert.equal((await r.call('substrate:up', 'p', r.id)).code, 0);
  assert.equal((await r.call('substrate:health', 'p', r.id)).json.state, 'healthy');
  assert.equal((await r.call('substrate:down', 'p', r.id)).code, 0);
  assert.equal(readFileSync(join(r.home, '.kube', 'config'), 'utf8'), 'current-context: theirs\n');
  const calls = readFileSync(join(r.m.dir, 'substrate.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(calls.every(c => c['default-kubeconfig'] === false));
  assert.ok(calls.filter(c => c.tool !== 'kind' || c.argv[0] === 'create' || c.argv[0] === 'delete').every(c => c.kubeconfig === join(r.home, '.harness', 'substrate', 'p', `${r.id}.kubeconfig`)));
});
