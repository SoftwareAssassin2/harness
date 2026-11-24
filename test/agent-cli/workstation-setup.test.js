// workstation:setup (ASS-434 AC1–AC5): over a workstation's open connection,
// installs under ~/harness, or checks, what an agent needs — the Claude Code
// CLI, agent.sh pointed at the forwarder on the workstation's loopback, jq,
// curl, git, Docker and the project's golden-image tools — records its version
// there and in the live data, does nothing on a rerun, empties the runtime
// folder after a restart, fails naming a tool it cannot install or Docker not
// usable, and leaves the owner's own setup alone. Against a fake workstation
// (test/support/fake-workstation.js: its home a temp folder).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fixture, AGENT } from './harness-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';
import { LOADED_MS } from '../support/until.js';
import { workstationUsable } from '../../src/control/workstation-connection.js';

const run = promisify(execFile);
const ID = 'ada-dev';
const opened = [];
const servers = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.cli('workstation:disconnect', 'p', ID).catch(() => {});
  for (const server of servers.splice(0)) server.close();
});

// The commands a bare workstation image has: no jq and no claude (the Mac's own are left off its PATH).
const BASE = ['bash', 'sh', 'sleep', 'mkdir', 'chmod', 'cat', 'sed', 'id', 'rm', 'mktemp', 'cmp', 'mv', 'ln', 'base64', 'grep', 'uname', 'curl', 'git', 'rsync', 'cp', 'dirname', 'tr', 'head', 'env'];   // rsync: ASS-435
async function bareImage(extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'wsimg-'));
  for (const c of [...BASE, ...extra]) symlinkSync((await run('bash', ['-c', `command -v ${c}`])).stdout.trim(), join(dir, c));
  return dir;
}

// ASS-462: a golden-image folder whose workstation-tools.sh installs mytool from a file it shares with
// provision.sh (no copy); mytool exits $MYTOOL_EXIT. provision.sh and template.yaml are Lima-only, never shipped.
const SHARED = {
  'gate.sh': 'install_gate() { printf \'#!/bin/bash\\nexit ${MYTOOL_EXIT:-0}\\n\' > "$HARNESS_TOOLS/mytool"; chmod 755 "$HARNESS_TOOLS/mytool"; ln -sf "$HARNESS_TOOLS/mytool" "$HARNESS_BIN/mytool"; }\n',
  'provision.sh': '. "$(dirname "$0")/gate.sh"\ninstall_gate\n',
  'template.yaml': 'images: []\n',
};
const SHARED_INSTALLER = '. "$(dirname "$0")/gate.sh"\ninstall_gate\n';

// Project p on workstation ada-dev, running, its forwarder on `forwarder`; tools its golden-image tools,
// installer the body of its golden-image/workstation-tools.sh (none when null), and files other files of its
// golden-image folder (name, possibly with a subfolder, to content). cli(...) runs agent.sh.
function setup({ tools = [], installer = null, files = {}, forwarder = 7787, env = {} } = {}) {
  const f = fixture(), w = fakeWorkstation(f.env);
  Object.assign(w.env, env);
  const pj = join(f.dir, 'projects', 'p', 'project.json'), hj = join(f.dir, 'harness.json');
  const p = JSON.parse(readFileSync(pj, 'utf8'));
  p['dev-environments'] = { mode: 'workstation', workstations: [{ id: ID, 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config' }] };
  p['golden-image'] = { folder: 'projects/p/golden-image', tools };
  writeFileSync(pj, JSON.stringify(p));
  mkdirSync(join(f.dir, 'projects', 'p', 'golden-image'), { recursive: true });
  if (installer !== null) writeFileSync(join(f.dir, 'projects', 'p', 'golden-image', 'workstation-tools.sh'), installer);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(f.dir, 'projects', 'p', 'golden-image', name)), { recursive: true });
    writeFileSync(join(f.dir, 'projects', 'p', 'golden-image', name), content);
  }
  const h = JSON.parse(readFileSync(hj, 'utf8'));
  h['forwarder-port'] = forwarder;
  writeFileSync(hj, JSON.stringify(h));
  w.workstation(ID, 'STATE_RUNNING');
  const cli = (...args) => run(AGENT, args, { env: w.env });
  const result = (...args) => cli(...args).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
  const entry = () => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'workstations.json'), 'utf8'))[ID];
  const home = w.home(ID);
  const s = { f, w, cli, result, entry, home, at: (...rest) => join(home, ...rest), pj };
  opened.push(s);
  return s;
}

// The owner's own setup on the workstation, as the guide's first login leaves it: every file's content and mode.
function ownerSetup(home) {
  const files = { '.bashrc': 'export EDITOR=vim\n', '.profile': '. ~/.bashrc\n', '.gitconfig': '[user]\n\tname = Ada\n\temail = ada@example.com\n',
    '.ssh/id_ed25519': 'PRIVATE KEY\n', '.ssh/config': 'Host gitlab.com\n', 'workspaces/example/README.md': 'mine\n' };
  for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(home, name)), { recursive: true }); writeFileSync(join(home, name), content); }
}
function snapshot(home, skip = ['harness']) {
  const out = {};
  const walk = rel => {
    for (const name of readdirSync(join(home, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && skip.includes(name)) continue;
      const st = statSync(join(home, r));
      if (st.isDirectory()) walk(r); else out[r] = `${st.mode.toString(8)} ${st.mtimeMs} ${readFileSync(join(home, r), 'utf8')}`;
    }
  };
  walk('');
  return out;
}

// A fake forwarder: answers each POST with "hi" on stdout and exit 0, recording the bodies.
async function forwarder() {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; }).on('end', () => {
      bodies.push({ url: req.url, body: JSON.parse(body) });
      res.end(`${JSON.stringify({ o: Buffer.from('hi\n').toString('base64') })}\n${JSON.stringify({ exit: 0 })}\n`);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: server.address().port, bodies };
}

