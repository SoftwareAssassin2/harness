// memory:up — each project's Hindsight on the Mac (ASS-62). Nothing real is
// installed or started: python3 is a fake on PATH whose `-m venv <dir>` makes
// a fake pip there, and that pip's `install hindsight-api==<v>` writes a fake
// hindsight-api — an HTTP server on its --port answering /health and the bank
// PUT, which records each start (its pid, HOME, Hindsight's LLM settings with
// the key's presence, never the key, and its arguments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { until } from '../support/until.js';
import { fixture } from './harness-fixture.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const KEY = 'sk-ant-test-not-a-real-key';

const FAKE_HINDSIGHT = `#!/usr/bin/env node
const fs = require('node:fs');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const e = process.env;
fs.appendFileSync(e.HINDSIGHT_STARTS, JSON.stringify({ pid: process.pid, home: e.HOME, provider: e.HINDSIGHT_API_LLM_PROVIDER ?? null, model: e.HINDSIGHT_API_LLM_MODEL ?? null, key: e.HINDSIGHT_API_LLM_API_KEY ? 'set' : null, args: process.argv.slice(2) }) + '\\n');
require('node:http').createServer((req, res) => { fs.appendFileSync(e.HINDSIGHT_STARTS + '.requests', req.method + ' ' + req.url + '\\n'); res.end('{}'); }).listen(Number(arg('--port')), arg('--host'));
`;

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A harness with project p, its project.json's hindsight `hindsight`; python3 the fake.
function setup(t, hindsight) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'memory-')));
  const bin = join(dir, 'bin');
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true }); mkdirSync(bin);
  writeFileSync(join(dir, 'fake-hindsight'), FAKE_HINDSIGHT);
  const write = (file, body) => { writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`); chmodSync(file, 0o755); };
  // python3 -c <check> (the version check) succeeds, unless FAKE_PYTHON_OLD; -m venv <dir> makes <dir>/bin/pip.
  write(join(bin, 'python3'), `echo "$*" >> '${dir}/python.log'
[[ "$1" == -c ]] && { [[ -z "\${FAKE_PYTHON_OLD:-}" ]]; exit; }
[[ "$1 $2" == "-m venv" ]] || exit 2
mkdir -p "$3/bin"
cat > "$3/bin/pip" <<'PIP'
#!/usr/bin/env bash
echo "$*" >> '${dir}/pip.log'
[[ -z "\${FAKE_PIP_FAIL:-}" ]] || { echo "pip: no matching distribution" >&2; exit 1; }
cp '${dir}/fake-hindsight' "$(dirname "$0")/hindsight-api"; chmod 755 "$(dirname "$0")/hindsight-api"
PIP
chmod 755 "$3/bin/pip"`);
  const project = json => writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', ...(json && { hindsight: json }) }, null, 4));
  project(hindsight);
  const starts = () => (existsSync(join(dir, 'starts.log')) ? readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  t.after(() => { for (const { pid } of starts()) try { process.kill(pid); } catch { /* gone */ } });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: join(dir, 'projects'), HINDSIGHT_DIR: join(dir, 'hindsight-install'), HINDSIGHT_STARTS: join(dir, 'starts.log'), HINDSIGHT_WAIT_SECONDS: '10' };
  return {
    dir, env, project, starts,
    data: join(dir, 'projects', 'p', 'hindsight'),
    up: (more = {}) => run(AGENT, ['memory:up', 'p'], { env: { ...env, ...more } }),
    log: name => (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), 'utf8').trim().split('\n') : []),
    requests: () => (existsSync(join(dir, 'starts.log.requests')) ? readFileSync(join(dir, 'starts.log.requests'), 'utf8').trim().split('\n') : []),
  };
}

test('memory:up installs the pinned hindsight-api once, starts the project\'s Hindsight on 127.0.0.1:<port> in its own session with its data in projects/<p>/hindsight, makes its bank; run again, it changes nothing', async t => {
  const port = await freePort();
  const s = setup(t, { port, 'llm-api-key': KEY });
  const first = JSON.parse((await s.up()).stdout);
  assert.deepEqual(first, {
    project: 'p', url: `http://127.0.0.1:${port}`, mcp: `http://127.0.0.1:${port}/mcp/p/`, 'vm-mcp': `http://host.lima.internal:${port}/mcp/p/`,
    provider: 'anthropic', model: 'claude-haiku-5-5', data: s.data, changed: true,
  });
  assert.deepEqual(s.log('python'), [s.log('python')[0], `-m venv ${join(s.dir, 'hindsight-install', 'hindsight-1.1.0')}`]);
  assert.deepEqual(s.log('pip'), ['install --quiet hindsight-api==1.1.0']);
  const [started] = s.starts();
  assert.deepEqual(started, { pid: started.pid, home: s.data, provider: 'anthropic', model: 'claude-haiku-5-5', key: 'set', args: ['--host', '127.0.0.1', '--port', String(port)] });
  assert.equal(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(started.pid)], { encoding: 'utf8' })), started.pid, 'its own session: killing control\'s process group leaves it running');
  assert.equal(statSync(s.data).mode & 0o777, 0o700);
  assert.ok(s.requests().includes('PUT /v1/default/banks/p'), s.requests().join('\n'));
  assert.ok(!readFileSync(join(s.data, 'config.sha256'), 'utf8').includes(KEY), 'the key is never written down');

  const second = JSON.parse((await s.up()).stdout);
  assert.equal(second.changed, false);
  assert.equal(s.log('pip').length, 1);
  assert.equal(s.starts().length, 1);

  // Stopped, it is started again.
  process.kill(started.pid);
  assert.ok(await until(() => !alive(started.pid)));
  assert.equal(JSON.parse((await s.up()).stdout).changed, true);
  assert.equal(s.starts().length, 2);
});

