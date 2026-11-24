// substrate:up, health, down and load-image on the Mac (ASS-533 AC1, AC2, AC4, AC6, AC8): against a fake Mac
// (test/support/fake-substrate.js: its docker, and a kit of fake kind, kubectl, kubectl-ate and ate-setup that keep
// the cluster in Docker's data-root), with a fake HOME holding the operator's own ~/.kube/config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, AGENT } from './harness-fixture.js';
import { fakeSubstrateMachine, putKit } from '../support/fake-substrate.js';

const run = promisify(execFile);
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const KUBE = 'apiVersion: v1\nclusters:\n- cluster: { server: https://prod.example.com }\n  name: prod\ncontexts:\n- context: { cluster: prod, user: ops }\n  name: prod\ncurrent-context: prod\nkind: Config\n';

// mac({ entries, projects }) — projects p (and q) with dev-environments.substrate `entries`, on a fake Mac whose HOME
// holds the operator's ~/.kube/config and the kit, already built.
function mac({ entries = [{ machine: 'mac' }], projects = ['p'], env: extra = {} } = {}) {
  const f = fixture();
  for (const p of projects) edit(join(f.dir, 'projects', p, 'project.json'), j => { j['dev-environments'] = { substrate: { clusters: entries } }; });
  const home = mkdtempSync(join(tmpdir(), 'mac-home-'));
  mkdirSync(join(home, '.kube'));
  writeFileSync(join(home, '.kube', 'config'), KUBE, { mode: 0o600 });
  const m = fakeSubstrateMachine(mkdtempSync(join(tmpdir(), 'mac-')), { memory: 38 * 1024 ** 3 });
  putKit(join(home, '.harness', 'substrate'));
  const log = join(m.dir, 'substrate.log');
  const env = { ...f.env, HOME: home, PATH: `${m.bin}:${f.env.PATH}`, FAKE_SUBSTRATE_LOG: log, HARNESS_SUBSTRATE_GRACE: '0', ...extra };
  const cli = (...args) => run(AGENT, args, { env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr, json: last(r.stdout) }), e => ({ code: e.code, out: e.stdout, err: e.stderr, json: last(e.stdout) }));
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const live = (p = 'p') => JSON.parse(readFileSync(join(f.dir, 'projects', p, 'substrate.json'), 'utf8'));
  return { f, home, m, env, cli, calls, live, kubeconfig: (p = 'p') => join(home, '.harness', 'substrate', p, 'mac.kubeconfig') };
}
const last = out => { try { return JSON.parse(String(out ?? '').trim().split('\n').pop()); } catch { return null; } };

test('AC2: substrate:up on the Mac creates the kind cluster, installs the pinned release from published images and makes the project\'s workers; a rerun changes nothing', async () => {
  const s = mac();
  const r = await s.cli('substrate:up', 'p');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.cluster, 'harness-substrate');
  assert.equal(r.json.kubeconfig, s.kubeconfig());
  assert.equal(r.json.release, 'v1.0.1');
  const did = r.json.did.join('\n');
  assert.match(did, /created the kind cluster harness-substrate \(kindest\/node:v1\.37\.0\)/);
  assert.match(did, /set proxy ARP/);
  assert.match(did, /installed Substrate v1\.0\.1 from ghcr\.io\/agent-substrate\/substrate/);
  assert.match(did, /applied p's namespace and WorkerPool harness-p/);
  assert.match(did, /created p's atespace harness-p/);
  // The kit installed under ~/.harness/substrate, the kind node pinned by digest, ate-setup from published images.
  assert.ok(existsSync(join(s.home, '.harness', 'substrate', 'kit', 'current', 'bin', 'ate-setup')));
  assert.match(readFileSync(join(s.m.node(), 'image'), 'utf8'), /^kindest\/node:v1\.37\.0@sha256:[0-9a-f]{64}/);
  const setup = s.calls().find(c => c.tool === 'ate-setup').argv;
  for (const [flag, value] of [['--image-repo', 'ghcr.io/agent-substrate/substrate'], ['--image-tag', 'v1.0.1'], ['--kubeconfig', s.kubeconfig()], ['--context', 'kind-harness-substrate']]) assert.equal(setup[setup.indexOf(flag) + 1], value, flag);
  assert.ok(setup.includes('--sandbox-classes=gvisor'));
  const pool = JSON.parse(readFileSync(join(s.m.k8s(), 'ns', 'harness-p', 'workerpool-harness-p.json'), 'utf8'));
  assert.match(pool.spec.workerImage, /^ghcr\.io\/agent-substrate\/substrate\/ateworker-gvisor:v1\.0\.1@sha256:[0-9a-f]{64}$/);
  assert.equal(pool.spec.replicas, 1);
  assert.deepEqual(pool.spec.template.resources.limits, { cpu: '4', memory: '4096Mi' });
  assert.equal(s.live().mac.up.ok, true);
  // Idempotent: nothing to do the second time, and ate-setup not run again.
  const before = s.calls().length;
  const again = await s.cli('substrate:up', 'p');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.json.did, []);
  assert.equal(s.calls().slice(before).filter(c => c.tool === 'ate-setup' || (c.tool === 'kind' && c.argv[0] === 'create')).length, 0);
});

