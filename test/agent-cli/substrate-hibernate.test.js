// ASS-537: a Substrate sandbox hibernates when its ticket gives up its seat and resumes when it gets one — the commands'
// side, on a fake Mac cluster (fake-substrate.js). substrate:sandbox-stop suspends the sandbox (never deletes it): its
// files, its forwarder token's binding and its egress rule set are kept (ASS-536: only substrate:sandbox-delete revokes
// and removes them); substrate:health then measures it at no memory or CPU, and counts what it keeps — its snapshots'
// disk, the node's disk, the WorkerPool's warm workers' memory requests (AC3); substrate:sandbox-up resumes it as it was:
// not made again, nothing brought in (AC2). Control's side (when) is test/control/sandbox-hibernation.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxed } from './sandbox-fixture.js';

test('AC1, AC2, AC3: on the Mac\'s cluster — sandbox-stop hibernates the sandbox (suspended, not deleted; its files, forwarder binding and egress kept); health measures it at no memory and counts its snapshot\'s disk, the node\'s disk and the warm workers\' requests; sandbox-up resumes it as it was', async () => {
  const t = await sandboxed();
  const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(up.code, 0, up.err);
  assert.equal(up.json.created, true);
  const name = up.json.machine;
  // Work left in it: a file in its home and one in its checkout.
  const wrote = await t.inMachine(name, 'mkdir -p "$HARNESS_VM_ROOT/home/agent" && echo kept > "$HARNESS_VM_ROOT/home/agent/notes.txt" && echo wip > "$HARNESS_VM_ROOT/repos/harness/wip.txt"');
  assert.equal(wrote.code, 0, wrote.err);
  const binding = t.s.tokens()[name];
  assert.ok(binding, 'its forwarder binding');
  const egress = join(t.m.k8s(), 'egress-harness-p-abc-3-a.json');
  assert.ok(existsSync(egress), 'its egress policy');

  // AC1: hibernated — suspended, its actor still there; its record stopped; nothing of it revoked or removed.
  const stop = await t.call('substrate:sandbox-stop', 'p', 'ABC-3', 'A');
  assert.equal(stop.code, 0, stop.err);
  assert.equal(stop.json.stopped, true);
  assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_SUSPENDED');
  assert.deepEqual(t.s.variation('A').sandbox.state, 'stopped');
  assert.deepEqual(t.s.tokens()[name], binding, 'its token binding is not revoked on hibernate (only on delete)');
  assert.ok(existsSync(egress), 'its egress rules stay');
  assert.ok(existsSync(join(t.root('abc-3-a'), 'home', 'agent', 'notes.txt')), 'its files stay');

  // AC3: what a hibernated sandbox keeps, measured — its snapshot on the node (fake: 300 MB), its atespace's golden
  // snapshot (1 MB), the node's disk, and the WorkerPool (one warm worker, 256Mi requested).
  mkdirSync(join(t.m.k8s(), 'snapshots'), { recursive: true });
  writeFileSync(join(t.m.k8s(), 'snapshots', 'actor-uid-abc-3-a'), '300000000');
  writeFileSync(join(t.m.k8s(), 'snapshots', 'tags-harness-p'), '1000000');
  writeFileSync(join(t.m.k8s(), 'disk'), '400000000000 250000000000');
  const health = await t.call('substrate:health', 'p', 'mac');
  assert.equal(health.json?.state, 'healthy', health.out + health.err);
  const usage = health.json.usage;
  assert.deepEqual(usage['sandbox-use']['abc-3-a'], { state: 'suspended', 'memory-bytes': 0, 'cpu-percent': 0, 'snapshot-bytes': 300000000 });
  assert.equal(usage.sandboxes, 0, 'not active');
  assert.equal(usage['snapshot-bytes'], 301000000);
  assert.deepEqual(usage.disk, { 'total-bytes': 400000000000, 'free-bytes': 250000000000 });
  assert.deepEqual(usage.workers, { replicas: 1, 'memory-request-bytes': 256 * 1024 ** 2 });
  const recorded = JSON.parse(readFileSync(t.s.at('projects', 'p', 'substrate.json'), 'utf8')).mac.usage;
  assert.equal(recorded['snapshot-bytes'], 301000000, 'recorded for control (substrate.json)');

  // AC2: resumed as it was — the same actor (not made again), nothing brought in from origin, its files there.
  const again = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual([again.json.created, again.json.branches, again.json.name], [false, [], 'abc-3-a']);
  assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_RUNNING');
  assert.equal(t.s.variation('A').sandbox.state, 'running');
  const read = await t.inMachine(name, 'cat "$HARNESS_VM_ROOT/home/agent/notes.txt" "$HARNESS_VM_ROOT/repos/harness/wip.txt"');
  assert.equal(read.out, 'kept\nwip\n', read.err);
  assert.equal(t.s.tokens()[name].variation, 'A', 'still bound to it');

  // Deleting it (its ticket done) is what revokes its token and removes its rules.
  const del = await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'A');
  assert.equal(del.code, 0, del.err);
  assert.equal(t.s.tokens()[name], undefined);
  assert.ok(!existsSync(egress));
});
