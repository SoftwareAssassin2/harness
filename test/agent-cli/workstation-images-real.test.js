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
// idle. ASS-477: an agent's own pull in a harness session pulls it too, as
// the service account through docker-credential-harness, with the owner's
// gcloud login (on the test workstation lapsed by Workspace session control)
// out of it — the helper and the harness's Docker config made in a temp
// folder there (its ~/.docker a link to the owner's, only read), removed
// after, so neither the owner's files nor the running harness's ~/harness are
// touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const SCRIPT = join(ROOT, 'src', 'agent-cli', 'workstation', 'on-workstation', 'pull-images.sh');
const HELPER = join(ROOT, 'src', 'agent-cli', 'workstation', 'on-workstation', 'docker-credential-harness');
const skip = process.env.HARNESS_WORKSTATION_TESTS !== '1' && 'set HARNESS_WORKSTATION_TESTS=1 to run against a real GCP workstation';
const e = process.env;
const ws = {
  id: e.WORKSTATION_TEST_ID ?? 'ada-dev', 'gcp-project': e.WORKSTATION_TEST_PROJECT ?? 'example-gcp-project', region: e.WORKSTATION_TEST_REGION ?? 'us-central1',
  cluster: e.WORKSTATION_TEST_CLUSTER ?? 'example-workstations', config: e.WORKSTATION_TEST_CONFIG ?? 'example-config', 'gcloud-config': e.WORKSTATION_TEST_GCLOUD_CONFIG ?? '~/.config/example/gcloud',
};
const host = `${ws.region}-docker.pkg.dev`;
const image = e.WORKSTATION_TEST_IMAGE ?? `${host}/${ws['gcp-project']}/dockerhub/alpine:3.22`;

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let env = null;
after(async () => { if (env) await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env }).catch(() => {}); });

test('a real workstation pulls one small image straight from Artifact Registry as its service account, at a claim and (ASS-477) in a harness session', { skip, timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsi-real-'));
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', 'dev-environments': { mode: 'workstation', workstations: [ws] } }));
  // A free port, not 7787: a running harness's own connection holds that one's forward (ASS-477).
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'forwarder-port': await freePort() }));
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

  // ASS-477: the agents' pull, with the harness's Docker config made from the owner's (configure) in a temp home.
  const session = `set -e; t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT; mkdir -p "$t/bin" "$t/harness"
    [ ! -e "$HOME/.docker" ] || ln -s "$HOME/.docker" "$t/.docker"
    cat > "$t/bin/docker-credential-harness"; chmod 755 "$t/bin/docker-credential-harness"
    export PATH="$t/bin:$HOME/harness/bin:$PATH"
    HOME="$t" docker-credential-harness configure "$1"
    grep -q '"harness"' "$t/harness/docker/config.json"
    DOCKER_CONFIG="$t/harness/docker" docker pull "$2"`;
  const agent = spawn(AGENT, ['workstation:ssh', 'p', ws.id, 'bash', '-c', session, 'harness-session', host, image], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  createReadStream(HELPER).pipe(agent.stdin);
  let said = '';
  agent.stdout.on('data', d => { said += d; });
  agent.stderr.on('data', d => { said += d; });
  assert.equal(await new Promise(resolve => agent.on('close', resolve)), 0, said);
  assert.match(said, /Image is up to date|Downloaded newer image/);
  assert.doesNotMatch(said, /ya29\./, 'no token printed');

  await run(AGENT, ['workstation:disconnect', 'p', ws.id], { env });
  env = null;
});
