// ASS-535: sandbox-exec.js runs a command through a sandbox image's command server as if here — stdin streamed in,
// stdout and stderr out, the exit code its own (124 past --timeout, 128 + the signal, 127 not found, 255 unreachable),
// a TERM to it stopping the command. Against the real command server (src/substrate/image/command-server, ASS-534,
// with ASS-535's job stdin and long-polled output), built with Go when the Mac has it, else the test's fake one —
// both must answer the same.
//
// ASS-550: every wait is for an event (the server answering, output seen, the job registered, the process gone),
// never a fixed time; the ceilings left are hang guards (until/within's LOADED_MS, run.sh's 600 s per test), and the
// commands a broken stop would leave running sleep far longer (600 s) than any guard.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { until, within } from '../support/until.js';
import { main } from '../../src/substrate/sandbox-exec.js';

const EXEC = join(import.meta.dirname, '..', '..', 'src', 'substrate', 'sandbox-exec.js');
const SERVER = join(import.meta.dirname, '..', '..', 'src', 'substrate', 'image', 'command-server');
const FAKE = join(import.meta.dirname, '..', 'support', 'fake-command-server.js');
const servers = [], closers = [], jobPids = [], pidFiles = [];
// The servers, the proxies, and any job a failing test left running: its `sleep 600`, by the pid it recorded (a pid
// file's only while that pid still runs sleep 600, so a pid since reused is never touched).
after(() => {
  for (const s of servers) s.kill('SIGKILL');
  for (const c of closers) c();
  for (const p of jobPids) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  for (const f of pidFiles) {
    const pid = existsSync(f) && Number(readFileSync(f, 'utf8'));
    try { if (pid && execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'sleep 600') process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});
// sleeper() — a shell line that records its pid and becomes `sleep 600` (what a broken stop would leave running).
const sleeper = () => { const f = join(mkdtempSync(join(tmpdir(), 'sleeper-')), 'pid'); pidFiles.push(f); return `echo $$ > ${f}; exec sleep 600`; };

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const hasGo = (() => { try { execFileSync('go', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const healthy = port => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok, () => false);

// server(kind) — a command server (built from the image's source, or the fake) answering on a port of its own: its
// port. ASS-550: waited for until it answers (it used to be given 5 s, and on a loaded Mac the first command found
// nothing listening: 255), and started again on another port should the one picked have been taken meanwhile.
async function server(kind) {
  const dir = mkdtempSync(join(tmpdir(), 'cmdsrv-'));
  if (kind === 'go') execFileSync('go', ['build', '-o', join(dir, 'server'), '.'], { cwd: SERVER, stdio: 'ignore', env: { ...process.env, CGO_ENABLED: '0' } });
  for (;;) {
    const port = await freePort();
    const child = kind === 'go'
      ? spawn(join(dir, 'server'), [], { env: { ...process.env, PORT: String(port), JOBS_DIR: join(dir, 'jobs') }, stdio: 'ignore' })
      : spawn(process.execPath, [FAKE, String(port), join(dir, 'root')], { stdio: 'ignore' });
    servers.push(child);
    let up = false, gone = false;
    child.on('exit', () => { gone = true; });
    await until(() => gone || up || (healthy(port).then(ok => { up ||= ok; }), false));   // hang guard
    if (up && !gone) return port;
  }
}

// exec(port, args, stdin) — sandbox-exec.js run (as root: the test is one user), { code, signal, out, err }.
function exec(port, args, { stdin = '', signal, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [EXEC, '--port', String(port), '--root', '--workdir', '/', ...args], { env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code, sig) => resolve({ code, signal: sig, out, err }));
    if (typeof stdin === 'function') stdin(child); else child.stdin.end(stdin);
    if (signal) signal(child);
  });
}

// holding(backend) — a proxy before a command server that holds back its answer to POST /jobs (the job already
// started there) until release(): the window in which sandbox-exec.js has asked for its job and does not yet know
// its id. { port, posted (resolves to the job's id once the server has started it), release() }.
async function holding(backend) {
  let release, posted;
  const released = new Promise(r => { release = r; }), started = new Promise(r => { posted = r; });
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const r = await fetch(`http://127.0.0.1:${backend}${req.url}`, { method: req.method, body: body.length ? body : undefined }).catch(() => null);
    if (!r) { res.destroy(); return; }
    const answer = Buffer.from(await r.arrayBuffer());
    if (req.method === 'POST' && req.url === '/jobs') { posted(JSON.parse(answer).id); await released; }
    const headers = {};
    for (const h of ['content-type', 'x-next-offset', 'x-running']) if (r.headers.has(h)) headers[h] = r.headers.get(h);
    res.writeHead(r.status, headers);
    res.end(answer);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  closers.push(() => { srv.closeAllConnections(); srv.close(); });
  return { port: srv.address().port, posted: started, release };
}

const job = async (port, id) => (await fetch(`http://127.0.0.1:${port}/jobs/${id}`)).json();

for (const kind of ['go', 'fake']) {
  const skip = kind === 'go' && !hasGo && 'no Go on this machine';
  test(`AC1: a command run through the ${kind} command server: stdin in as it comes, output out, its exit code; timeouts, signals, a missing command and an unreachable server as a local process would say them`, { skip }, async () => {
    const port = await server(kind);
    let r = await exec(port, ['--', 'bash', '-c', 'cat; echo oops >&2; exit 3'], { stdin: 'hello\n' });
    assert.deepEqual([r.code, r.out, r.err], [3, 'hello\n', 'oops\n']);
    // stdin streamed: each line answered before the next is written (an agent's stream-json conversation).
    r = await exec(port, ['--', 'bash', '-c', 'while read l; do echo "got $l"; done'], { stdin: child => {
      let n = 0;
      child.stdout.on('data', () => { if (++n === 1) child.stdin.end('two\n'); });
      child.stdin.write('one\n');
    } });
    assert.deepEqual([r.code, r.out], [0, 'got one\ngot two\n']);
    // The 1-second limit is the behaviour under test; the command, unstopped, would run 600 s (run.sh's guard).
    r = await exec(port, ['--timeout', '1', '--', 'bash', '-c', sleeper()]);
    assert.equal(r.code, 124);
    r = await exec(port, ['--', 'bash', '-c', 'kill -TERM $$']);
    assert.equal(r.code, 143);
    r = await exec(port, ['--', 'no-such-command-anywhere']);
    assert.equal(r.code, 127);
    // ASS-549: the TERM once the command runs there (its first output), not after a fixed 500 ms.
    r = await exec(port, ['--', 'bash', '-c', `echo started; ${sleeper()}`], { signal: child => child.stdout.once('data', () => child.kill('SIGTERM')) });
    assert.deepEqual([r.code, r.out], [143, 'started\n'], 'a TERM to it stops the command there');
    // Unreachable: the 1-second reach is the behaviour under test (the default's 30 s would only slow the test).
    r = await exec(await freePort(), ['--', 'true'], { env: { HARNESS_SANDBOX_REACH_MS: '1000' } });
    assert.equal(r.code, 255);
    assert.match(r.err, /could not be reached/);
  });

  // ASS-550 AC1: the signal before the job has started — the server has started it, sandbox-exec.js does not yet know
  // its id. The job must still be stopped there (no process left), and the exit is the signal's, as a local process's.
  // In-process (main with its own signals), so the signal lands exactly in that window.
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    test(`ASS-550 AC1: a ${sig} while its job is being started (${kind} server) stops the job once its id is known: no job or process left in the sandbox, exit ${code}`, { skip }, async () => {
      const port = await server(kind), proxy = await holding(port), dir = mkdtempSync(join(tmpdir(), 'early-signal-'));
      const pidFile = join(dir, 'pid'), signals = new EventEmitter(), out = new PassThrough(), err = new PassThrough();
      let printed = '';
      err.on('data', d => { printed += d; });
      const ran = main(['--port', String(proxy.port), '--root', '--workdir', '/', '--', 'bash', '-c', `echo $$ > ${pidFile}; exec sleep 600`], { stdin: new PassThrough(), stdout: out, stderr: err, env: process.env, signals });
      const id = await within(proxy.posted);   // hang guard
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim());
      const pid = Number(readFileSync(pidFile, 'utf8'));
      jobPids.push(pid);
      assert.ok(alive(pid), 'the job runs in the sandbox');
      signals.emit(sig);   // before sandbox-exec.js has its job's id
      proxy.release();
      assert.equal(await within(ran), code, printed);
      await until(() => !alive(pid));
      jobPids.splice(jobPids.indexOf(pid), 1);   // gone: its pid is no longer ours to kill
      assert.equal((await job(port, id)).running, false, 'the sandbox has no job left running');
    });
  }
}

// ASS-550 AC1: the signal before the job was asked for at all (the server not reachable yet): no job is ever asked
// for, the retries end at once (not at the 10-minute reach), and the exit is the signal's. A real process and a real
// signal, sent once its first try has reached the port.
test(`ASS-550 AC1: a TERM or INT before its job is asked for (no server reachable yet) ends the retries: no job, exit 143 or 130`, async () => {
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    let tries = 0;
    const refuse = createServer(socket => { tries++; socket.destroy(); });
    await new Promise(r => refuse.listen(0, '127.0.0.1', r));
    const r = await within(exec(refuse.address().port, ['--', 'true'], { env: { HARNESS_SANDBOX_REACH_MS: '600000' }, signal: child => until(() => tries > 0).then(() => child.kill(sig)) }));
    refuse.close();
    assert.deepEqual([r.code, r.signal], [code, null], r.err);
  }
});