test('AC1, AC2, AC4, AC5: a fresh workstation gets jq, the Claude Code CLI, agent.sh pointed at the forwarder on its loopback and the project\'s tools, all under ~/harness, its version recorded there and in the live data; the owner\'s setup untouched', async () => {
  const fwd = await forwarder();
  const work = mkdtempSync(join(tmpdir(), 'wsdl-'));
  // jq's release binary (standing in: the Mac's own jq, which macOS will not run from a copy) and claude.ai's installer, as file:// URLs; the installer logs each run.
  writeFileSync(join(work, 'jq'), `#!/bin/bash\nexec ${(await run('bash', ['-c', 'command -v jq'])).stdout.trim()} "$@"\n`);
  writeFileSync(join(work, 'install.sh'), `mkdir -p "$HOME/.local/bin" && printf '#!/bin/bash\\necho "2.0.1 (Claude Code)"\\n' > "$HOME/.local/bin/claude" && chmod 755 "$HOME/.local/bin/claude" && echo "$HOME" >> ${join(work, 'claude-installs')}\n`);
  const s = setup({
    tools: ['kustomize', 'git'], forwarder: fwd.port,
    installer: `set -e\nfor t; do printf '#!/bin/bash\\necho %s\\n' "$t" > "$HARNESS_TOOLS/$t"; chmod 755 "$HARNESS_TOOLS/$t"; ln -sf "$HARNESS_TOOLS/$t" "$HARNESS_BIN/$t"; echo "$t" >> ${join(work, 'tool-installs')}; done\n`,
    env: { HARNESS_WS_JQ_URL: `file://${join(work, 'jq')}`, HARNESS_WS_CLAUDE_INSTALLER: `file://${join(work, 'install.sh')}` },
  });
  writeFileSync(join(dirname(s.w.system(ID)), 'path'), await bareImage());
  rmSync(join(s.w.system(ID), 'claude'));
  ownerSetup(s.home);
  const before = snapshot(s.home);
  await s.cli('workstation:connect', 'p', ID);
  const version = (await s.cli('workstation:setup', 'p', ID, '--version')).stdout.trim();
  assert.match(version, /^[0-9a-f]{64}$/);

  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.id, ID);
  const e = s.entry();
  assert.deepEqual(out.setup, e.setup);
  assert.equal(e.setup.ok, true);
  assert.equal(e.setup.version, version);
  assert.equal(e.setup.error, null);
  assert.deepEqual(e.setup.failed, []);
  assert.equal(e.setup['set-up-at'], e.setup['checked-at']);
  assert.ok(workstationUsable(e), 'connected and set up since');
  for (const what of [/^installed jq/, /^installed the Claude Code CLI/, /^installed agent\.sh /, /^installed agent\.sh's wrapper/, /^wrote the harness's session environment/, /^ran the project's workstation-tools\.sh for kustomize/, /^made the runtime folder/, /^recorded setup/])
    assert.ok(e.setup.did.some(d => what.test(d)), `did ${what}`);

  // Everything under ~/harness; the runtime folder the workstation's own, 0700.
  for (const bin of ['agent.sh', 'jq', 'claude', 'kustomize']) assert.ok(existsSync(s.at('harness', 'bin', bin)), bin);
  assert.equal(readFileSync(s.at('harness', 'lib', 'agent.sh'), 'utf8'), readFileSync(join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', 'in-vm', 'agent.sh'), 'utf8'));
  assert.equal(readFileSync(join(work, 'claude-installs'), 'utf8').trim(), s.at('harness', 'tools', 'claude'), 'claude\'s installer ran with HOME in ~/harness/tools');
  assert.equal(readFileSync(join(work, 'tool-installs'), 'utf8'), 'kustomize\n', 'only the missing tool handed to workstation-tools.sh');
  const runtime = join(s.w.runtime(ID), `harness-${process.getuid()}`);
  assert.equal(e.setup.runtime, runtime);
  assert.equal(e.setup.home, s.home);
  assert.equal(statSync(runtime).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(runtime, 'agent-url'), 'utf8'), `http://127.0.0.1:${fwd.port}/run\n`);
  assert.deepEqual(JSON.parse(readFileSync(s.at('harness', 'setup.json'), 'utf8')), { version, 'boot-id': `boot-${ID}-1`, runtime });

  // A harness session (sourcing ~/harness/env) finds its tools first, and agent.sh reaches the forwarder with the token ASS-435 puts in the runtime folder.
  writeFileSync(join(runtime, 'agent-token'), 'tok123\n');
  const session = await s.cli('workstation:ssh', 'p', ID, 'bash', '-c', '. ~/harness/env && echo "$HARNESS_RUNTIME" && command -v claude jq && agent.sh ticket:view ABC-1');
  assert.deepEqual(session.stdout.split('\n'), [runtime, s.at('harness', 'bin', 'claude'), s.at('harness', 'bin', 'jq'), 'hi', '']);
  assert.deepEqual(fwd.bodies, [{ url: '/run', body: { token: 'tok123', argv: ['ticket:view', 'ABC-1'] } }]);

  // AC4: the owner's files — shell files, git identity, SSH keys, ~/workspaces — as they were; nothing beside ~/harness.
  assert.deepEqual(snapshot(s.home), before);
});

test('AC2, AC5: a rerun with nothing missing does nothing — no installer, no file written — but records that it checked', async () => {
  const work = mkdtempSync(join(tmpdir(), 'wsdl-'));
  const s = setup({ tools: ['kustomize'], installer: `for t; do printf '#!/bin/bash\\n' > "$HARNESS_BIN/$t"; chmod 755 "$HARNESS_BIN/$t"; echo "$t" >> ${join(work, 'tool-installs')}; done\n` });
  await s.cli('workstation:connect', 'p', ID);
  await s.cli('workstation:setup', 'p', ID);
  const first = s.entry().setup;
  const files = snapshot(s.home, []);
  const runtime = snapshot(s.w.runtime(ID), []);
  await new Promise(r => setTimeout(r, 1100));   // a new checked-at second
  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true);
  assert.deepEqual(out.setup.did, []);
  assert.equal(out.setup['set-up-at'], first['set-up-at']);
  assert.notEqual(out.setup['checked-at'], first['checked-at']);
  assert.deepEqual(snapshot(s.home, []), files);
  assert.deepEqual(snapshot(s.w.runtime(ID), []), runtime);
  assert.equal(readFileSync(join(work, 'tool-installs'), 'utf8'), 'kustomize\n');
});

test('AC2: after the workstation restarts, setup empties the runtime folder and writes agent-url again, reinstalling nothing; a version rerun leaves the runtime folder alone', async () => {
  const s = setup();
  await s.cli('workstation:connect', 'p', ID);
  await s.cli('workstation:setup', 'p', ID);
  const runtime = s.entry().setup.runtime;
  writeFileSync(join(runtime, 'agent-token'), 'old\n');
  // A new version (the tools list changed): the runtime folder, and a running agent's token, kept.
  const p = JSON.parse(readFileSync(s.pj, 'utf8'));
  p['golden-image'].tools = ['git'];
  writeFileSync(s.pj, JSON.stringify(p));
  const again = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup;
  assert.deepEqual(again.did.map(d => d.replace(/ [0-9a-f]{12} .*/, '')), ['recorded setup']);
  assert.equal(readFileSync(join(runtime, 'agent-token'), 'utf8'), 'old\n');
  // A restart: stopped, started again by connect (a new boot id, the container's /dev/shm empty).
  s.w.setState(ID, 'STATE_STOPPED');
  for (let i = 0; i < 50 && existsSync(join(s.w.harnessHome, 'workstations', `p-${ID}.sock`)); i++) await new Promise(r => setTimeout(r, 100));
  // checked-at and connected-at are to the second (ws_now): a connect in setup's second would read as set up since it.
  while (new Date().toISOString().slice(0, 19) + 'Z' <= s.entry().setup['checked-at']) await new Promise(r => setTimeout(r, 50));
  await s.cli('workstation:connect', 'p', ID);
  assert.ok(!workstationUsable(s.entry()), 'not usable until setup runs after the connect');
  const after = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup;
  assert.equal(after.ok, true);
  assert.ok(after.did.some(d => /^made the runtime folder/.test(d)));
  assert.ok(after.did.some(d => /^wrote the forwarder's URL \(http:\/\/127\.0\.0\.1:7787\/run\)/.test(d)));
  assert.ok(!after.did.some(d => /^installed/.test(d)), 'nothing reinstalled');
  assert.ok(!existsSync(join(runtime, 'agent-token')));
  assert.equal(JSON.parse(readFileSync(s.at('harness', 'setup.json'), 'utf8'))['boot-id'], readFileSync(join(dirname(s.w.system(ID)), 'boot-id'), 'utf8'));
  // The same version on the same boot: nothing to do.
  assert.deepEqual(JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup.did, []);
});

test('AC3, AC5: a tool that cannot be installed fails setup, naming it, recorded in the live data; the workstation is not usable', async () => {
  const s = setup({ tools: ['kubeconform', 'git'] });
  await s.cli('workstation:connect', 'p', ID);
  const r = await s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 1);
  assert.match(r.err, /workstation:setup: p's workstation ada-dev: setup failed: kubeconform: not on the workstation, and the project has no golden-image\/workstation-tools\.sh to install it under \$HOME$/m);
  const e = s.entry();
  assert.equal(e.setup.ok, false);
  assert.deepEqual(e.setup.failed.map(x => x.what), ['kubeconform']);
  assert.ok(!workstationUsable(e));
  assert.ok(!existsSync(s.at('harness', 'setup.json')), 'no setup recorded on the workstation');
  // With an installer that does not install it: named so.
  const t = setup({ tools: ['kubeconform'], installer: 'echo "no kubeconform for you" >&2; exit 3\n' });
  await t.cli('workstation:connect', 'p', ID);
  const u = await t.result('workstation:setup', 'p', ID);
  assert.equal(u.code, 1);
  assert.match(u.err, /no kubeconform for you/);
  assert.equal(t.entry().setup.error, 'kubeconform: could not be installed: not on PATH after the project\'s golden-image/workstation-tools.sh (exit 3)');
  // Fixed (now on the workstation): the next run is ok again.
  writeFileSync(join(t.w.system(ID), 'kubeconform'), '#!/bin/bash\n', { mode: 0o755 });
  assert.equal(JSON.parse((await t.cli('workstation:setup', 'p', ID)).stdout).setup.ok, true);
  assert.equal(t.entry().setup.error, null);
});

test('AC3: Docker not usable, or not there, fails setup naming it; so does the Claude Code CLI failing to install', async () => {
  const s = setup();
  await s.cli('workstation:connect', 'p', ID);
  s.w.mark(ID, 'docker-broken');
  const r = await s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 1);
  assert.match(s.entry().setup.error, /^docker: not usable \(docker info failed\): permission denied while trying to connect to the Docker daemon socket/);
  rmSync(join(s.w.system(ID), 'docker'));
  writeFileSync(join(dirname(s.w.system(ID)), 'path'), await bareImage(['jq']));
  await s.result('workstation:setup', 'p', ID);
  assert.match(s.entry().setup.error, /^docker: not installed: the workstation config's container image has no Docker/);

  const t = setup({ env: { HARNESS_WS_CLAUDE_INSTALLER: 'file:///nonexistent/install.sh' } });
  writeFileSync(join(dirname(t.w.system(ID)), 'path'), await bareImage());
  rmSync(join(t.w.system(ID), 'claude'));
  writeFileSync(join(t.w.system(ID), 'jq'), '#!/bin/bash\n', { mode: 0o755 });
  await t.cli('workstation:connect', 'p', ID);
  assert.equal((await t.result('workstation:setup', 'p', ID)).code, 1);
  assert.deepEqual(t.entry().setup.failed.map(x => x.what), ['claude']);
  assert.match(t.entry().setup.error, /^claude: the Claude Code CLI could not be installed from file:\/\/\/nonexistent\/install\.sh: curl: /);
});

// ASS-500: sudo and `service` on the workstation, as its /etc/init.d/docker answers `service docker start`: each call
// logged to <work>/service; it starts dockerd in the background, which answers a second later (the docker-stopped
// marker gone) — unless a docker-wont-start marker says it dies again. A no-sudo file in <work> takes passwordless
// sudo away. HARNESS_WS_DOCKER_LOG is <work>/docker.log and the wait 2 s.
function dockerService(s) {
  const work = mkdtempSync(join(tmpdir(), 'wsdocker-')), sys = s.w.system(ID), ws = dirname(sys);
  writeFileSync(join(sys, 'sudo'), `#!/bin/bash\n[ "$1" = -n ] && shift\n[ -e ${join(work, 'no-sudo')} ] && { echo "sudo: a password is required" >&2; exit 1; }\nexec "$@"\n`, { mode: 0o755 });
  writeFileSync(join(sys, 'service'), `#!/bin/bash\necho "service $*" >> ${join(work, 'service')}\n[ "$*" = "docker start" ] || exit 1\necho "Starting Docker: docker."\n[ -e ${join(ws, 'docker-wont-start')} ] || (sleep 1; rm -f ${join(ws, 'docker-stopped')}) > /dev/null 2>&1 &\n`, { mode: 0o755 });
  Object.assign(s.w.env, { HARNESS_WS_DOCKER_LOG: join(work, 'docker.log'), HARNESS_WS_DOCKER_WAIT: '2' });
  const calls = () => (existsSync(join(work, 'service')) ? readFileSync(join(work, 'service'), 'utf8').trim().split('\n') : []);
  return { work, calls, log: join(work, 'docker.log') };
}

test('ASS-500 AC1, AC2, AC4: Docker\'s daemon not running (no dockerd), setup starts it once, waits for docker info and passes, saying so in did; a rerun with Docker answering starts nothing', async () => {
  const s = setup();
  const d = dockerService(s);
  await s.cli('workstation:connect', 'p', ID);
  s.w.mark(ID, 'docker-stopped');
  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true, out.setup.error);
  assert.deepEqual(out.setup.did.filter(x => /Docker \(/.test(x)), ['started Docker (sudo -n service docker start): docker info failed and no dockerd was running (Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?)']);
  assert.deepEqual(d.calls(), ['service docker start']);
  assert.ok(existsSync(s.at('harness', 'setup.json')), 'setup recorded');
  // AC4: Docker answering — never restarted.
  const again = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(again.setup.ok, true);
  assert.deepEqual(again.setup.did, []);
  assert.deepEqual(d.calls(), ['service docker start']);
});

test('ASS-500 AC2: Docker started but still not answering after the wait fails setup as before, the end of docker.log in its error; so does starting it without passwordless sudo', async () => {
  const s = setup();
  const d = dockerService(s);
  await s.cli('workstation:connect', 'p', ID);
  s.w.mark(ID, 'docker-stopped');
  s.w.mark(ID, 'docker-wont-start');
  writeFileSync(d.log, ['time="2026-11-17T22:23:01Z" level=info msg="Starting up"', '', 'time="2026-11-17T22:23:01Z" level=info msg="waiting for response from boltdb open" plugin=bolt',
    'failed to start containerd: timeout waiting for containerd to start', ''].join('\n'));
  const r = await s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 1);
  const e = s.entry();
  assert.deepEqual(e.setup.failed.map(x => x.what), ['docker']);
  assert.equal(e.setup.error, 'docker: not usable (docker info failed): Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?; '
    + 'no dockerd was running, and after starting it (sudo -n service docker start) docker info still failed for 2 s: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?; '
    + `${d.log} ends: time="2026-11-17T22:23:01Z" level=info msg="Starting up" | time="2026-11-17T22:23:01Z" level=info msg="waiting for response from boltdb open" plugin=bolt | failed to start containerd: timeout waiting for containerd to start`);
  assert.match(r.err, /failed to start containerd: timeout waiting for containerd to start/);
  assert.deepEqual(d.calls(), ['service docker start'], 'started once');
  assert.ok(!existsSync(s.at('harness', 'setup.json')), 'no setup recorded on the workstation');

  // Without passwordless sudo: Docker is not started, and the error says so, with the log's end.
  writeFileSync(join(d.work, 'no-sudo'), '');
  await s.result('workstation:setup', 'p', ID);
  assert.match(s.entry().setup.error, /^docker: not usable \(docker info failed\): Cannot connect to the Docker daemon at .*; no dockerd was running, and starting it \(sudo -n service docker start\) failed \(exit 1\): sudo: a password is required; .*docker\.log ends: .*failed to start containerd/);
  assert.deepEqual(d.calls(), ['service docker start']);
});

test('ASS-500 AC3, AC4: a running dockerd that docker info cannot reach (permissions) is never restarted, setup failing as before; nor is one that answers', async () => {
  const s = setup();
  const d = dockerService(s);
  await s.cli('workstation:connect', 'p', ID);
  assert.equal(JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup.ok, true);
  s.w.mark(ID, 'docker-broken');
  assert.equal((await s.result('workstation:setup', 'p', ID)).code, 1);
  assert.match(s.entry().setup.error, /^docker: not usable \(docker info failed\): permission denied while trying to connect to the Docker daemon socket [^;]*$/);
  assert.deepEqual(d.calls(), []);
});

test('AC2: the version is a hash of the setup script, agent.sh, workstation-tools.sh, the forwarder URL and the tools list — asked without a connection; setup without one fails', async () => {
  const s = setup({ tools: ['bats'] });
  const version = async () => (await s.cli('workstation:setup', 'p', ID, '--version')).stdout.trim();
  const v1 = await version();
  assert.equal(await version(), v1);
  const p = JSON.parse(readFileSync(s.pj, 'utf8'));
  p['golden-image'].tools = ['bats', 'go'];
  writeFileSync(s.pj, JSON.stringify(p));
  const v2 = await version();
  assert.notEqual(v2, v1);
  writeFileSync(join(s.f.dir, 'projects', 'p', 'golden-image', 'workstation-tools.sh'), 'true\n');
  assert.notEqual(await version(), v2);
  const r = await s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 1);
  assert.match(r.err, /has no open connection: workstation:connect p ada-dev first/);
  assert.equal((await s.result('workstation:setup', 'p', 'nobody')).code, 1);
  assert.equal((await s.result('workstation:setup', 'p')).code, 1);
});

test('rsync missing (example-config\'s image has none): installed with passwordless sudo, its packages fetched once into ~/harness/tools/debs and installed from there after a restart; without passwordless sudo setup fails naming rsync', async () => {
  const work = mkdtempSync(join(tmpdir(), 'wsapt-'));
  const realRsync = (await run('bash', ['-c', 'command -v rsync'])).stdout.trim();
  const s = setup();
  const sys = s.w.system(ID), log = join(work, 'log');
  const image = await bareImage(['jq']);
  rmSync(join(image, 'rsync'));
  writeFileSync(join(dirname(sys), 'path'), image);
  // sudo, apt-get and dpkg standing in: apt-get download finds nothing until the package lists are refreshed; dpkg -i puts rsync on PATH.
  writeFileSync(join(sys, 'sudo'), `#!/bin/bash\n[ "$1" = -n ] && shift\n[ -e ${join(work, 'no-sudo')} ] && { echo "sudo: a password is required" >&2; exit 1; }\n[ "$1" = true ] && exit 0\nexec "$@"\n`, { mode: 0o755 });
  writeFileSync(join(sys, 'apt-get'), `#!/bin/bash\necho "apt-get $*" >> ${log}\ncase "$1" in\n  update) : > ${join(work, 'updated')} ;;\n  download) [ -e ${join(work, 'updated')} ] || { echo "E: Can't select candidate version from package rsync as it has no candidate" >&2; exit 100; }; shift; for p; do echo deb > "\${p}_1.0_amd64.deb"; done ;;\nesac\n`, { mode: 0o755 });
  writeFileSync(join(sys, 'dpkg'), `#!/bin/bash\necho "dpkg $* DEBIAN_FRONTEND=$DEBIAN_FRONTEND" >> ${log}\nln -sf ${realRsync} ${join(sys, 'rsync')}\n`, { mode: 0o755 });
  const debs = s.at('harness', 'tools', 'debs');
  await s.cli('workstation:connect', 'p', ID);

  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true, out.setup.error);
  assert.ok(out.setup.did.some(d => d.startsWith('installed rsync')));
  assert.deepEqual(readdirSync(debs).sort(), ['libpopt0_1.0_amd64.deb', 'rsync_1.0_amd64.deb']);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'apt-get download rsync libpopt0', 'apt-get update -qq', 'apt-get download rsync libpopt0',
    `dpkg -i ${join(debs, 'libpopt0_1.0_amd64.deb')} ${join(debs, 'rsync_1.0_amd64.deb')} DEBIAN_FRONTEND=noninteractive`]);

  // A restart: rsync is gone again (only /home survives); the kept packages are installed, nothing downloaded.
  rmSync(join(sys, 'rsync'));
  writeFileSync(log, '');
  assert.equal(JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup.ok, true);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`dpkg -i ${join(debs, 'libpopt0_1.0_amd64.deb')} ${join(debs, 'rsync_1.0_amd64.deb')} DEBIAN_FRONTEND=noninteractive`]);

  // No passwordless sudo: setup fails, naming rsync.
  rmSync(join(sys, 'rsync'));
  writeFileSync(join(work, 'no-sudo'), '');
  assert.equal((await s.result('workstation:setup', 'p', ID)).code, 1);
  assert.deepEqual(s.entry().setup.failed.map(x => x.what), ['rsync']);
  assert.match(s.entry().setup.error, /^rsync: not installed, and there is no passwordless sudo to install it/);
});

