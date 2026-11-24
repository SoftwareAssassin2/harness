#!/usr/bin/env node
// Run a command in a ticket variation's Substrate sandbox (ASS-535), as if it ran here: its stdin streamed in, its
// stdout and stderr streamed out, its exit code ours. Substrate has no exec API (ASS-532 spike, section 1): the only
// way in is the sandbox image's command server (src/substrate/image/command-server, ASS-534), reached on a port of
// the Mac's loopback — `kubectl ate proxy actor` there for a sandbox on the Mac's cluster, or the same on a
// workstation or cloud VM forwarded over its one SSH connection (src/agent-cli/substrate/sandbox.bash
// sandbox_endpoint). This is the process the machine layer spawns for a sandbox (machine-substrate.js command,
// machine-substrate.bash substrate_run), as it spawns `limactl shell` for a VM:
//
//   node sandbox-exec.js (--sandbox <project>:<machine>:<actor> | --port <port>) [--workdir <dir>] [--marker <m>]
//                        [--timeout <seconds>] [--root] [--env NAME=value]… -- <argv…>
//
// - The command is a job (POST /jobs, stdin: true): it outlives any one request, so the atenet router's 5-minute
//   response limit never cuts a long step. Our stdin is written to its stdin as it comes (POST /jobs/{id}/stdin, in
//   order; closed at our stdin's end), its output polled with wait (GET /jobs/{id}/output?wait=…: an answer as soon
//   as there are bytes), so an agent's stream-json goes both ways as through `limactl shell`.
// - It runs as the sandbox's user `agent` (the image's, with passwordless sudo, as in a VM), in a login shell (the
//   image's profile), in <dir> (its home without one); --root runs it as root, the command server's own user.
//   <dir> is a sandbox path (/repos/<repo>, /mnt/ticket…); HARNESS_VM_ROOT, when the sandbox has one (the tests'
//   fake), is put before it, as a workstation's folder stands in for a VM's root.
// - --marker runs it under a bash whose command line carries the marker, which passes a TERM on (machine-lima.js's
//   wrapper): stopMarked's pkill of the marker in the sandbox ends it, as in a VM.
// - A TERM, INT or HUP to us stops the job (DELETE /jobs/{id}: SIGTERM to its process group) and waits for its end;
//   --timeout <seconds> stops it so and exits 124, as timeout(1) does. ASS-550: the handlers are set before the job
//   is asked for, so a signal at any moment ends the job there too: before the POST, no job is asked for (the retries
//   of an unreachable server end at once); while it is under way, the job it starts is stopped as soon as its id is
//   known. Either way we exit as a local process the signal ended would: 128 + its number (143 for TERM, 130 for INT)
//   — also when the job ends of the TERM we passed on (its 143), whichever signal we got. (Set before, they came only
//   once the job had started: a TERM in between killed us outright and left the job running in the sandbox.)
// - Exit code: the job's (128 + the signal for one a signal ended, as the command server says it); 127 when it could
//   not start; 255 when the sandbox could not be reached (as ssh says a lost connection), after retrying for
//   REACH_MS — a proxy that died is started again once (--sandbox: substrate:sandbox-endpoint).
//
// --sandbox reads the port from the Mac's record of the sandbox's endpoint, <HARNESS_SUBSTRATE_DIR, else
// ~/.harness/substrate>/sandboxes/<project>/<actor>.json ({ port, … }: sandbox.bash writes it), and asks
// agent.sh substrate:sandbox-endpoint for it again when it does not answer.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const REACH_MS = 30_000;
const WAIT_S = 25;
// The signals we pass on to the job as its stop, and their numbers (for our exit code, 128 + it).
const SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 };
// The marker's wrapper, machine-lima.js's: a TERM passed on, stdin passed on, the exit code the process's own.
export const WRAP = 'trap \'kill -TERM "$c" 2>/dev/null\' TERM; "$@" <&0 & c=$!; while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || exit "$s"; done';
// What every command runs first: into its workdir (HARNESS_VM_ROOT before a sandbox path, when set), then argv.
export const ENTER = 'd="$1"; shift; case "$d" in "") d="$HOME" ;; /*) d="${HARNESS_VM_ROOT-}$d" ;; esac; cd "$d" || exit 1; exec "$@"';