test('AC2: a new pinned release upgrades the cluster; another Mac project shares the cluster with workers and a kubeconfig of its own', async () => {
  const s = mac({ projects: ['p', 'q'] });
  assert.equal((await s.cli('substrate:up', 'p')).code, 0);
  writeFileSync(join(s.home, '.harness', 'substrate', 'clusters', 'harness-substrate', 'installed'), 'ghcr.io/agent-substrate/substrate v1.0.0\n');
  const up = await s.cli('substrate:up', 'p');
  assert.equal(up.code, 0, up.err);
  assert.match(up.json.did.join('\n'), /upgraded Substrate from v1\.0\.0 to v1\.0\.1/);
  const q = await s.cli('substrate:up', 'q');
  assert.equal(q.code, 0, q.err);
  assert.doesNotMatch(q.json.did.join('\n'), /created the kind cluster|installed Substrate/);
  assert.match(q.json.did.join('\n'), /applied q's namespace and WorkerPool harness-q/);
  assert.ok(existsSync(s.kubeconfig('q')));
  assert.ok(existsSync(join(s.m.k8s(), 'ns', 'harness-q', 'workerpool-harness-q.json')));
});

test('AC8: substrate:up, health and teardown never read or write ~/.kube/config — it stays byte for byte, its current context too — and every call gets the cluster\'s own kubeconfig under ~/.harness', async () => {
  const s = mac();
  const file = join(s.home, '.kube', 'config'), mtime = statSync(file).mtimeMs;
  assert.equal((await s.cli('substrate:up', 'p')).code, 0);
  assert.equal((await s.cli('substrate:health', 'p')).json.state, 'healthy');
  const down = await s.cli('substrate:down', 'p');
  assert.equal(down.code, 0, down.err);
  assert.match(down.json.did.join('\n'), /deleted the kind cluster harness-substrate/);
  assert.equal(readFileSync(file, 'utf8'), KUBE);
  assert.equal(statSync(file).mtimeMs, mtime);
  const calls = s.calls();
  assert.ok(calls.length > 10);
  for (const c of calls) {
    assert.equal(c['default-kubeconfig'], false, `${c.tool} ${c.argv.join(' ')} fell back to ~/.kube/config`);
    if (c.tool === 'kind' && ['get', 'load'].includes(c.argv[0])) continue;   // kind get kubeconfig prints, kind load needs none
    assert.equal(c.kubeconfig, s.kubeconfig(), `${c.tool} ${c.argv.join(' ')}`);
    assert.ok(c.kubeconfig.startsWith(join(s.home, '.harness') + '/'));
  }
  assert.equal(existsSync(s.kubeconfig()), false, 'its kubeconfig file goes with the teardown');
  // And the fakes do write ~/.kube/config when not given a kubeconfig (so the check means something).
  const env = { ...s.env, PATH: `${join(s.home, '.harness', 'substrate', 'kit', 'current', 'bin')}:${s.env.PATH}` };
  await run('kind', ['create', 'cluster', '--name', 'other'], { env });
  assert.notEqual(readFileSync(file, 'utf8'), KUBE);
});

test('AC1: a GKE entry is accepted but refused at setup until GKE is approved; a machine the project does not have is refused naming the field', async () => {
  const s = mac({ entries: [{ machine: 'mac' }, { machine: 'gke', 'gcp-project': 'example-gcp', location: 'europe-west1-b', cluster: 'harness' }] });
  const r = await s.cli('substrate:up', 'p', 'gke');
  assert.equal(r.code, 2);
  assert.match(r.err, /GKE is not approved yet/);
  assert.equal(s.live().gke.state, 'refused');
  assert.equal(s.calls().length, 0, 'nothing ran for it');
  const none = await s.cli('substrate:up', 'p', 'ada-dev');
  assert.equal(none.code, 1);
  assert.match(none.err, /no substrate entry for machine 'ada-dev'/);
  edit(join(s.f.dir, 'projects', 'p', 'project.json'), j => { j['dev-environments'].substrate.clusters.push({ machine: 'ada-dev', 'warm-workers': -1 }); });
  const bad = await s.cli('substrate:up', 'p');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /dev-environments\.substrate\.clusters\[2\]\.machine "ada-dev" is not "mac", "gke" nor one of the project's workstations or cloud VMs/);
  assert.match(bad.err, /dev-environments\.substrate\.clusters\[2\]\.warm-workers is not a whole number from 0 to 32/);
});

test('AC4, AC6: substrate:health finds pods, rustfs, postgres, workers, the template\'s golden snapshot and the host\'s Docker memory, each named, and says which a restart fixes', async () => {
  const s = mac();
  assert.equal((await s.cli('substrate:up', 'p')).code, 0);
  let h = (await s.cli('substrate:health', 'p')).json;
  assert.equal(h.state, 'healthy');
  assert.deepEqual(h.problems, []);
  assert.equal(h.docker['memory-bytes'], 38 * 1024 ** 3);
  assert.equal(h.usage.sandboxes, 0);
  assert.equal(h.node.running, true);
  assert.equal(s.live().mac.state, 'healthy');
  assert.equal(s.live().mac.up.ok, true, 'the health record keeps the last up');
  for (const what of ['rustfs', 'postgres', 'pod', 'workers']) s.m.broken(what);
  h = (await s.cli('substrate:health', 'p')).json;
  assert.equal(h.state, 'broken');
  const by = Object.fromEntries(h.problems.map(p => [p.what, p]));
  assert.match(by.rustfs.why, /no endpoints available for service "rustfs"/);
  assert.match(by.postgres.why, /pg_isready/);
  assert.match(by.pods.why, /ate-system\/ate-controller-1 is not ready \(CrashLoopBackOff\)/);
  assert.match(by.workers.why, /0 of 1 workers ready/);
  assert.ok(h.problems.every(p => p.repair));
  for (const what of ['rustfs', 'postgres', 'pod', 'workers']) s.m.broken(what, false);
  // Templates: one with its golden snapshot, one whose build failed, one stuck past the grace (why from ate-api-server's log); an active sandbox counted.
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  writeFileSync(join(s.m.k8s(), 'templates-harness-p.json'), JSON.stringify({ actorTemplates: [
    { metadata: { name: 'ok', createTime: iso(now - 3600e3) }, status: { goldenSnapshotStatus: { goldenTag: { name: 'tag-1' } } } },
    { metadata: { name: 'failed', createTime: iso(now - 60e3) }, status: { goldenSnapshotStatus: { errorMessage: 'ImagePull: not pinned by digest' } } },
    { metadata: { name: 'big', createTime: iso(now - 3600e3) }, status: {} },
    { metadata: { name: 'new', createTime: iso(now - 30e3) }, status: {} },
  ] }));
  writeFileSync(join(s.m.k8s(), 'api-server.log'), `${JSON.stringify({ level: 'ERROR', msg: 'Failed to reconcile actor template, requeueing', template: { atespace: 'harness-p', name: 'big' }, err: 'while resuming golden actor: no worker has room for the actor' })}\n`);
  writeFileSync(join(s.m.k8s(), 'actors-harness-p.json'), JSON.stringify({ actors: [{ status: { state: 'ACTOR_STATE_RUNNING' } }, { status: { state: 'ACTOR_STATE_SUSPENDED' } }] }));
  h = (await s.cli('substrate:health', 'p')).json;
  assert.equal(h.state, 'broken');
  assert.deepEqual(h.problems.map(p => [p.what, p.repair]), [['templates', false], ['templates', false]]);
  assert.match(h.problems[0].why, /template failed has no golden snapshot: ImagePull: not pinned by digest/);
  assert.match(h.problems[1].why, /template big has had no golden snapshot for 60 minutes; ate-api-server says: while resuming golden actor: no worker has room for the actor/);
  assert.equal(h.usage.sandboxes, 1, 'only the running sandbox is active');
  rmSync(join(s.m.k8s(), 'templates-harness-p.json'));
  // Docker's memory: too small for the cluster (Docker Desktop's setting named), then Docker down.
  writeFileSync(join(s.m.dir, 'docker-memory'), String(2 * 1024 ** 3));
  h = (await s.cli('substrate:health', 'p')).json;
  assert.deepEqual(h.problems.map(p => [p.what, p.repair]), [['docker memory', false]]);
  assert.match(h.problems[0].why, /Docker has 2\.0 GiB, the cluster needs at least 3\.5 GiB \(Docker Desktop: Settings, Resources, Memory\)/);
  writeFileSync(join(s.m.dir, 'docker-stopped'), '');
  h = (await s.cli('substrate:health', 'p')).json;
  assert.equal(h.state, 'docker-down');
  assert.equal(h.problems[0].repair, false);
});

test('AC4: a node stopped is broken, then a restart (substrate:up, repair) starts it and sets its proxy ARP; a cluster gone is missing; a node just started is starting', async () => {
  const s = mac({ env: { HARNESS_SUBSTRATE_GRACE: '300' } });
  assert.equal((await s.cli('substrate:up', 'p')).code, 0);
  await run('docker', ['stop', 'harness-substrate-control-plane'], { env: s.env });
  let h = (await s.cli('substrate:health', 'p')).json;
  assert.equal(h.state, 'broken');
  assert.deepEqual(h.problems.map(p => [p.what, p.repair]), [['node', true]]);
  const up = await run(AGENT, ['substrate:up', 'p'], { env: { ...s.env, HARNESS_SUBSTRATE_REPAIR: '1' } }).then(r => last(r.stdout));
  assert.match(up.did.join('\n'), /started the cluster's node harness-substrate-control-plane/);
  assert.match(up.did.join('\n'), /set proxy ARP/);
  s.m.broken('pod');
  h = (await s.cli('substrate:health', 'p')).json;
  assert.equal(h.state, 'starting', 'a pod not ready yet within the grace after the node started');
  s.m.broken('pod', false);
  rmSync(s.m.node(), { recursive: true });
  h = (await s.cli('substrate:health', 'p')).json;
  assert.equal(h.state, 'missing');
  assert.deepEqual(h.problems.map(p => [p.what, p.repair]), [['cluster', true]]);
});

test('substrate:down keeps the Mac\'s shared cluster while another project uses it, deletes it with the last; load-image loads an archive into the node', async () => {
  const s = mac({ projects: ['p', 'q'] });
  assert.equal((await s.cli('substrate:up', 'p')).code, 0);
  assert.equal((await s.cli('substrate:up', 'q')).code, 0);
  const archive = join(s.m.dir, 'image.tar');
  writeFileSync(archive, 'an image archive from docker save');
  const load = await s.cli('substrate:load-image', 'p', 'mac', archive);
  assert.equal(load.code, 0, load.err);
  assert.match(load.json.did[0], /loaded an image archive \(33 bytes\) into harness-substrate-control-plane/);
  assert.match(readFileSync(join(s.m.k8s(), 'images'), 'utf8'), /^33 an image archive/);
  const p = await s.cli('substrate:down', 'p');
  assert.equal(p.code, 0, p.err);
  assert.match(p.json.did.join('\n'), /kept the kind cluster harness-substrate: other projects use it \(harness-q\)/);
  assert.ok(existsSync(s.m.node()));
  assert.equal(existsSync(join(s.m.k8s(), 'ns', 'harness-p')), false);
  assert.equal(s.live('p').mac, undefined);
  const q = await s.cli('substrate:down', 'q');
  assert.equal(q.code, 0, q.err);
  assert.match(q.json.did.join('\n'), /deleted the kind cluster harness-substrate/);
  assert.equal(existsSync(s.m.node()), false);
});

test('AC4: project:credentials-status lists what the project\'s clusters need without holding its work', async () => {
  const s = mac({ entries: [{ machine: 'mac' }, { machine: 'gke', 'gcp-project': 'example-gcp', location: 'europe-west1-b', cluster: 'harness' }] });
  writeFileSync(join(s.m.dir, 'docker-stopped'), '');
  const env = { ...s.env, GH_DISABLED: '1', GLAB_DISABLED: '1' };
  const out = JSON.parse((await run(AGENT, ['project:check-credentials', 'p'], { env })).stdout);
  assert.equal(out.held, false);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.substrate.problems.map(p => [p.machine, p.credential]), [['mac', 'Docker on the Mac'], ['gke', 'GKE']]);
  assert.equal(out.substrate.problems[0].fix, 'open -a Docker');
  assert.deepEqual(JSON.parse((await run(AGENT, ['project:credentials-status', 'p'], { env })).stdout).substrate, out.substrate);
  // A project with no cluster prints exactly as before.
  edit(join(s.f.dir, 'projects', 'p', 'project.json'), j => { delete j['dev-environments']; });
  assert.deepEqual(JSON.parse((await run(AGENT, ['project:check-credentials', 'p'], { env })).stdout), { held: false, since: null, problems: [] });
});