// ASS-462: machine_run, as in_project runs a ci-check (code.bash), in a variation's folder on the workstation.
const MACHINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
const machineRun = (s, cmd) => {
  const folder = s.at('harness', 'ABC-3-A');
  mkdirSync(folder, { recursive: true });
  return run('bash', ['-c', `source "${MACHINE_BASH}" && machine_run --workdir / "workstation:p:${ID}:${folder}" -- bash -c '${cmd}'`], { env: s.w.env })
    .then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
};

test('ASS-462 AC1, AC2: a tool workstation-tools.sh installs from a file it shares with provision.sh is installed, on PATH in a harness session, and a bare run of it through machine_run exits its own status, never 127', async () => {
  assert.ok(!SHARED_INSTALLER.includes('install_gate()'), 'workstation-tools.sh sources the shared file, holds no copy of it');
  const s = setup({ tools: ['mytool'], installer: SHARED_INSTALLER, files: { ...SHARED, '.hidden': 'secret\n', 'sub/x.sh': 'true\n' } });
  writeFileSync(join(dirname(s.w.system(ID)), 'path'), await bareImage(['jq']));
  await s.cli('workstation:connect', 'p', ID);
  const before = await machineRun(s, 'mytool');
  assert.equal(before.code, 127, `not there before setup: ${before.err}`);

  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true, out.setup.error);
  assert.ok(out.setup.did.some(d => /^ran the project's workstation-tools\.sh for mytool/.test(d)), out.setup.did.join('; '));
  const found = await s.cli('workstation:ssh', 'p', ID, 'bash', '-c', '. ~/harness/env; command -v mytool');
  assert.equal(found.stdout.trim(), s.at('harness', 'bin', 'mytool'));

  // Shipped beside the installer in ~/harness/golden-image: the shared file, byte for byte; not Lima's files, dotfiles or subfolders.
  const gi = s.at('harness', 'golden-image');
  assert.deepEqual(readdirSync(gi).sort(), ['gate.sh', 'workstation-tools.sh']);
  assert.equal(readFileSync(join(gi, 'gate.sh'), 'utf8'), SHARED['gate.sh']);
  assert.equal(readFileSync(join(gi, 'workstation-tools.sh'), 'utf8'), SHARED_INSTALLER);
  assert.equal(statSync(join(gi, 'gate.sh')).mode & 0o777, 0o600);
  assert.equal(statSync(join(gi, 'workstation-tools.sh')).mode & 0o777, 0o700);
  assert.ok(!existsSync(s.at('harness', 'workstation-tools.sh')), 'not at the old place');

  // AC2: bare, as ci-checks:verify runs a check: the tool's own status.
  const ok = await machineRun(s, 'mytool');
  assert.equal(ok.code, 0, ok.err);
  const failed = await machineRun(s, 'MYTOOL_EXIT=1 mytool');
  assert.equal(failed.code, 1, failed.err);
});

test('ASS-462 AC1: a rerun with nothing missing leaves ~/harness/golden-image untouched and runs no installer', async () => {
  const s = setup({ tools: ['mytool'], installer: SHARED_INSTALLER, files: SHARED });
  await s.cli('workstation:connect', 'p', ID);
  assert.equal(JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup.ok, true);
  const files = snapshot(s.home, []);
  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true);
  assert.deepEqual(out.setup.did, []);
  assert.deepEqual(snapshot(s.home, []), files);
  assert.ok(existsSync(s.at('harness', 'golden-image', 'gate.sh')));
});