// sandboxArgv({ argv, workdir, marker, root }) — the argv the command server runs for a command (see above).
export function sandboxArgv({ argv, workdir, marker, root = false }) {
  const inner = ['bash', '-lc', ENTER, 'harness-sandbox', workdir || '', ...(marker ? ['bash', '-c', WRAP, marker] : []), ...argv];
  return root ? inner : ['sudo', '-u', 'agent', '-H', ...inner];
}

export const substrateDir = env => env.HARNESS_SUBSTRATE_DIR || join(env.HOME || homedir(), '.harness', 'substrate');
// endpointFile(env, project, actor) — the Mac's record of a sandbox's endpoint.
export const endpointFile = (env, project, actor) => join(substrateDir(env), 'sandboxes', project, `${actor}.json`);

function parse(args) {
  const o = { env: {} };
  while (args.length) {
    const a = args.shift();
    if (a === '--') break;
    if (a === '--root') { o.root = true; continue; }
    const v = args.shift();
    if (a === '--sandbox') o.sandbox = v;
    else if (a === '--port') o.port = Number(v);
    else if (a === '--workdir') o.workdir = v;
    else if (a === '--marker') o.marker = v;
    else if (a === '--timeout') o.timeout = Number(v);
    else if (a === '--env') { const i = v.indexOf('='); o.env[v.slice(0, i)] = v.slice(i + 1); }
    else throw new Error(`sandbox-exec: unknown option ${a}`);
  }
  o.argv = args;
  if (!o.argv.length) throw new Error('sandbox-exec: no command given');
  if (!o.sandbox && !o.port) throw new Error('sandbox-exec: --sandbox or --port is required');
  return o;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

// request(port, method, path, body) — { status, headers, body (a Buffer) }; rejects on a connection error.
export function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent, headers: body == null ? {} : { 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// main(args, { stdin, stdout, stderr, env }) — the command run (see the module comment); resolves to its exit code.
export async function main(args, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, signals = process } = {}) {
  let o;
  try { o = parse([...args]); } catch (error) { stderr.write(`${error.message}\n`); return 2; }
  const [project, machine, actor] = o.sandbox ? o.sandbox.split(':') : [];
  let port = o.port, refreshed = false;
  const readPort = () => { try { return Number(JSON.parse(readFileSync(endpointFile(env, project, actor), 'utf8')).port) || null; } catch { return null; } };
  // A signal to us (ASS-550: set first, before the job is asked for; see the module comment).
  let signalled = null, wake;
  const woken = new Promise(r => { wake = r; });
  let stop = () => {};
  const onSignal = s => { signalled ??= s; wake(); stop(); };
  const handlers = Object.keys(SIGNALS).map(s => [s, () => onSignal(s)]);
  for (const [s, h] of handlers) signals.on?.(s, h);
  const unhook = () => { for (const [s, h] of handlers) signals.off?.(s, h); };
  const CANCELLED = new Error('signalled');
  // reach(fn, cancellable) — fn(port) retried while the sandbox cannot be reached, up to REACH_MS; with --sandbox, its
  // endpoint read again, and set up again once (substrate:sandbox-endpoint), when it does not answer. cancellable (the
  // job's start): a signal ends the retries, throwing CANCELLED — an attempt under way is let finish first, as the
  // job it may start must be known to be stopped.
  const reach = async (fn, cancellable = false) => {
    const until = Date.now() + Number(env.HARNESS_SANDBOX_REACH_MS ?? REACH_MS);
    for (let delay = 100; ; delay = Math.min(delay * 2, 2000)) {
      if (cancellable && signalled) throw CANCELLED;
      if (o.sandbox) port = readPort() ?? port;
      if (port) { try { return await fn(port); } catch (error) { if (Date.now() > until) throw error; } }
      else if (Date.now() > until) throw new Error(`no endpoint recorded for the sandbox ${actor} (${endpointFile(env, project, actor)})`);
      if (o.sandbox && !refreshed) {
        refreshed = true;
        try {
          const out = execFileSync(join(import.meta.dirname, '..', '..', 'agent.sh'), ['substrate:sandbox-endpoint', project, machine, actor], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
          port = Number(JSON.parse(out.trim().split('\n').pop()).port) || port;
          continue;
        } catch { /* tried again below */ }
      }
      await (cancellable ? Promise.race([sleep(delay), woken]) : sleep(delay));
    }
  };
  const fail = (code, message) => { stderr.write(`sandbox-exec${actor ? ` ${actor}` : ''}: ${message}\n`); return code; };

  const byOurSignal = () => 128 + SIGNALS[signalled];
  let started;
  try {
    started = await reach(p => request(p, 'POST', '/jobs', JSON.stringify({ command: sandboxArgv(o), envvars: o.env, cwd: '/', stdin: true })), true);
  } catch (error) {
    unhook();
    if (error === CANCELLED) return byOurSignal();   // no job was asked for
    return signalled ? byOurSignal() : fail(255, `the sandbox's command server could not be reached: ${error.message}`);
  }
  if (started.status !== 201) unhook();
  if (started.status === 422) { let e; try { e = JSON.parse(started.body).error; } catch { e = started.body.toString(); } return fail(127, `could not start ${o.argv[0]}: ${e}`); }
  if (started.status !== 201) return fail(255, `the command server answered ${started.status}: ${started.body.toString().trim()}`);
  const { id } = JSON.parse(started.body);

  // stop() — the job stopped (its process group TERMed), once; at once if a signal came while it was being started.
  let stopping = false, timedOut = false;
  stop = () => { if (stopping) return; stopping = true; reach(p => request(p, 'DELETE', `/jobs/${id}`)).catch(() => {}); };
  if (signalled) stop();
  const timer = o.timeout > 0 ? setTimeout(() => { timedOut = true; stop(); }, o.timeout * 1000) : null;

  // stdin, written in order; closed at its end.
  let feeding = Promise.resolve(), ended = false;
  const feed = (chunk, close) => { feeding = feeding.then(() => (ended ? null : reach(p => request(p, 'POST', `/jobs/${id}/stdin${close ? '?close=1' : ''}`, chunk ?? '')))).then(r => { if (r && r.status >= 400) ended = true; }, () => { ended = true; }); };
  stdin.on('data', chunk => feed(chunk, false));
  stdin.on('end', () => feed(null, true));
  stdin.on('error', () => feed(null, true));
  stdin.resume?.();

  // pump(stream, out) — the job's stream written to `out` as it comes, until the job has ended and nothing is left.
  const pump = async (stream, out) => {
    let offset = 0;
    for (;;) {
      const r = await reach(p => request(p, 'GET', `/jobs/${id}/output?stream=${stream}&offset=${offset}&wait=${WAIT_S}`));
      if (r.status !== 200) throw new Error(`its ${stream} answered ${r.status}`);
      if (r.body.length) await new Promise(res => (out.write(r.body) ? res() : out.once('drain', res)));
      offset = Number(r.headers['x-next-offset'] ?? offset + r.body.length);
      if (r.headers['x-running'] === 'false' && !r.body.length) return;
    }
  };
  let code;
  try {
    await Promise.all([pump('stdout', stdout), pump('stderr', stderr)]);
    const r = await reach(p => request(p, 'GET', `/jobs/${id}`));
    code = JSON.parse(r.body).exitCode;
  } catch (error) { code = fail(255, `lost the sandbox's command server: ${error.message}`); }
  if (timer) clearTimeout(timer);
  unhook();
  stdin.pause?.();
  stdin.destroy?.();
  if (timedOut) return 124;
  if (signalled && code === 128 + SIGNALS.SIGTERM) return byOurSignal();   // ended by the TERM we passed on
  return typeof code === 'number' ? (code < 0 ? 255 : code) : 255;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => { agent.destroy(); process.exitCode = code; }, error => { process.stderr.write(`sandbox-exec: ${error.message}\n`); process.exitCode = 255; });
}
