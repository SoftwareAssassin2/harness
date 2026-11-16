// A real workstation pulls an image straight from Artifact Registry (ASS-472
// AC4): run only with HARNESS_WORKSTATION_TESTS=1, on a Mac whose gcloud can
// reach the workstation — the operator's test workstation by default, or the
// one WORKSTATION_TEST_ID, _PROJECT, _REGION, _CLUSTER, _CONFIG and
// _GCLOUD_CONFIG name (as workstation-real.test.js). Connected (started if
// stopped), on-workstation/pull-images.sh is run there over the connection,
// as a step's claim runs it, for one small image, WORKSTATION_TEST_IMAGE
// (<region>-docker.pkg.dev/<project>/dockerhub/alpine:3.22 by default), with
// no zot to fall back on: it comes from Artifact Registry as the
// workstation's service account (the metadata server's token) — downloaded,
// or up to date when the workstation has it — and no token is printed. The
// image is left there; the workstation is left running, to stop itself once
// idle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const SCRIPT = join(ROOT, 'src', 'agent-cli', 'workstation', 'on-workstation', 'pull-images.sh');
const skip = process.env.HARNESS_WORKSTATION_TESTS !== '1' && 'set HARNESS_WORKSTATION_TESTS=1 to run against a real GCP workstation';
const e = process.env;
const ws = {
  id: e.WORKSTATION_TEST_ID ?? 'ada-dev', 'gcp-project': e.WORKSTATION_TEST_PROJECT ?? 'example-gcp-project', region: e.WORKSTATION_TEST_REGION ?? 'us-central1',
  cluster: e.WORKSTATION_TEST_CLUSTER ?? 'example-workstations', config: e.WORKSTATION_TEST_CONFIG ?? 'example-config', 'gcloud-config': e.WORKSTATION_TEST_GCLOUD_CONFIG ?? '~/.config/example/gcloud',
};
const host = `${ws.region}-docker.pkg.dev`;
const image = e.WORKSTATION_TEST_IMAGE ?? `${host}/${ws['gcp-project']}/dockerhub/alpine:3.22`;

let env = null;
after(async () => { if (env) await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env }).catch(() => {}); });

test('a real workstation pulls one small image straight from Artifact Registry as its service account', { skip, timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsi-real-'));
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', 'dev-environments': { mode: 'workstation', workstations: [ws] } }));
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'forwarder-port': 7787 }));
  writeFileSync(join(dir, 'assignments.json'), JSON.stringify({ assignments: [] }));
  env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json'), ASSIGNMENTS_FILE: join(dir, 'assignments.json'), HARNESS_HOME: mkdtempSync('/tmp/wsir-') };
  assert.equal(JSON.parse((await run(AGENT, ['workstation:connect', 'p', ws.id], { env })).stdout).connected, true);

  // The script on stdin, as wsv_pull_images sends it: no zot port, so only Artifact Registry can give the image.
  const child = spawn(AGENT, ['workstation:ssh', 'p', ws.id, 'bash', '-s', '--', host, '', '0local', image], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  createReadStream(SCRIPT).pipe(child.stdin);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, err);
  const [, pulled, source, , status, why] = out.trim().split('\n').find(l => l.startsWith('!pull\t')).split('\t');
  assert.equal(pulled, image);
  assert.equal(source, 'registry', `${why}\n${err}`);
  assert.match(status, /^(downloaded|up-to-date)$/);
  assert.match(err, /pulled .* from Artifact Registry in \d+s/);
  assert.doesNotMatch(out + err, /ya29\./, 'no token printed');

  await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env });
  env = null;
});
