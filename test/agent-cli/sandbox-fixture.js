// A ticket variation's Substrate sandbox for the tests (ASS-535, ASS-536): sandboxed({ remote }) — project p with a
// Substrate cluster on a fake Mac (or, remote, on its fake workstation ada-dev, connected over its fake SSH master), up,
// its sandbox image delivered — and branchOnOrigin, a branch of ABC-3 A's on origin. fake-substrate.js's kit keeps the
// cluster's state; its `kubectl-ate proxy actor` serves fake-command-server.js, which runs a sandbox's commands here
// with its / a folder of its own. Not a test file (npm test's pattern leaves it alone).
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { wsFixture, closeAll, edit, git, ID } from './workstation-fixture.js';
import { fakeSubstrateMachine, putKit } from '../support/fake-substrate.js';

after(closeAll);
export const last = out => { try { return JSON.parse(String(out ?? '').trim().split('\n').pop()); } catch { return null; } };
export const MACHINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
export const DIGEST = `sha256:${'d'.repeat(64)}`;
// A port range of this test's own, so parallel test files never take each other's sandbox ports.
let base = 20000 + Math.floor(Math.random() * 400) * 50;

// sandboxed({ remote }) — project p with a Substrate cluster on the Mac (or, remote, on its workstation ada-dev,
// connected), up; the project's sandbox image delivered to it already (its label and sandbox-deliveries.json: the
// image a sandbox is made from), the image's /repos the project's two repositories cloned from their origins.
// `hindsight`: the port p's project.json names for its Hindsight (ASS-536).
export async function sandboxed({ remote = false, hindsight } = {}) {
  const s = wsFixture();
  const machine = remote ? ID : 'mac', arch = remote ? 'amd64' : (process.arch === 'arm64' ? 'arm64' : 'amd64');
  edit(s.at('projects', 'p', 'project.json'), p => {
    p['dev-environments'].substrate = { clusters: [{ machine }] };
    p.registry = { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: 9 };
    p['golden-image'] = { folder: 'projects/p/golden-image' };
    if (hindsight) p.hindsight = { port: hindsight, 'llm-api-key': null };
  });
  mkdirSync(s.at('projects', 'p', 'golden-image'), { recursive: true });
  writeFileSync(s.at('projects', 'p', 'golden-image', 'template.yaml'), 'vmType: vz\n');
  writeFileSync(s.at('projects', 'p', 'golden-image', 'provision.sh'), '#!/bin/bash\n');
  writeFileSync(s.at('projects', 'p', `sandbox-image-${arch}.json`), JSON.stringify({ project: 'p', arch, digest: DIGEST, repository: '0local/sandbox/p', tag: `${arch}-dddddddddddd` }));
  writeFileSync(s.at('projects', 'p', 'sandbox-deliveries.json'), JSON.stringify({ [machine]: { arch, digest: DIGEST, ref: `sandbox/p@${DIGEST}` } }));
  // The image's file system: the repositories baked in, as ASS-534's build does.
  const image = mkdtempSync(join(tmpdir(), 'image-'));
  for (const [name, url] of Object.entries(s.origins)) {
    execFileSync('git', ['clone', '-q', url, join(image, 'repos', name)]);
    git(join(image, 'repos', name), 'config', 'user.email', 'agent@example.com'); git(join(image, 'repos', name), 'config', 'user.name', 'Agent');
  }
  const dir = remote ? dirname(s.w.system(ID)) : mkdtempSync(join(tmpdir(), 'mac-'));
  const m = remote ? fakeSubstrateMachine(dir, { persist: s.w.home(ID) }) : fakeSubstrateMachine(dir, { memory: 38 * 1024 ** 3 });
  putKit(join(s.env.HOME, '.harness', 'substrate'));
  base += 50;
  Object.assign(s.env, m.env, {
    ...(remote ? {} : { PATH: `${m.bin}:${s.env.PATH}` }),
    HARNESS_SUBSTRATE_GRACE: '0', FAKE_SUBSTRATE_LOG: join(dir, 'substrate.log'),
    FAKE_COMMAND_SERVER: join(import.meta.dirname, '..', 'support', 'fake-command-server.js'), FAKE_SANDBOX_IMAGE: image,
    HARNESS_SANDBOX_PORTS: `${base}-${base + 49}`, HARNESS_SUBSTRATE_TEMPLATE_WAIT: '4', HARNESS_SUBSTRATE_RESUME_WAIT: '10', HARNESS_SANDBOX_REACH_MS: '3000',
  });
  if (remote) assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  const up = await s.result('substrate:up', 'p', machine);
  assert.equal(up.code, 0, up.err);
  const call = (...args) => s.result(...args).then(r => ({ ...r, json: last(r.out) }));
  const k8s = () => m.k8s();
  const root = actor => join(k8s(), 'sandboxes', 'harness-p', actor, 'root');
  const actors = () => JSON.parse(readFileSync(join(k8s(), 'actors-harness-p.json'), 'utf8')).actors;
  const state = actor => actors().find(a => a.metadata.name === actor)?.status.state ?? null;
  // inMachine(machine, script, { stdin, workdir }) — machine.bash's machine_run of `bash -c script`.
  const inMachine = (name, script, { stdin = '', workdir = '' } = {}) => new Promise(resolve => {
    const child = spawn('bash', ['-c', `source "${MACHINE_BASH}"; machine_run ${workdir ? `--workdir ${workdir}` : ''} "$0" -- bash -c "$1"`, name, script], { env: s.env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(stdin);
  });
  return { s, m, machine, call, root, actors, state, inMachine, image };
}

// A branch of ABC-3's variation A on origin, with a commit of its own: the work an earlier step left (on a VM, say).
export function branchOnOrigin(s, name = 'harness', branch = 'change/ABC-3-1') {
  const work = mkdtempSync(join(tmpdir(), 'work-'));
  execFileSync('git', ['clone', '-q', s.origins[name], work]);
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
  git(work, 'checkout', '-q', '-b', branch);
  writeFileSync(join(work, 'feature.txt'), 'from the last step\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'ABC-3: the last step');
  git(work, 'push', '-q', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

