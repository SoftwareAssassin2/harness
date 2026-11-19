// A real GCP workstation's connection (ASS-433 AC6): run only with
// HARNESS_WORKSTATION_TESTS=1, on a Mac whose gcloud can reach the
// workstation — the operator's test workstation by default (ada-dev in
// example-gcp-project, us-central1, example-workstations, example-config,
// its gcloud login under ~/.config/example/gcloud), or the one
// WORKSTATION_TEST_ID, _PROJECT, _REGION, _CLUSTER, _CONFIG and
// _GCLOUD_CONFIG name. In a temp harness project using it, with the real
// forwarder (src/control/forwarder.js) listening on a free port of the Mac's
// loopback: workstation:connect starts the workstation if it is stopped (up
// to ~80 seconds) and opens its connection; a curl run on the workstation
// over that connection reaches the forwarder at 127.0.0.1:<port> through the
// reverse forward — refused, as a call with no valid token is, which only the
// forwarder answers so — and the forwarded port listens on the workstation's
// loopback alone; workstation:disconnect closes it. The workstation is left
// running, to stop itself once idle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startForwarder } from '../../src/control/forwarder.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const skip = process.env.HARNESS_WORKSTATION_TESTS !== '1' && 'set HARNESS_WORKSTATION_TESTS=1 to run against a real GCP workstation';
const e = process.env;
const ws = {
  id: e.WORKSTATION_TEST_ID ?? 'ada-dev', 'gcp-project': e.WORKSTATION_TEST_PROJECT ?? 'example-gcp-project', region: e.WORKSTATION_TEST_REGION ?? 'us-central1',
  cluster: e.WORKSTATION_TEST_CLUSTER ?? 'example-workstations', config: e.WORKSTATION_TEST_CONFIG ?? 'example-config', 'gcloud-config': e.WORKSTATION_TEST_GCLOUD_CONFIG ?? '~/.config/example/gcloud',
};
const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let env = null, forwarder = null;
after(async () => {
  if (env) await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env }).catch(() => {});
  forwarder?.close();
});

test('a real workstation: connected (started if stopped), the forwarder reached from it through the reverse forward on its loopback alone, then disconnected', { skip, timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-real-'));
  const port = await freePort();
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', 'dev-environments': { mode: 'workstation', workstations: [ws] } }));
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'forwarder-port': port }));
  writeFileSync(join(dir, 'assignments.json'), JSON.stringify({ assignments: [] }));
  env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json'), ASSIGNMENTS_FILE: join(dir, 'assignments.json'), HARNESS_HOME: mkdtempSync(join(tmpdir(), 'wsr-')) };
  forwarder = await startForwarder({ root: ROOT, env, port });

  const connected = JSON.parse((await run(AGENT, ['workstation:connect', 'p', ws.id], { env })).stdout);
  assert.equal(connected.connected, true);
  assert.equal(connected.state, 'running');

  const call = JSON.stringify({ argv: ['ticket:show', 'X-1'], token: 'not-a-token' });
  const { stdout } = await run(AGENT, ['workstation:ssh', 'p', ws.id, 'curl', '-sS', '-X', 'POST', '--data', call, `http://127.0.0.1:${port}/run`], { env });
  assert.match(stdout, /"refused"/, `the forwarder's answer, through the reverse forward: ${stdout}`);

  const listening = (await run(AGENT, ['workstation:ssh', 'p', ws.id, 'bash', '-c', `if command -v ss >/dev/null; then ss -Hltn "sport = :${port}"; else echo no-ss; fi`], { env })).stdout;
  if (!listening.includes('no-ss')) {
    assert.match(listening, new RegExp(`127\\.0\\.0\\.1:${port}\\b`));
    assert.doesNotMatch(listening, new RegExp(`(0\\.0\\.0\\.0|\\*|\\[::\\]):${port}\\b`));
  }

  const status = JSON.parse((await run(AGENT, ['workstation:status', 'p', ws.id], { env })).stdout);
  assert.equal(status.connected, true);
  const closed = JSON.parse((await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env })).stdout);
  assert.equal(closed.connected, false);
  env = null;
});
