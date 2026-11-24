// ASS-534 AC6, ASS-535: a project's sandbox image, built and kept on the Mac (its zot), reaches each cluster's own
// image registry (Substrate's atelet pulls a sandbox's image from a registry, never from the node) — the Mac's
// directly, a remote machine's through a forward over the harness's one SSH connection to it (substrate:deliver-image)
// — only when its digest changed, its digest kept. Against fake workstations and cloud VMs (fake-workstation.js: their
// sessions run here, their forwards no-ops, so the cluster registry — a fake OCI registry, fake-oci-registry.js, on
// HARNESS_SUBSTRATE_REGISTRY_PORT — answers on the same port for each) and a fake zot holding the pushed image.
// Every name here is generic.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, edit, ID } from './workstation-fixture.js';
import { fakeOciRegistry } from '../support/fake-oci-registry.js';

const VM = 'ada-vm';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const servers = [];
afterEach(async () => { await closeAll(); for (const s of servers.splice(0)) await s.close(); });

async function setup() {
  const s = wsFixture({ cloudVms: [VM] });
  const reg = await fakeOciRegistry(), cluster = await fakeOciRegistry();
  servers.push(reg, cluster);
  s.env.HARNESS_SUBSTRATE_REGISTRY_PORT = String(cluster.port);
  edit(s.at('projects', 'p', 'project.json'), p => {
    p.registry = { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: reg.port };
    p['golden-image'] = { folder: 'projects/p/golden-image' };
  });
  mkdirSync(s.at('projects', 'p', 'golden-image'), { recursive: true });
  writeFileSync(s.at('projects', 'p', 'golden-image', 'template.yaml'), 'vmType: vz\n');
  writeFileSync(s.at('projects', 'p', 'golden-image', 'provision.sh'), '#!/bin/bash\n');
  edit(s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].substrate = { clusters: [{ machine: ID }, { machine: VM }] }; });
  // build(n) — a new amd64 build of sandbox-p in zot, and its label, as substrate:build-image leaves them.
  const build = n => {
    const repo = '0local/sandbox/p';
    const config = reg.blob(repo, JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] }, build: n }));
    const layer = reg.blob(repo, `sandbox layer ${n}`);
    const tag = `amd64-${String(n).repeat(12)}`;
    const digest = reg.manifest(repo, tag, JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }] }), OCI_MANIFEST);
    writeFileSync(s.at('projects', 'p', 'sandbox-image-amd64.json'), JSON.stringify({ project: 'p', image: 'sandbox-p', arch: 'amd64', hash: String(n).repeat(64), digest, repository: repo, tag, ref: `127.0.0.1:${reg.port}/${repo}@${digest}` }));
    return { digest, tag };
  };
  // forwards(id) — the forwards of the cluster registry's port asked of the machine's master.
  const forwards = id => s.w.sshCalls().filter(c => c.argv.includes('-O') && c.argv.includes('forward') && c.argv.includes(`workstation-${id}`));
  const pushes = () => cluster.requests.filter(r => r.startsWith('PUT /v2/sandbox/p/manifests/')).length;
  const deliver = async (...ids) => { const r = await s.result('substrate:deliver-image', 'p', ...ids); return { ...r, json: r.out ? JSON.parse(r.out) : null }; };
  return { s, reg, cluster, build, forwards, pushes, deliver, deliveries: () => JSON.parse(readFileSync(s.at('projects', 'p', 'sandbox-deliveries.json'), 'utf8')) };
}

