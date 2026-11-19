// A ticket variation on a real GCP workstation (ASS-435 AC8): run only with
// HARNESS_WORKSTATION_TESTS=1, on a Mac whose gcloud can reach the
// workstation — the operator's test workstation by default, or the one
// WORKSTATION_TEST_ID, _PROJECT, _REGION, _CLUSTER, _CONFIG and
// _GCLOUD_CONFIG name (as workstation-real.test.js) — and that is free (no
// ticket of a real project on it). In a temp harness project in workstation
// mode with one small public repository (WORKSTATION_TEST_REPO, octocat's
// Hello-World by default) and a git identity as its only declared credential
// (a temp VM_CREDENTIALS_FILE: no keychain item is read), the real forwarder
// on a free port of the Mac's loopback: vm:create records the workstation on
// ticket X-1 A (connecting and setting it up when needed), and a step's
// claim (ASS-468: workstation:claim) readies the shared root, ~/harness —
// the repository cloned into repos/ once and on master, the ticket's
// read-only copy, the runtime folder's env and forwarder token; agent.sh
// there reaches the forwarder through the reverse forward, runs a write for
// its binding (in the ticket copy as it returns) and is refused for another
// ticket; workstation:release --force ends the step — the repository clean
// on master — and frees the workstation, then the connection is closed. The
// workstation is left running, to stop itself once idle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startForwarder } from '../../src/control/forwarder.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const MACHINE_BASH = join(ROOT, 'src', 'agent-cli', 'machine.bash');
const skip = process.env.HARNESS_WORKSTATION_TESTS !== '1' && 'set HARNESS_WORKSTATION_TESTS=1 to run against a real GCP workstation';
const e = process.env;
const ws = {
  id: e.WORKSTATION_TEST_ID ?? 'ada-dev', 'gcp-project': e.WORKSTATION_TEST_PROJECT ?? 'example-gcp-project', region: e.WORKSTATION_TEST_REGION ?? 'us-central1',
  cluster: e.WORKSTATION_TEST_CLUSTER ?? 'example-workstations', config: e.WORKSTATION_TEST_CONFIG ?? 'example-config', 'gcloud-config': e.WORKSTATION_TEST_GCLOUD_CONFIG ?? join(homedir(), '.config', 'example', 'gcloud'),
};
const repo = e.WORKSTATION_TEST_REPO ?? 'https://github.com/octocat/Hello-World.git';
const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let env = null, forwarder = null;
after(async () => {
  if (env) {
    await run(AGENT, ['workstation:release', 'p', ws.id, '--force'], { env }).catch(() => {});
    await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env }).catch(() => {});
  }
  forwarder?.close();
});

test('a real workstation: a ticket variation\'s step claims it, the shared root readied, agent.sh reaching the forwarder for its binding alone, then released', { skip, timeout: 1_200_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsv-real-'));
  const port = await freePort();
  const p = join(dir, 'projects', 'p');
  mkdirSync(join(p, 'sprints', 'sprint-1'), { recursive: true });
  writeFileSync(join(p, 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'harness-development-grouped', 'work-sources': [{ name: 'Local', type: 'off-board', 'key-prefix': 'X' }],
    repositories: [{ url: repo, description: 'a small public repository' }], 'dev-environments': { mode: 'workstation', workstations: [ws] } }));
  writeFileSync(join(p, 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(join(p, 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [{ key: 'X-1', variations: [{ name: 'A', 'harness-status': { state: 'setup', 'state-engine': 'harness-development-grouped' } }] }], bugs: [], spikes: [] }));
  mkdirSync(join(p, 'work', 'X-1'), { recursive: true });
  writeFileSync(join(p, 'work', 'X-1', 'plan.md'), 'the plan\n');
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'forwarder-port': port }));
  writeFileSync(join(dir, 'assignments.json'), JSON.stringify({ assignments: [] }));
  writeFileSync(join(dir, 'vm-credentials.json'), JSON.stringify({ p: { git: { 'user-name': 'Harness Test', 'user-email': 'harness-test@example.com' } } }));
  env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json'), ASSIGNMENTS_FILE: join(dir, 'assignments.json'), HARNESS_HOME: mkdtempSync(join(tmpdir(), 'wsvr-')), VM_CREDENTIALS_FILE: join(dir, 'vm-credentials.json') };
  forwarder = await startForwarder({ root: ROOT, env, port });

  const created = JSON.parse((await run(AGENT, ['vm:create', 'p', 'X-1', 'A'], { env })).stdout);
  assert.equal(created.name, ws.id);
  const claimed = JSON.parse((await run(AGENT, ['workstation:claim', 'p', 'X-1', 'A'], { env })).stdout);
  const machine = claimed.machine;
  assert.equal(machine, created.machine);
  const sprint = JSON.parse(readFileSync(join(p, 'sprints', 'sprint-1', 'sprint.json'), 'utf8'));
  assert.equal(sprint.features[0].variations[0].vm.kind, 'workstation');
  const there = script => run('bash', ['-c', `source "${MACHINE_BASH}" && machine_run "${machine}" -- bash -c '${script}'`], { env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), x => ({ code: x.code, out: x.stdout, err: x.stderr }));
  const listed = await there('ls "$HARNESS_VM_ROOT/repos"; cat "$HARNESS_VM_ROOT/ticket/plan.md"; test -s "$HARNESS_VM_ROOT/run/harness/agent-token" && echo token; grep -c GIT_CONFIG_GLOBAL "$HARNESS_VM_ROOT/run/harness/env"');
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /Hello-World/);
  assert.match(listed.out, /the plan\ntoken\n1\n/);

  const wrote = await there('echo "from the real workstation" | agent.sh work:write p X-1 A notes.md && cat "$HARNESS_VM_ROOT/ticket/notes-A.md"');
  assert.equal(wrote.code, 0, wrote.err);
  assert.equal(wrote.out, 'from the real workstation\n');
  const refused = await there('agent.sh work:write p X-2 A notes.md </dev/null');
  assert.equal(refused.code, 77, refused.err);

  const released = await run(AGENT, ['workstation:release', 'p', ws.id, '--force'], { env });
  assert.equal(JSON.parse(released.stdout).released.ticket, 'X-1');
  const clean = await run(AGENT, ['workstation:ssh', 'p', ws.id, 'bash', '-c', 'git -C "$HOME/harness/repos/Hello-World" status --porcelain; test -e "$HOME/harness/X-1-A" && echo there || echo gone'], { env });
  assert.equal(clean.stdout.trim(), 'gone');
  await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env });
  env = null;
});
