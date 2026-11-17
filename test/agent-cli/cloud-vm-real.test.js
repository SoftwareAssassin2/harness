// A real cloud VM (ASS-481 AC7): run only with HARNESS_CLOUD_VM_TESTS=1, on a
// Mac whose gcloud can reach the VM through IAP with OS Login — the
// operator's ada-vm by default (example-gcp-project, us-central1-a,
// its gcloud login under ~/.config/example/gcloud), or the one
// CLOUD_VM_TEST_ID, _PROJECT, _ZONE, _GCLOUD_CONFIG and _SSH_USER name. In a
// temp harness project listing it, with the real forwarder
// (src/control/forwarder.js) on a free port of the Mac's loopback:
// workstation:status reads its status; workstation:connect starts (or
// resumes) it if it has stopped itself, waits for its SSH through IAP and
// opens the master, the forwarder reverse-forwarded (a curl there reaches
// it: refused, as a call with no valid token is); the machine layer runs a
// command and copies a file in and out (cloud-vm:<project>:<id>:<folder>);
// and one small Artifact Registry image (CLOUD_VM_TEST_IMAGE, a small
// curl image by default) is pulled there as the VM's service account (the
// metadata server's token, ASS-472) — with docker through
// on-workstation/pull-images.sh when the VM has Docker, and always through
// the registry's API (manifest and layers fetched and checked against their
// digests). Everything it puts on the VM is under one scratch folder in its
// home, removed at the end; the connection is closed. The VM is never
// stopped, suspended, reset or deleted, nor its metadata changed: it stops
// itself once idle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startForwarder } from '../../src/control/forwarder.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const MACHINE_BASH = join(ROOT, 'src', 'agent-cli', 'machine.bash');
const PULL = join(ROOT, 'src', 'agent-cli', 'workstation', 'on-workstation', 'pull-images.sh');
const skip = process.env.HARNESS_CLOUD_VM_TESTS !== '1' && 'set HARNESS_CLOUD_VM_TESTS=1 to run against a real cloud VM';
const e = process.env;
const vm = {
  id: e.CLOUD_VM_TEST_ID ?? 'ada-vm', 'gcp-project': e.CLOUD_VM_TEST_PROJECT ?? 'example-gcp-project', zone: e.CLOUD_VM_TEST_ZONE ?? 'us-central1-a',
  'gcloud-config': e.CLOUD_VM_TEST_GCLOUD_CONFIG ?? '~/.config/example/gcloud', ...(e.CLOUD_VM_TEST_SSH_USER ? { 'ssh-user': e.CLOUD_VM_TEST_SSH_USER } : {}),
};
const host = `${vm.zone.replace(/-[a-z]$/, '')}-docker.pkg.dev`;
const image = e.CLOUD_VM_TEST_IMAGE ?? `${host}/${vm['gcp-project']}/dockerhub/curlimages/curl:8.20.0@sha256:b3f1fb2a51d923260350d21b8654bbc607164a987e2f7c84a0ac199a67df812a`;
const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// The registry API pull, run on the VM (test/support/registry-api-pull.sh on stdin).
const API_PULL = join(ROOT, 'test', 'support', 'registry-api-pull.sh');