test('AC6, ASS-535: pushed into each connected machine\'s cluster registry through a forward over its SSH connection, its digest kept; only again once the digest changes; a machine not connected is skipped, never connected for it', async () => {
  const t = await setup();
  const one = t.build(1);
  assert.equal((await t.s.result('workstation:connect', 'p', ID)).code, 0);
  let r = await t.deliver();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.map(l => [l.machine, l.delivered, l.reason ?? null, l.digest]), [[ID, true, null, one.digest], [VM, false, 'not connected', one.digest]]);
  // The image in the cluster registry as sandbox/p, under its digest (what a template names) and its tag.
  assert.ok(t.cluster.get('sandbox/p', one.digest), 'the digest kept');
  assert.ok(t.cluster.get('sandbox/p', one.tag));
  assert.equal(t.forwards(ID).length, 1, 'over the master (-O forward)');
  assert.ok(t.forwards(ID)[0].argv.includes('-S'));
  assert.ok(t.forwards(ID)[0].argv.includes(`127.0.0.1:${t.cluster.port}:127.0.0.1:${t.cluster.port}`));
  assert.deepEqual(t.deliveries()[ID], { arch: 'amd64', digest: one.digest, ref: `sandbox/p@${one.digest}`, 'delivered-at': t.deliveries()[ID]['delivered-at'] });
  assert.equal(t.forwards(VM).length, 0);
  assert.ok(!t.s.w.gcloudCalls().some(c => JSON.stringify(c).includes(VM)), 'nothing connects or starts the machine');
  // The same digest: nothing crosses the link again. The cloud VM, now connected, gets it.
  assert.equal((await t.s.result('workstation:connect', 'p', VM)).code, 0);
  r = await t.deliver();
  assert.deepEqual(r.json.map(l => [l.machine, l.delivered, l.reason ?? null]), [[ID, false, 'current'], [VM, true, null]]);
  assert.equal(t.forwards(ID).length, 1);
  // A new build: each machine gets it once.
  const two = t.build(2);
  r = await t.deliver();
  assert.deepEqual(r.json.map(l => [l.machine, l.delivered, l.digest]), [[ID, true, two.digest], [VM, true, two.digest]]);
  r = await t.deliver(ID);
  assert.deepEqual(r.json.map(l => [l.machine, l.delivered, l.reason]), [[ID, false, 'current']]);
  assert.equal(t.pushes(), 4);
});

test('AC6, ASS-535: only the clusters dev-environments.substrate.clusters names get the image — the Mac\'s too, with the Mac\'s architecture; with none named, none', async () => {
  const t = await setup();
  t.build(1);
  edit(t.s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].substrate = { clusters: [] }; });
  for (const id of [ID, VM]) assert.equal((await t.s.result('workstation:connect', 'p', id)).code, 0);
  const none = await t.deliver();
  assert.equal(none.code, 0, none.err);
  assert.deepEqual(none.json, []);
  assert.match(none.err, /names no cluster: none to deliver to/);
  edit(t.s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].substrate = { clusters: [{ machine: 'mac' }, { machine: VM }] }; });
  const r = await t.deliver();
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  // The Mac's arm64 image is not built: said, and the cloud VM's delivered all the same.
  assert.deepEqual(r.json.map(l => [l.machine, l.arch, l.delivered, l.reason ?? null]), [['mac', arch, arch === 'amd64', arch === 'amd64' ? null : 'no image'], [VM, 'amd64', true, null]]);
  assert.equal(r.code, arch === 'amd64' ? 0 : 1);
  assert.equal(t.forwards(ID).length, 0);
  // A cluster on the workstation too (listed after the cloud VM's): it gets the image; the cloud VM has it already.
  edit(t.s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].substrate.clusters = [{ machine: VM }, { machine: ID }]; });
  const again = await t.deliver();
  assert.deepEqual(again.json.map(l => [l.machine, l.delivered, l.reason ?? null]), [[VM, false, 'current'], [ID, true, null]]);
});

test('AC6: a failed push is said and not recorded, the next run tries again; no image built for amd64 is refused', async () => {
  const t = await setup();
  assert.equal((await t.s.result('workstation:connect', 'p', ID)).code, 0);
  let r = await t.deliver(ID);
  assert.equal(r.code, 1);
  assert.match(r.err, /sandbox-p has no amd64 image to deliver: build it \(substrate:build-image p --arch amd64\)/);
  t.build(1);
  const port = t.s.env.HARNESS_SUBSTRATE_REGISTRY_PORT;
  t.s.env.HARNESS_SUBSTRATE_REGISTRY_PORT = '9';   // nothing listens: the push fails
  r = await t.deliver(ID);
  assert.equal(r.code, 1);
  assert.match(r.err, /sandbox-p \(amd64\) could not be put into ada-dev's cluster registry; the next run tries again/);
  assert.deepEqual(r.json.map(l => [l.machine, l.delivered, l.reason]), [[ID, false, 'failed']]);
  assert.equal(t.deliveries()[ID], undefined);
  t.s.env.HARNESS_SUBSTRATE_REGISTRY_PORT = port;
  r = await t.deliver(ID);
  assert.deepEqual([r.code, r.json[0].delivered], [0, true]);
});