test('ASS-462 AC1: a golden-image file whose name is not a plain file name fails setup naming it, nothing written', async () => {
  for (const bad of ['a b.sh', '-x.sh']) {
    const s = setup({ tools: ['mytool'], installer: SHARED_INSTALLER, files: { ...SHARED, [bad]: 'true\n' } });
    await s.cli('workstation:connect', 'p', ID);
    const r = await s.result('workstation:setup', 'p', ID);
    assert.equal(r.code, 1, bad);
    assert.ok(r.err.includes(bad), `names ${bad}: ${r.err}`);
    assert.ok(!existsSync(s.at('harness', 'golden-image')), 'nothing shipped');
    assert.ok(!existsSync(s.at('harness', 'setup.json')), 'no setup recorded');
  }
});

test('ASS-462 AC1: a shared file\'s install failing fails setup naming the tool, with the installer\'s own exit', async () => {
  const s = setup({ tools: ['mytool'], installer: SHARED_INSTALLER, files: { 'gate.sh': 'install_gate() { echo "no gate" >&2; exit 3; }\n' } });
  await s.cli('workstation:connect', 'p', ID);
  const r = await s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 1);
  assert.match(r.err, /no gate/);
  assert.equal(s.entry().setup.error, 'mytool: could not be installed: not on PATH after the project\'s golden-image/workstation-tools.sh (exit 3)');
});

test('ASS-462 AC3: the version changes with the golden-image files shipped to workstation-tools.sh, not with Lima\'s; a project without workstation-tools.sh keeps its version', async () => {
  const s = setup({ tools: ['mytool'], installer: SHARED_INSTALLER, files: SHARED });
  const gi = join(s.f.dir, 'projects', 'p', 'golden-image');
  const version = async t => (await t.cli('workstation:setup', 'p', ID, '--version')).stdout.trim();
  const v1 = await version(s);
  writeFileSync(join(gi, 'provision.sh'), 'echo changed\n');
  writeFileSync(join(gi, 'template.yaml'), 'images: [x]\n');
  assert.equal(await version(s), v1, 'Lima-only files not in the version');
  writeFileSync(join(gi, 'gate.sh'), `${SHARED['gate.sh']}# changed\n`);
  const v2 = await version(s);
  assert.notEqual(v2, v1, 'the shared file changed');
  writeFileSync(join(gi, 'more.sh'), 'true\n');
  const v3 = await version(s);
  assert.notEqual(v3, v2, 'a shared file added');
  writeFileSync(join(gi, 'gate2.sh'), readFileSync(join(gi, 'gate.sh')));
  rmSync(join(gi, 'gate.sh'));
  assert.notEqual(await version(s), v3, 'a shared file renamed');

  // No workstation-tools.sh: its other golden-image files are not shipped, so not in its version.
  const t = setup({ tools: ['mytool'] });
  const before = await version(t);
  writeFileSync(join(t.f.dir, 'projects', 'p', 'golden-image', 'gate.sh'), SHARED['gate.sh']);
  assert.equal(await version(t), before);
});