let env = null, forwarder = null, scratch = null;
const cli = (...args) => run(AGENT, args, { env, maxBuffer: 16 << 20 });
// piped(script, args) — agent.sh args run with the script on its stdin: { code, out, err }.
const piped = (script, args) => new Promise(resolve => {
  const child = spawn(AGENT, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  createReadStream(script).pipe(child.stdin);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', code => resolve({ code, out, err }));
});
after(async () => {
  if (env && scratch) await cli('workstation:ssh', 'p', vm.id, 'rm', '-rf', scratch).catch(() => {});
  if (env) await cli('workstation:disconnect', 'p', vm.id).catch(() => {});
  forwarder?.close();
});

test('a real cloud VM: its status read, started if it stopped itself, connected through IAP; a command run, a file copied in and out, one small Artifact Registry image pulled as its service account; all under a scratch folder removed after', { skip, timeout: 900_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvm-real-'));
  const port = await freePort();
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', 'dev-environments': { mode: 'workstation', 'cloud-vms': [vm] } }));
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'forwarder-port': port }));
  writeFileSync(join(dir, 'assignments.json'), JSON.stringify({ assignments: [] }));
  env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json'), ASSIGNMENTS_FILE: join(dir, 'assignments.json'), HARNESS_HOME: mkdtempSync('/tmp/cvmr-') };
  forwarder = await startForwarder({ root: ROOT, env, port });

  const status = JSON.parse((await cli('workstation:status', 'p', vm.id)).stdout);
  assert.match(status.state, /^(running|stopped|starting|stopping|suspended|suspending)$/, JSON.stringify(status));
  console.log(`# ${vm.id} was ${status.state}`);

  const connected = JSON.parse((await cli('workstation:connect', 'p', vm.id)).stdout);
  assert.equal(connected.connected, true);
  assert.equal(connected.state, 'running');
  assert.match(connected['boot-id'], /^[0-9a-f-]{36}$/);
  console.log(`# connected${connected.started ? ' (started it)' : ''}`);

  // The forwarder through the reverse forward on the VM's loopback.
  const call = JSON.stringify({ argv: ['ticket:show', 'X-1'], token: 'not-a-token' });
  const answer = (await cli('workstation:ssh', 'p', vm.id, 'curl', '-sS', '-X', 'POST', '--data', call, `http://127.0.0.1:${port}/run`)).stdout;
  assert.match(answer, /"refused"/, `the forwarder's answer, through the reverse forward: ${answer}`);
  // No terminal: the connection holds no pts session that would keep the VM up (AC4).
  const ttys = (await cli('workstation:ssh', 'p', vm.id, 'bash', '-c', 'tty || true')).stdout;
  assert.match(ttys, /not a tty/);

  const home = (await cli('workstation:ssh', 'p', vm.id, 'bash', '-c', 'echo "$HOME"')).stdout.trim();
  scratch = `${home}/harness-cloud-vm-test-${randomBytes(4).toString('hex')}`;
  const folder = `${scratch}/harness`, machine = `cloud-vm:p:${vm.id}:${folder}`;
  await cli('workstation:ssh', 'p', vm.id, 'mkdir', '-p', `${folder}/repos`);
  const bash = script => run('bash', ['-c', `source "${MACHINE_BASH}" && ${script}`], { env });
  const ran = await bash(`machine_run --workdir /repos "${machine}" -- bash -c 'pwd; echo "$HARNESS_VM_ROOT"; uname -s'`);
  assert.deepEqual(ran.stdout.trim().split('\n'), [`${folder}/repos`, folder, 'Linux']);
  assert.equal((await bash(`machine_status "${machine}"`)).stdout, 'Running\n');
  const local = mkdtempSync(join(tmpdir(), 'cvm-real-copy-'));
  writeFileSync(join(local, 'in.txt'), `to ${vm.id}\n`);
  await bash(`machine_copy_in "${machine}" "${join(local, 'in.txt')}" /repos/in.txt`);
  mkdirSync(join(local, 'back'));
  await bash(`machine_copy_out "${machine}" /repos/in.txt "${join(local, 'back')}/"`);
  assert.equal(readFileSync(join(local, 'back', 'in.txt'), 'utf8'), `to ${vm.id}\n`);

  // One small image from Artifact Registry, as the VM's service account: through the registry's API, into the scratch.
  const pulled = await piped(API_PULL, ['workstation:ssh', 'p', vm.id, 'bash', '-s', '--', `${folder}/image`, image]);
  assert.equal(pulled.code, 0, pulled.err);
  assert.match(pulled.out, /^pulled \d+ blobs \d+ bytes$/m, pulled.err);
  assert.doesNotMatch(pulled.out + pulled.err, /ya29\./, 'no token printed');
  console.log(`# ${pulled.out.trim()} (${image}, the registry's API)`);
  // And with docker, as a step's claim pulls it (pull-images.sh), when the VM has Docker.
  const docker = (await cli('workstation:ssh', 'p', vm.id, 'bash', '-c', 'docker info >/dev/null 2>&1 && echo yes || echo no')).stdout.trim();
  if (docker === 'yes') {
    const { code, out, err } = await piped(PULL, ['workstation:ssh', 'p', vm.id, 'bash', '-s', '--', host, '', '0local', image]);
    assert.equal(code, 0, err);
    const [, , source, , state, why] = out.trim().split('\n').find(l => l.startsWith('!pull\t')).split('\t');
    assert.equal(source, 'registry', `${why}\n${err}`);
    assert.match(state, /^(downloaded|up-to-date)$/);
    console.log(`# docker pull: ${state}`);
  } else console.log(`# ${vm.id} has no usable Docker: the docker pull (pull-images.sh) is not tried; workstation:setup there would fail "Docker not usable"`);

  await cli('workstation:ssh', 'p', vm.id, 'rm', '-rf', scratch);
  const left = (await cli('workstation:ssh', 'p', vm.id, 'bash', '-c', `test -e '${scratch}' && echo left || echo gone`)).stdout.trim();
  assert.equal(left, 'gone');
  scratch = null;
  const closed = JSON.parse((await cli('workstation:disconnect', 'p', vm.id)).stdout);
  assert.equal(closed.connected, false);
  env = null;
});