test('memory:up run several times at once for a project starts one Hindsight (ASS-179 AC2): one runs at a time, the rest find it answering', async t => {
  const port = await freePort();
  const s = setup(t, { port, 'llm-api-key': KEY });
  const ups = await Promise.all(Array.from({ length: 4 }, () => s.up()));
  assert.equal(s.starts().length, 1);
  assert.equal(s.log('pip').length, 1);
  assert.deepEqual(ups.map(u => JSON.parse(u.stdout).changed).toSorted(), [false, false, false, true]);
});

test('memory:up with no llm-api-key starts Hindsight with provider none — retain and recall work, no reflect — and says so; a key pasted in later restarts it on the anthropic provider', async t => {
  const port = await freePort();
  const s = setup(t, { port, 'llm-api-key': null });
  const { stdout, stderr } = await s.up();
  assert.equal(JSON.parse(stdout).provider, 'none');
  assert.equal(JSON.parse(stdout).model, null);
  assert.match(stderr, /memory:up: p has no llm-api-key in project\.json's hindsight; its Hindsight runs with provider none: retain stores plain chunks, recall works, reflect is unavailable/);
  assert.deepEqual(s.starts().map(x => [x.provider, x.model, x.key]), [['none', null, null]]);

  s.project({ port, 'llm-api-key': KEY });
  const after = JSON.parse((await s.up()).stdout);
  assert.deepEqual([after.provider, after.changed], ['anthropic', true]);
  assert.ok(await until(() => !alive(s.starts()[0].pid)), 'the one on provider none is stopped');
  assert.deepEqual(s.starts().slice(1).map(x => [x.provider, x.model, x.key]), [['anthropic', 'claude-haiku-5-5', 'set']]);
});

test('memory:up reads the LLM key from the keychain when hindsight names llm-api-key-keychain-service, so no key is written in project.json; a missing item fails clearly', async t => {
  const port = await freePort();
  const s = setup(t, { port, 'llm-api-key-keychain-service': 'Hindsight Key (Test)' });
  const securityLog = join(s.dir, 'security.log');
  writeFileSync(join(s.dir, 'bin', 'security'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${securityLog}'\n[[ "$*" == "find-generic-password -s Hindsight Key (Test) -w" ]] && { echo '${KEY}'; exit 0; }\nexit 44\n`);
  chmodSync(join(s.dir, 'bin', 'security'), 0o755);
  const up = JSON.parse((await s.up()).stdout);
  assert.deepEqual([up.provider, up.model], ['anthropic', 'claude-haiku-5-5']);
  assert.deepEqual(s.starts().map(x => [x.provider, x.key]), [['anthropic', 'set']]);
  assert.equal(readFileSync(securityLog, 'utf8'), 'find-generic-password -s Hindsight Key (Test) -w\n');

  s.project({ port, 'llm-api-key-keychain-service': 'Missing Item' });
  await assert.rejects(s.up(), err => /memory:up: p's hindsight keychain item 'Missing Item' can't be read/.test(err.stderr));
});

test('memory:up fails clearly: no hindsight in project.json, a bad project, a Python older than 3.11, a failed install (nothing left half-installed)', async t => {
  const s = setup(t, null);
  await assert.rejects(s.up(), e => /p has no hindsight in project\.json — add \{ "port": <n>, "llm-api-key": null \}/.test(e.stderr));
  await assert.rejects(run(AGENT, ['memory:up', '../p'], { env: s.env }), e => /invalid project/.test(e.stderr));
  await assert.rejects(run(AGENT, ['memory:up'], { env: s.env }), e => /usage/.test(e.stderr));
  s.project({ port: await freePort(), 'llm-api-key': null });
  await assert.rejects(s.up({ FAKE_PYTHON_OLD: '1' }), e => /Hindsight needs Python 3\.11 or newer/.test(e.stderr));
  await assert.rejects(s.up({ FAKE_PIP_FAIL: '1' }), e => /could not install hindsight-api 1\.1\.0/.test(e.stderr));
  assert.equal(existsSync(join(s.dir, 'hindsight-install', 'hindsight-1.1.0')), false);
  assert.deepEqual(s.starts(), []);
});

test('memory:up leaves be a Hindsight it did not start that answers on the port', async t => {
  const srv = createServer((req, res) => res.end('{}'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const s = setup(t, { port: srv.address().port, 'llm-api-key': null });
  await s.up();
  assert.equal(JSON.parse((await s.up()).stdout).changed, false);
  assert.deepEqual(s.starts(), []);
});

test('the shared test fixture never reaches the real Hindsight: its memory:up finds no install and no Python to make one', async () => {
  const f = fixture();
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), hindsight: { port: 1, 'llm-api-key': null } }));
  await assert.rejects(f.agent('memory:up', 'p'), e => /Hindsight needs Python 3\.11/.test(e.stderr));
});