test('ASS-474 AC3: bats, named in the project\'s tools and missing, is installed by setup from its release tarball under ~/harness/tools/bats, on PATH in a harness session, the project\'s workstation-tools.sh not needed for it; a rerun installs nothing; a project not naming it gets none', async () => {
  const work = mkdtempSync(join(tmpdir(), 'wsbats-'));
  // bats-core's tarball, standing in: one top folder, bin/bats finding libexec/ through its link as the real one does.
  const top = join(work, 'src', 'bats-core-1.11.1');
  mkdirSync(join(top, 'bin'), { recursive: true }); mkdirSync(join(top, 'libexec', 'bats-core'), { recursive: true });
  writeFileSync(join(top, 'bin', 'bats'), '#!/bin/bash\nroot="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"\nexec "$root/libexec/bats-core/bats" "$@"\n', { mode: 0o755 });
  writeFileSync(join(top, 'libexec', 'bats-core', 'bats'), '#!/bin/bash\necho "Bats 1.11.1"\n', { mode: 0o755 });
  await run('tar', ['-czf', join(work, 'bats.tar.gz'), '-C', join(work, 'src'), 'bats-core-1.11.1']);
  const s = setup({ tools: ['bats'], env: { HARNESS_WS_BATS_URL: `file://${join(work, 'bats.tar.gz')}` } });
  writeFileSync(join(dirname(s.w.system(ID)), 'path'), await bareImage(['jq', 'tar', 'gzip', 'readlink']));
  await s.cli('workstation:connect', 'p', ID);
  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true, out.setup.error);
  assert.ok(out.setup.did.includes(`installed bats (${s.at('harness', 'bin', 'bats')})`), out.setup.did.join('; '));
  assert.ok(!out.setup.did.some(d => /workstation-tools\.sh/.test(d)), 'no project installer run for it');
  assert.ok(existsSync(s.at('harness', 'tools', 'bats', 'bin', 'bats')));
  const session = await s.cli('workstation:ssh', 'p', ID, 'bash', '-c', '. ~/harness/env && command -v bats && bats --version');
  assert.deepEqual(session.stdout.split('\n'), [s.at('harness', 'bin', 'bats'), 'Bats 1.11.1', '']);
  assert.deepEqual(JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup.did, [], 'a rerun installs nothing');
  // Not named: never fetched (its URL here one that would fail).
  const t = setup({ tools: [], env: { HARNESS_WS_BATS_URL: `file://${join(work, 'none.tar.gz')}` } });
  writeFileSync(join(dirname(t.w.system(ID)), 'path'), await bareImage(['jq', 'tar', 'gzip']));
  await t.cli('workstation:connect', 'p', ID);
  const plain = JSON.parse((await t.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(plain.setup.ok, true, plain.setup.error);
  assert.ok(!plain.setup.did.some(d => /bats/.test(d)));
  // A tarball without bin/bats fails setup naming bats.
  const u = setup({ tools: ['bats'], env: { HARNESS_WS_BATS_URL: `file://${join(work, 'none.tar.gz')}` } });
  writeFileSync(join(dirname(u.w.system(ID)), 'path'), await bareImage(['jq', 'tar', 'gzip']));
  await u.cli('workstation:connect', 'p', ID);
  await u.cli('workstation:setup', 'p', ID).catch(() => {});
  assert.match(u.entry().setup.error, /^bats: could not be installed from file:/);
});

// ASS-471: ci-checks.json's checks, as a client project's: a gate run bare, scripts run by sh and bash after assignments and
// an export, a repository script by its path, and a check declaring a command its scripts run (sqlfluff).
const CHECKS = { repositories: {
  'example-project': [
    { name: 'secret-scan-mr', command: 'CI_BASE="$CI_CHECK_BASE" sh scripts/ci/secret-scan.sh', baseline: false },
    { name: 'static-policy-gate', command: 'mygate', needs: ['sqlfluff'] },
    { name: 'lint', command: 'export A=/repos/x; bash clusters/a.sh && scripts/b.sh', changes: ['clusters/**'] }],
  'example-corpus': [{ name: 'static-policy-gate', command: 'mygate', needs: ['sqlfluff'] }],
} };
// An installer that installs each command it is handed, logging the names.
const installing = log => `set -e\nfor t; do printf '#!/bin/bash\\necho %s\\n' "$t" > "$HARNESS_TOOLS/$t"; chmod 755 "$HARNESS_TOOLS/$t"; ln -sf "$HARNESS_TOOLS/$t" "$HARNESS_BIN/$t"; echo "$t" >> ${log}; done\n`;

test('ASS-471 AC1, AC4: a command ci-checks.json\'s checks run, or declare they need, missing from the workstation fails setup naming it and the checks that run it', async () => {
  const s = setup({ tools: ['git'], files: { 'ci-checks.json': JSON.stringify(CHECKS) } });
  writeFileSync(join(dirname(s.w.system(ID)), 'path'), await bareImage(['jq']));
  await s.cli('workstation:connect', 'p', ID);
  const r = await s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 1);
  const e = s.entry();
  assert.equal(e.setup.ok, false);
  assert.deepEqual(e.setup.failed.map(x => x.what), ['mygate', 'sqlfluff'], 'sh and bash are there; export a builtin; scripts/b.sh the repository\'s');
  assert.equal(e.setup.failed[0].why, 'not on the workstation, and the project has no golden-image/workstation-tools.sh to install it under $HOME; ci-checks.json\'s static-policy-gate (example-project and example-corpus) needs it');
  assert.match(r.err, /setup failed: mygate: not on the workstation, .*; ci-checks\.json's static-policy-gate \(example-project and example-corpus\) needs it; sqlfluff: /);
  assert.ok(!workstationUsable(e));

  // A command that is there passes: mygate on the image, sqlfluff still missing.
  writeFileSync(join(s.w.system(ID), 'mygate'), '#!/bin/bash\n', { mode: 0o755 });
  await s.result('workstation:setup', 'p', ID);
  assert.deepEqual(s.entry().setup.failed.map(x => x.what), ['sqlfluff']);

  // An installer that does not install it: named so, with the checks.
  const t = setup({ files: { 'ci-checks.json': JSON.stringify(CHECKS) }, installer: 'exit 4\n' });
  writeFileSync(join(dirname(t.w.system(ID)), 'path'), await bareImage(['jq']));
  await t.cli('workstation:connect', 'p', ID);
  assert.equal((await t.result('workstation:setup', 'p', ID)).code, 1);
  assert.equal(t.entry().setup.failed[0].why, 'could not be installed: not on PATH after the project\'s golden-image/workstation-tools.sh (exit 4); ci-checks.json\'s static-policy-gate (example-project and example-corpus) needs it');
});

test('ASS-471 AC2, AC4: the commands ci-checks.json needs that are missing go to workstation-tools.sh with the missing tools, each once; installed, setup passes and a check runs them bare', async () => {
  const work = mkdtempSync(join(tmpdir(), 'wsci-'));
  const s = setup({ tools: ['kustomize', 'mygate'], files: { 'ci-checks.json': JSON.stringify(CHECKS) }, installer: installing(join(work, 'installs')) });
  writeFileSync(join(dirname(s.w.system(ID)), 'path'), await bareImage(['jq']));
  await s.cli('workstation:connect', 'p', ID);
  const out = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true, out.setup.error);
  assert.ok(out.setup.did.includes('ran the project\'s workstation-tools.sh for kustomize mygate sqlfluff (exit 0)'), out.setup.did.join('; '));
  assert.equal(readFileSync(join(work, 'installs'), 'utf8'), 'kustomize\nmygate\nsqlfluff\n');
  // Nothing missing now: a rerun runs no installer.
  assert.deepEqual(JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup.did, []);
  assert.equal(readFileSync(join(work, 'installs'), 'utf8'), 'kustomize\nmygate\nsqlfluff\n');
  assert.equal((await machineRun(s, 'mygate && sqlfluff')).code, 0, 'run bare, as ci-checks:verify runs a check');
});

test('ASS-471 AC1: the version changes with the commands ci-checks.json needs, not with the rest of it; a ci-checks.json that is not JSON fails setup', async () => {
  const s = setup({ tools: ['bats'] });
  const file = join(s.f.dir, 'projects', 'p', 'golden-image', 'ci-checks.json');
  const version = async () => (await s.cli('workstation:setup', 'p', ID, '--version')).stdout.trim();
  const v0 = await version();
  writeFileSync(file, JSON.stringify(CHECKS));
  const v1 = await version();
  assert.notEqual(v1, v0, 'its commands checked now');
  writeFileSync(file, JSON.stringify({ repositories: { ...CHECKS.repositories, 'example-project': CHECKS.repositories['example-project'].map(c => ({ ...c, changes: ['other/**'] })) } }));
  assert.equal(await version(), v1, 'a changes glob is not a command');
  writeFileSync(file, JSON.stringify({ repositories: { ...CHECKS.repositories, 'example-corpus': [{ name: 'static-policy-gate', command: 'mygate', needs: ['sqlfluff', 'uv'] }] } }));
  assert.notEqual(await version(), v1, 'a command declared');
  writeFileSync(file, JSON.stringify({ repositories: {} }));
  assert.equal(await version(), v0, 'no command: as without the file');
  writeFileSync(file, '{ not json');
  const r = await s.result('workstation:setup', 'p', ID, '--version');
  assert.equal(r.code, 1);
  assert.match(r.err, /ci-checks\.json: not valid JSON/);
});

