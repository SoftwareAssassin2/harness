#!/usr/bin/env node
// A sandbox's command server for the tests (ASS-535): the API of src/substrate/image/command-server (ASS-534's, with
// ASS-535's job stdin and long-polled output), served on 127.0.0.1:<port>, running each command on this machine with
// <root> standing in for the sandbox's / — HARNESS_VM_ROOT=<root> in its environment, as a workstation's folder
// stands in for a VM's root, so the harness's in-machine scripts and sandbox-exec.js's workdir find /repos and
// /mnt/ticket there — and the image's `sudo -u agent -H` dropped (the test runs as one user). fake-substrate.js's
// `kubectl-ate proxy actor <actor> <port>:80` runs it (the proxy and the server in one process), so ending the proxy
// ends the server, as a real sandbox stops answering once its proxy is gone.
//
//   node fake-command-server.js <port> <root>
//
// Every request is appended to <root>/../requests.log as "<METHOD> <path>". Under test/support/, which npm test's
// pattern leaves alone.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [port, root] = process.argv.slice(2);
mkdirSync(join(root, 'tmp'), { recursive: true });
const jobs = new Map();
let next = 0;

const strip = argv => (argv[0] === 'sudo' && argv[1] === '-u' && argv[3] === '-H' ? argv.slice(4) : argv);
const codeOf = (code, signal) => (code ?? (signal ? 128 + ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 }[signal] ?? 15) : -1));
const body = req => new Promise(resolve => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const json = (res, status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
const run = (req, stdin) => {
  const [file, ...args] = strip(req.command);
  return spawn(file, args, { cwd: req.cwd && req.cwd !== '/' ? join(root, req.cwd) : root, env: { ...process.env, ...req.envvars, HARNESS_VM_ROOT: root }, detached: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try { appendFileSync(join(root, '..', 'requests.log'), `${req.method} ${url.pathname}\n`); } catch { /* none */ }
  const m = url.pathname.match(/^\/jobs\/([^/]+)(\/output|\/stdin)?$/);
  if (req.method === 'GET' && url.pathname === '/healthz') { res.end('ok'); return; }
  if (req.method === 'POST' && (url.pathname === '/process' || url.pathname === '/jobs')) {
    const r = JSON.parse(await body(req));
    const child = run(r, url.pathname === '/jobs' && r.stdin);
    const job = { id: String(++next), command: r.command, running: true, exitCode: null, out: { stdout: [], stderr: [] }, child, waiters: new Set() };
    const wake = () => { for (const w of job.waiters) w(); job.waiters.clear(); };
    child.stdout.on('data', d => { job.out.stdout.push(d); wake(); });
    child.stderr.on('data', d => { job.out.stderr.push(d); wake(); });
    child.on('error', e => { job.error = e.message; });
    child.stdin?.on('error', () => {});
    child.on('close', (code, signal) => { job.running = false; job.exitCode = job.error ? 127 : codeOf(code, signal); wake(); });
    if (url.pathname === '/process') {
      await new Promise(r2 => child.on('close', r2));
      json(res, 200, { stdout: Buffer.concat(job.out.stdout).toString(), stderr: Buffer.concat(job.out.stderr).toString(), exitCode: job.exitCode, ...(job.error ? { error: job.error } : {}) });
      return;
    }
    jobs.set(job.id, job);
    json(res, 201, { id: job.id });
    return;
  }
  const job = m && jobs.get(m[1]);
  if (!job) { res.writeHead(404); res.end('no such job'); return; }
  if (req.method === 'GET' && !m[2]) { json(res, 200, { id: job.id, command: job.command, running: job.running, exitCode: job.exitCode }); return; }
  if (req.method === 'GET' && m[2] === '/output') {
    const stream = url.searchParams.get('stream') ?? 'stdout', offset = Number(url.searchParams.get('offset') ?? 0), wait = Number(url.searchParams.get('wait') ?? 0);
    const all = () => Buffer.concat(job.out[stream]);
    if (wait > 0 && job.running && all().length <= offset) await new Promise(r2 => { const t = setTimeout(r2, Math.min(wait, 60) * 1000); job.waiters.add(() => { clearTimeout(t); r2(); }); });
    const running = job.running, data = all().subarray(offset);
    res.writeHead(200, { 'x-next-offset': String(offset + data.length), 'x-running': String(running) });
    res.end(data);
    return;
  }
  if (req.method === 'POST' && m[2] === '/stdin') {
    const data = await body(req);
    if (!job.child.stdin) { res.writeHead(409); res.end('no stdin'); return; }
    if (data.length) job.child.stdin.write(data);
    if (url.searchParams.get('close') === '1') job.child.stdin.end();
    res.writeHead(204); res.end();
    return;
  }
  if (req.method === 'DELETE') { if (job.running) try { process.kill(-job.child.pid, 'SIGTERM'); } catch { /* gone */ } res.writeHead(202); res.end(); return; }
  res.writeHead(404); res.end();
}).listen(Number(port), '127.0.0.1');
process.on('SIGTERM', () => { for (const j of jobs.values()) if (j.running) try { process.kill(-j.child.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(0); });