// ASS-504: the restart watcher. watchers(s) — the pids of the processes running a watcher for the workstation's
// runtime folder (the fake runs them on this Mac); pidFile(s) — its restart-watcher.pid, [pid, version] or null.
const runtimeOf = s => join(s.w.runtime(ID), `harness-${process.getuid()}`);
const watchers = async s => (await run('pgrep', ['-f', `restart-watcher.sh ${runtimeOf(s)} `]).catch(() => ({ stdout: '' }))).stdout.split('\n').filter(Boolean).map(Number);
const pidFile = s => (existsSync(join(runtimeOf(s), 'restart-watcher.pid')) ? readFileSync(join(runtimeOf(s), 'restart-watcher.pid'), 'utf8').trim().split(' ') : null);
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
// ASS-545: the default is LOADED_MS, a hang guard only (a check that comes true returns at once), not 5 s.
const waitFor = async (check, ms = LOADED_MS) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 25))) if (await check()) return true; return check(); };
const WATCHER_WAIT = 600;   // ASS-545: the watcher's seconds between checks in the "at once" tests, far past LOADED_MS
const WATCHER = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'workstation', 'on-workstation', 'restart-watcher.sh');
// warm(s) — the installed agent.sh and its wrapper run once, at a forwarder nothing listens on: macOS checks a newly
// written executable on its first run, which under load takes seconds (a Linux VM has no such check), and the 2 s
// budget is the watcher's, not this Mac's.
const warm = s => run(s.at('harness', 'bin', 'agent.sh'), ['warm-up'], { env: { ...s.w.env, HOME: s.home, AGENT_FORWARDER_URL: 'http://127.0.0.1:9/run' } }).catch(() => {});
const watcherVersion = () => createHash('sha256').update(readFileSync(WATCHER)).digest('hex');

// A metadata server: instance/preempted answers `flag` (FALSE until set) to a request with Metadata-Flavor: Google
// (403 without); with ?wait_for_change=true it answers when the flag changes, or after timeout_sec as it is.
async function metadata() {
  const m = { flag: 'FALSE', asked: [], waiting: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    m.asked.push({ path: url.pathname, flavor: req.headers['metadata-flavor'] ?? null, wait: url.searchParams.get('wait_for_change') });
    if (req.headers['metadata-flavor'] !== 'Google' || url.pathname !== '/computeMetadata/v1/instance/preempted') { res.writeHead(403).end(); return; }
    if (url.searchParams.get('wait_for_change') !== 'true') { res.end(m.flag); return; }
    const was = m.flag, answer = () => { clearTimeout(timer); m.waiting = m.waiting.filter(w => w !== answer); if (!res.writableEnded) res.end(m.flag); };
    const timer = setTimeout(answer, Number(url.searchParams.get('timeout_sec') ?? 60) * 1000);
    m.waiting.push(() => { if (m.flag !== was) answer(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  m.url = `http://127.0.0.1:${server.address().port}/computeMetadata/v1/instance/preempted`;
  m.set = flag => { m.flag = flag; for (const w of [...m.waiting]) w(); };
  return m;
}

test('ASS-504 AC1: setup starts exactly one restart watcher, as the workstation user, its pid and version in the runtime folder; a second setup starts no second; after a restart setup starts it again', async () => {
  const s = setup();
  await s.cli('workstation:connect', 'p', ID);
  const first = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup;
  assert.equal(first.ok, true, first.error);
  assert.ok(first.did.some(d => d === `installed the restart watcher (${s.at('harness', 'lib', 'restart-watcher.sh')})`), first.did.join('\n'));
  const [pid, version] = pidFile(s);
  assert.ok(first.did.includes(`started the restart watcher (pid ${pid})`), first.did.join('\n'));
  assert.equal(version, watcherVersion());
  assert.deepEqual(await watchers(s), [Number(pid)]);
  assert.equal((await run('ps', ['-o', 'user=', '-p', pid])).stdout.trim(), (await run('id', ['-un'])).stdout.trim(), 'the ssh user\'s own');
  assert.equal(readFileSync(s.at('harness', 'lib', 'restart-watcher.sh'), 'utf8'), readFileSync(WATCHER, 'utf8'));

  const again = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup;
  assert.deepEqual(again.did, []);
  assert.deepEqual(await watchers(s), [Number(pid)], 'still the one');

  // A restart: its processes gone (the fake's watcher ends itself once the runtime folder is emptied), a new boot.
  s.w.setState(ID, 'STATE_STOPPED');
  for (let i = 0; i < 50 && existsSync(join(s.w.harnessHome, 'workstations', `p-${ID}.sock`)); i++) await new Promise(r => setTimeout(r, 100));
  await s.cli('workstation:connect', 'p', ID);
  assert.ok(await waitFor(() => gone(Number(pid))), 'the old watcher is gone with its boot');
  const after = JSON.parse((await s.cli('workstation:setup', 'p', ID)).stdout).setup;
  const [pid2] = pidFile(s);
  assert.notEqual(pid2, pid);
  assert.ok(after.did.includes(`started the restart watcher (pid ${pid2})`), after.did.join('\n'));
  assert.deepEqual(await watchers(s), [Number(pid2)]);
});

test('ASS-504 AC6: setup\'s version changes with the restart watcher; a watcher of another version is replaced, quietly — not fired — and one runs', async () => {
  const fwd = await forwarder();
  const s = setup({ forwarder: fwd.port });
  // A copy of the agent-cli commands whose watcher differs (AGENT_CLI_DIR), beside the rest of src/ (linked).
  const src = join(import.meta.dirname, '..', '..', 'src'), tree = join(mkdtempSync(join(tmpdir(), 'cli-')), 'src'), copy = join(tree, 'agent-cli');
  mkdirSync(tree);
  for (const name of readdirSync(src)) if (name !== 'agent-cli') symlinkSync(join(src, name), join(tree, name));
  cpSync(join(src, 'agent-cli'), copy, { recursive: true });
  const changed = { ...s.w.env, AGENT_CLI_DIR: copy };
  const version = async env => (await run(AGENT, ['workstation:setup', 'p', ID, '--version'], { env })).stdout.trim();
  const v1 = await version(s.w.env);
  assert.equal(await version(changed), v1, 'the same files, the same version');
  writeFileSync(join(copy, 'workstation', 'on-workstation', 'restart-watcher.sh'), `${readFileSync(WATCHER, 'utf8')}# changed\n`);
  assert.notEqual(await version(changed), v1);

  await s.cli('workstation:connect', 'p', ID);
  await s.cli('workstation:setup', 'p', ID);
  const [pid] = pidFile(s);
  const out = JSON.parse((await run(AGENT, ['workstation:setup', 'p', ID], { env: changed })).stdout).setup;
  const [pid2, version2] = pidFile(s);
  assert.notEqual(pid2, pid);
  assert.equal(version2, createHash('sha256').update(readFileSync(join(copy, 'workstation', 'on-workstation', 'restart-watcher.sh'))).digest('hex'));
  assert.ok(out.did.includes(`started the restart watcher (pid ${pid2}, replacing pid ${pid} (version ${watcherVersion().slice(0, 12)}))`), out.did.join('\n'));
  assert.ok(await waitFor(() => gone(Number(pid))));
  assert.deepEqual(await watchers(s), [Number(pid2)]);
  assert.deepEqual(fwd.bodies, [], 'the replaced watcher told the Mac nothing');
});

test('ASS-504 AC2: when the metadata server\'s preempted flag turns TRUE, the watcher calls agent.sh machine:restart-imminent with the runtime folder\'s token at once, and once', async () => {
  const fwd = await forwarder(), m = await metadata();
  // ASS-545: the watcher's waits are 600 s (HARNESS_WS_WATCHER_SECONDS), far past waitFor's LOADED_MS hang guard, so
  // "at once" is told apart from "at its next check" by the guard, not by a 2 s limit a loaded Mac outlasted.
  const s = setup({ forwarder: fwd.port, env: { HARNESS_WS_METADATA_URL: m.url, HARNESS_WS_WATCHER_SECONDS: String(WATCHER_WAIT) } });
  await s.cli('workstation:connect', 'p', ID);
  await s.cli('workstation:setup', 'p', ID);
  writeFileSync(join(runtimeOf(s), 'agent-token'), 'tok504\n');
  await warm(s);
  const [pid] = pidFile(s);
  assert.ok(await waitFor(() => m.waiting.length > 0), 'it waits on the flag');
  assert.ok(m.asked.every(a => a.flavor === 'Google'));
  assert.deepEqual(fwd.bodies, []);
  m.set('TRUE');
  assert.ok(await waitFor(() => fwd.bodies.length > 0), 'the Mac told at once, not at the watcher\'s next check');
  assert.deepEqual(fwd.bodies, [{ url: '/run', body: { token: 'tok504', argv: ['machine:restart-imminent'] } }]);
  assert.ok(existsSync(join(runtimeOf(s), 'restart-watcher.fired')));
  // The shutdown that follows tells it nothing more.
  process.kill(Number(pid), 'SIGTERM');
  assert.ok(await waitFor(() => gone(Number(pid))));
  assert.equal(fwd.bodies.length, 1);
  const log = readFileSync(s.at('harness', 'restart-watcher.log'), 'utf8');
  assert.match(log, /watching for a preemption or the shutdown signal/);
  assert.match(log, /restart imminent \(preempted\): telling the agents on this machine/);
});

test('ASS-504 AC3, AC5: with no metadata server the watcher says so as a note, nothing alarming, and SIGTERM (a shutdown) tells the Mac at once; SIGHUP too, once a boot', async () => {
  const fwd = await forwarder();
  // ASS-545: its naps are 600 s (as above), so a signal handled only once a nap ends fails at waitFor's hang guard.
  const s = setup({ forwarder: fwd.port, env: { HARNESS_WS_WATCHER_SECONDS: String(WATCHER_WAIT) } });
  await s.cli('workstation:connect', 'p', ID);
  await s.cli('workstation:setup', 'p', ID);
  writeFileSync(join(runtimeOf(s), 'agent-token'), 'tok504\n');
  await warm(s);
  const [pid] = pidFile(s);
  process.kill(Number(pid), 'SIGTERM');
  assert.ok(await waitFor(() => fwd.bodies.length > 0), 'the Mac told at once, not when its nap ends');
  assert.deepEqual(fwd.bodies.map(b => b.body.argv), [['machine:restart-imminent']]);
  assert.ok(await waitFor(() => gone(Number(pid))));
  assert.equal(pidFile(s), null, 'its pid file removed as it ends');
  const log = readFileSync(s.at('harness', 'restart-watcher.log'), 'utf8');
  assert.match(log, /watching for the shutdown signal alone: no metadata server at .* \(a GCP workstation, or not a GCP VM\)/);
  assert.match(log, /restart imminent \(shutdown signal SIGTERM\)/);
  assert.doesNotMatch(log, /error|fail|cannot|could not|curl:/i);

  // Started again in the same boot (setup rerun), it never fires a second time; on a new boot (the marker gone) SIGHUP fires.
  await s.cli('workstation:setup', 'p', ID);
  let [again] = pidFile(s);
  process.kill(Number(again), 'SIGTERM');
  assert.ok(await waitFor(() => gone(Number(again))));
  assert.equal(fwd.bodies.length, 1, 'once a boot');
  rmSync(join(runtimeOf(s), 'restart-watcher.fired'));
  await s.cli('workstation:setup', 'p', ID);
  [again] = pidFile(s);
  process.kill(Number(again), 'SIGHUP');
  assert.ok(await waitFor(() => fwd.bodies.length === 2));
  assert.match(readFileSync(s.at('harness', 'restart-watcher.log'), 'utf8'), /restart imminent \(shutdown signal SIGHUP\)/);
});

test('ASS-555 AC2: setup probes Claude Code\'s sandbox — bubblewrap and socat on PATH, bwrap able to make one — records it as setup.sandbox and never fails setup for it', async () => {
  const s = setup();
  const sys = s.w.system(ID);
  const tool = (name, body) => writeFileSync(join(sys, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // ASS-563: no passwordless sudo, so nothing can be installed for it.
  tool('sudo', 'echo "sudo: a password is required" >&2; exit 1');
  for (const t of ['bwrap', 'socat']) rmSync(join(sys, t));
  writeFileSync(join(dirname(sys), 'path'), await bareImage(['jq', 'readlink']));
  await s.cli('workstation:connect', 'p', ID);
  await s.cli('workstation:setup', 'p', ID);
  assert.equal(s.entry().setup.ok, true, 'a machine without it is still set up: its other targets use it');
  assert.equal(s.entry().setup.error, null);
  assert.equal(s.entry().setup.sandbox.ok, false);
  assert.match(s.entry().setup.sandbox.why, /^bubblewrap socat not installed \(Claude Code's sandbox needs bubblewrap and socat\): bubblewrap socat: not installed, and there is no passwordless sudo/);
  tool('socat', 'exit 0');
  tool('bwrap', 'echo "bwrap: setting up uid map: Permission denied" >&2; exit 1');
  await s.cli('workstation:setup', 'p', ID);
  assert.equal(s.entry().setup.ok, true);
  assert.deepEqual(s.entry().setup.sandbox, { ok: false, why: 'bwrap could not make a sandbox: bwrap: setting up uid map: Permission denied' }, 'no AppArmor restriction here: nothing to load');
  tool('bwrap', '[[ " $* " == *" --unshare-all "* && " $* " == *" -- true "* ]] && exit 0; exit 9');
  await s.cli('workstation:setup', 'p', ID);
  assert.deepEqual(s.entry().setup.sandbox, { ok: true });
});

// ASS-563: a machine as the project's cloud VM was found (Ubuntu 24.04): no bwrap, no socat, and AppArmor restricting
// unprivileged user namespaces. Standing in: sudo (refused while <work>/no-sudo exists), apt-get (its package lists
// stale until `update`: -s install names nothing; then bubblewrap, socat and a library socat needs), dpkg (puts bwrap
// and socat on PATH), apparmor_parser (marks the profile loaded, unless <work>/parser-refuses), and bwrap, which makes
// a sandbox only once a profile is loaded (the sysctl's file, HARNESS_WS_USERNS_RESTRICT, says 1). A `sysctl` logs any
// call, which must never come. Everything each is asked goes to <work>/log.
async function sandboxMachine({ ubuntuProfile = true } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'wssbx-'));
  const log = join(work, 'log'), restrict = join(work, 'restrict'), extra = join(work, 'extra-profiles'), loaded = join(work, 'loaded');
  writeFileSync(restrict, '1\n');
  mkdirSync(extra);
  if (ubuntuProfile) writeFileSync(join(extra, 'bwrap-userns-restrict'), 'abi <abi/4.0>,\nprofile bwrap /usr/bin/bwrap { userns, }\n');
  const s = setup({ env: { HARNESS_WS_USERNS_RESTRICT: restrict, HARNESS_WS_APPARMOR_EXTRA: extra } });
  const sys = s.w.system(ID);
  const tool = (name, body) => writeFileSync(join(sys, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const t of ['bwrap', 'socat']) rmSync(join(sys, t));
  writeFileSync(join(dirname(sys), 'path'), await bareImage(['jq', 'readlink']));
  tool('sudo', `[ "$1" = -n ] && shift\n[ -e ${join(work, 'no-sudo')} ] && { echo "sudo: a password is required" >&2; exit 1; }\n[ "$1" = true ] && exit 0\necho "sudo $*" >> ${log}\nexec "$@"`);
  tool('apt-get', `echo "apt-get $*" >> ${log}\ncase "$1" in\n  update) : > ${join(work, 'updated')} ;;\n  -s) [ -e ${join(work, 'updated')} ] || { echo "E: Unable to locate package bubblewrap" >&2; exit 100; }; echo "NOTE: This is only a simulation!"; for p in libwrap0 bubblewrap socat; do echo "Inst $p (1.0 Ubuntu:24.04/noble [amd64])"; done ;;\n  download) shift; for p; do echo deb > "\${p}_1.0_amd64.deb"; done ;;\nesac`);
  const bwrap = `#!/bin/bash\n[ -e ${loaded} ] && exit 0\necho "bwrap: setting up uid map: Permission denied" >&2; exit 1\n`;
  writeFileSync(join(work, 'bwrap'), bwrap, { mode: 0o755 });
  writeFileSync(join(work, 'socat'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  tool('dpkg', `echo "dpkg $* DEBIAN_FRONTEND=$DEBIAN_FRONTEND" >> ${log}\ncp ${join(work, 'bwrap')} ${join(work, 'socat')} ${sys}/`);
  tool('apparmor_parser', `echo "apparmor_parser $*" >> ${log}\n[ -e ${join(work, 'parser-refuses')} ] && { echo "apparmor_parser: Unable to replace \\"bwrap\\".  Permission denied; attempted to load a profile while confined?" >&2; exit 1; }\n: > ${loaded}`);
  tool('sysctl', `echo "sysctl $*" >> ${log}`);
  await s.cli('workstation:connect', 'p', ID);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const fresh = () => writeFileSync(log, '');
  return { s, sys, work, log, restrict, extra, loaded, calls, fresh, debs: s.at('harness', 'tools', 'debs', 'sandbox') };
}

test('ASS-563 AC1: without bwrap and socat setup installs both from packages kept under ~/harness/tools/debs/sandbox (with the dependencies the machine lacks), saying so in did; a rerun with them there changes nothing; after a restart they come from the kept packages', async () => {
  const m = await sandboxMachine();
  const out = JSON.parse((await m.s.cli('workstation:setup', 'p', ID)).stdout);
  assert.equal(out.setup.ok, true, out.setup.error);
  assert.deepEqual(out.setup.sandbox, { ok: true });
  assert.ok(out.setup.did.includes(`installed bubblewrap socat for Claude Code's sandbox (sudo dpkg -i, the packages kept in ${m.debs})`), out.setup.did.join('\n'));
  assert.deepEqual(readdirSync(m.debs).sort(), ['bubblewrap_1.0_amd64.deb', 'libwrap0_1.0_amd64.deb', 'socat_1.0_amd64.deb']);
  const debs = ['bubblewrap', 'libwrap0', 'socat'].map(p => join(m.debs, `${p}_1.0_amd64.deb`)).join(' ');
  assert.deepEqual(m.calls().filter(c => !c.startsWith('apparmor_parser') && !c.startsWith('sudo apparmor_parser')), [
    'apt-get -s install --no-install-recommends bubblewrap socat', 'sudo apt-get update -qq', 'apt-get update -qq',
    'apt-get -s install --no-install-recommends bubblewrap socat', 'apt-get download libwrap0 bubblewrap socat',
    `sudo env DEBIAN_FRONTEND=noninteractive dpkg -i ${debs}`, `dpkg -i ${debs} DEBIAN_FRONTEND=noninteractive`]);
  assert.ok(m.s.at('harness', 'tools', 'debs', 'sandbox').startsWith(m.s.home), 'kept under $HOME');

  // A rerun with both there: nothing installed, nothing loaded, nothing said.
  m.fresh();
  const again = JSON.parse((await m.s.cli('workstation:setup', 'p', ID)).stdout);
  assert.deepEqual(m.calls(), []);
  assert.deepEqual(again.setup.did, []);
  assert.deepEqual(again.setup.failed, []);
  assert.deepEqual(again.setup.sandbox, { ok: true });

  // A restart: both gone again (only /home survives), and the profile with them; installed from the kept packages, nothing downloaded.
  for (const t of ['bwrap', 'socat']) rmSync(join(m.sys, t));
  rmSync(m.loaded);
  m.fresh();
  const after = JSON.parse((await m.s.cli('workstation:setup', 'p', ID)).stdout);
  assert.deepEqual(after.setup.sandbox, { ok: true });
  assert.deepEqual(m.calls().filter(c => /dpkg|apt-get/.test(c)), [`sudo env DEBIAN_FRONTEND=noninteractive dpkg -i ${debs}`, `dpkg -i ${debs} DEBIAN_FRONTEND=noninteractive`]);
});

test('ASS-563 AC2: with apparmor_restrict_unprivileged_userns at 1 setup loads Ubuntu\'s own bwrap-userns-restrict when the apparmor package ships it, else a minimal profile allowing bwrap user namespaces; re-applied after every start; the sysctl never changed', async () => {
  const m = await sandboxMachine();
  const ubuntu = join(m.extra, 'bwrap-userns-restrict');
  const out = JSON.parse((await m.s.cli('workstation:setup', 'p', ID)).stdout);
  assert.deepEqual(out.setup.sandbox, { ok: true });
  assert.deepEqual(m.calls().filter(c => /apparmor/.test(c)), [`sudo apparmor_parser -r ${ubuntu}`, `apparmor_parser -r ${ubuntu}`]);
  assert.ok(out.setup.did.includes(`loaded bwrap's AppArmor profile (${ubuntu}) allowing it user namespaces (apparmor_restrict_unprivileged_userns is 1)`), out.setup.did.join('\n'));
  // A rerun: bwrap makes its sandbox, nothing loaded again.
  m.fresh();
  assert.deepEqual(JSON.parse((await m.s.cli('workstation:setup', 'p', ID)).stdout).setup.did, []);
  assert.deepEqual(m.calls(), []);
  // A start drops the kernel's profiles: the next setup loads it again.
  rmSync(m.loaded);
  const restarted = JSON.parse((await m.s.cli('workstation:setup', 'p', ID)).stdout);
  assert.deepEqual(restarted.setup.sandbox, { ok: true });
  assert.deepEqual(m.calls().filter(c => /^apparmor_parser/.test(c)), [`apparmor_parser -r ${ubuntu}`]);

  // No Ubuntu profile shipped: the minimal one, written under ~/harness/tools/apparmor, for bwrap's own path.
  rmSync(ubuntu);
  rmSync(m.loaded);
  m.fresh();
  const minimal = JSON.parse((await m.s.cli('workstation:setup', 'p', ID)).stdout);
  const file = m.s.at('harness', 'tools', 'apparmor', 'bwrap');
  assert.deepEqual(minimal.setup.sandbox, { ok: true });
  assert.deepEqual(m.calls().filter(c => /^apparmor_parser/.test(c)), [`apparmor_parser -r ${file}`]);
  const bwrapPath = (await run('bash', ['-c', `readlink -f ${join(m.sys, 'bwrap')}`])).stdout.trim();
  assert.equal(readFileSync(file, 'utf8'), `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile bwrap ${bwrapPath} flags=(unconfined) {\n  userns,\n}\n`);

  // The sysctl is read, never written.
  assert.equal(readFileSync(m.restrict, 'utf8'), '1\n');
  assert.ok(!readFileSync(m.log, 'utf8').includes('sysctl'));
  assert.ok(!m.s.w.sudoCalls(ID).some(c => /sysctl/.test(c)));
});

test('ASS-563 AC3: an install without passwordless sudo, or apparmor_parser refusing the profile, is said in setup.sandbox.why and in failed (marked sandbox), and setup stays ok for the other targets', async () => {
  const m = await sandboxMachine();
  writeFileSync(join(m.work, 'no-sudo'), '');
  let r = await m.s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 0, r.err);
  let e = m.s.entry().setup;
  assert.equal(e.ok, true);
  assert.equal(e.error, null, 'not a setup failure');
  assert.deepEqual(e.failed, [{ what: 'bubblewrap socat', why: 'not installed, and there is no passwordless sudo to install them for Claude Code\'s sandbox', sandbox: true }]);
  assert.equal(e.sandbox.ok, false);
  assert.match(e.sandbox.why, /no passwordless sudo to install them/);
  assert.match(r.err, /workstation setup: bubblewrap socat: not installed, and there is no passwordless sudo/);

  // Installed, but the profile refused (as inside a container that can't load AppArmor policy): Ubuntu's, then the minimal one.
  rmSync(join(m.work, 'no-sudo'));
  writeFileSync(join(m.work, 'parser-refuses'), '');
  r = await m.s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 0, r.err);
  e = m.s.entry().setup;
  assert.equal(e.ok, true);
  assert.equal(e.error, null);
  assert.deepEqual(e.failed.map(f => [f.what, f.sandbox]), [["bwrap's AppArmor profile", true]]);
  assert.match(e.failed[0].why, /bwrap-userns-restrict: apparmor_parser refused it: apparmor_parser: Unable to replace "bwrap"\.  Permission denied; .*tools\/apparmor\/bwrap: apparmor_parser refused it/);
  assert.equal(e.sandbox.ok, false);
  assert.match(e.sandbox.why, /^bwrap could not make a sandbox: bwrap: setting up uid map: Permission denied \(bwrap's AppArmor profile: .*apparmor_parser refused it/);

  // With no passwordless sudo the profile can't be loaded either: said so.
  writeFileSync(join(m.work, 'no-sudo'), '');
  await m.s.cli('workstation:setup', 'p', ID);
  e = m.s.entry().setup;
  assert.equal(e.ok, true);
  assert.match(e.sandbox.why, /no passwordless sudo to load a profile allowing bwrap user namespaces/);

  // A real failure besides: setup fails as before, its error naming that alone.
  m.s.w.mark(ID, 'docker-broken');
  r = await m.s.result('workstation:setup', 'p', ID);
  assert.equal(r.code, 1);
  e = m.s.entry().setup;
  assert.equal(e.ok, false);
  assert.match(e.error, /^docker: /);
  assert.doesNotMatch(e.error, /AppArmor/);
});
