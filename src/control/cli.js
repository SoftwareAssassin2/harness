// How control changes anything: agent.sh at the repo root, run as a child
// (control never writes a JSON file itself), and how
// it runs a step's script. Every call is logged through the context's log.
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { machinePaths } from './machine.js';
import { troubleOf } from './read.js';
import { machineCommand } from './machine.js';

const MAX_OUTPUT = 16 * 1024 * 1024;   // a script's stdout and stderr kept, each, at most
const show = argv => argv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

// runCli(ctx, args, env) — runs `<ctx.root>/agent.sh <args>` with ctx.env (the
// agent-cli's path overrides, for tests) and `env` over it (a move's
// MOVE_CAUSE, moves.js), logging "agent.sh <args>" and any
// stderr under the phase "cli". Resolves to its stdout; rejects, the stderr
// in the message, when it exits with anything but 0 — its exit status the
// error's `code` (ASS-473: workstation:claim's 4, none free, and 5, an image
// missing on the workstation, told apart by workstation-steps.js; until then
// no `code` was ever set, so a 4 was taken for a failure).
export function runCli(ctx, args, env) {
  ctx.log('cli', `agent.sh ${show(args)}`);
  return new Promise((resolve, reject) => {
    execFile(join(ctx.root, 'agent.sh'), args, { env: env ? { ...ctx.env, ...env } : ctx.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stderr.trim()) ctx.log('cli', `stderr: ${stderr.trim().replace(/\n/g, ' | ')}`);
      if (!error) return resolve(stdout);
      const failure = new Error(`agent.sh ${show(args)}: ${stderr.trim() || error.message}`);
      if (typeof error.code === 'number') failure.code = error.code;
      // ASS-457 AC4: a write that failed for the data folder being gone stops the tick, as a failed read does (tick.js).
      const trouble = troubleOf(ctx, failure);
      if (trouble) ctx.trouble ??= trouble;
      reject(failure);
    });
  });
}

// where(ctx, argv, vm) — the argv and env a step's command runs with: as
// they are, in ctx.root; or, given the variation's VM (run-location: vm,
// ASS-74), in it, in /repos/, its ./agent.sh the VM's own agent.sh (on its
// PATH: the forwarder's client, which runs the command on the Mac for that
// ticket variation alone), through the machine layer (machine.js, ASS-432);
// `shown`, the command as run there, is what is logged.
function where(ctx, argv, vm) {
  if (!vm) return { argv, env: ctx.env, shown: argv };
  const shown = argv[0] === './agent.sh' ? ['agent.sh', ...argv.slice(1)] : argv;
  return { ...machineCommand(vm, shown, { cwd: machinePaths(vm).repos, env: ctx.env }), shown };   // /repos/, or a workstation folder's repos/ (ASS-435)
}

// runScript(ctx, argv, vm, extra) — runs a step's filled command (see placeholders.js)
// in ctx.root with ctx.env, or in the VM `vm` (where), logging it under
// "script"; `extra`, when given, over its env (ASS-365: steps.js scriptEnv's
// MERGES_AWAITED, for a command run on the host). Resolves to { exitCode, stdout }; never rejects: a command that
// cannot start has exit code 127, its error logged. It runs in its own
// process group (detached), kept in ctx.scripts while it runs, so control
// can stop it and everything it started on its way out (tick.js
// stopScripts, ASS-328: a script step runs in the background).
export function runScript(ctx, given, vm, extra) {
  const { argv, env: base, shown } = where(ctx, given, vm), env = extra ? { ...base, ...extra } : base;
  ctx.log('script', vm ? `${vm}: ${show(shown)}` : show(argv));
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd: ctx.root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { stdout: '', stderr: '' };
    for (const stream of ['stdout', 'stderr']) child[stream].setEncoding('utf8').on('data', text => { if (out[stream].length < MAX_OUTPUT) out[stream] += text; });
    if (child.pid != null) ctx.scripts?.add(child);
    let started = true;
    child.once('error', error => {   // it cannot start: no 'close' follows
      started = false;
      ctx.log('script', `cannot start: ${error.message}`);
      resolve({ exitCode: 127, stdout: '' });
    });
    child.once('close', code => {
      ctx.scripts?.delete(child);
      if (!started) return;
      if (out.stderr.trim()) ctx.log('script', `stderr: ${out.stderr.trim().replace(/\n/g, ' | ')}`);
      resolve({ exitCode: code ?? 127, stdout: out.stdout });
    });
  });
}

// scriptSucceeds(ctx, argv, vm, who) — whether the command exits 0: the yes
// or no a `script-succeeds` condition asks while the exits are evaluated; in
// the VM `vm` when given, as runScript — but a ./agent.sh command on the Mac
// (ASS-137): in the VM it would be forwarded back to this process's own
// forwarder, and the answer is the same. ASS-493: it runs in the background,
// never blocking control (spawnSync froze a project's whole control for the
// 114 s a ticket's test-listing check took): a promise of the answer, the
// exits evaluated from it once it has come (checks.js). It runs in its own
// process group, kept in ctx.scripts while it runs, so shutdown stops it
// (stopScripts); past SCRIPT_CHECK_TIMEOUT_MS (ctx.checkTimeoutMs, tests) its
// group is killed and it counts as not succeeded, an 'error' line naming the
// command and `who` (the ticket and variation); one that took over
// SLOW_CHECK_MS (ctx.slowCheckMs, tests) logs its duration as it exits. A command that cannot start is
// a no.
export const SCRIPT_CHECK_TIMEOUT_MS = 10 * 60_000;
export const SLOW_CHECK_MS = 30_000;
export function scriptSucceeds(ctx, given, vm, who) {
  const at = given[0] === './agent.sh' ? undefined : vm, { argv, env, shown } = where(ctx, given, at);
  const command = at ? `${at}: ${show(shown)}` : show(argv);
  ctx.log('script', command);
  return new Promise(resolve => {
    const started = Date.now(), limit = ctx.checkTimeoutMs ?? SCRIPT_CHECK_TIMEOUT_MS;
    const child = spawn(argv[0], argv.slice(1), { cwd: ctx.root, env, detached: true, stdio: 'ignore' });
    if (child.pid != null) ctx.scripts?.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      ctx.log('error', `script-succeeds check ${command}${who ? ` (${who})` : ''} still running after ${limit / 1000}s: killed, counted as not succeeded`);
    }, limit);
    child.once('error', error => {   // it cannot start: no 'close' follows
      clearTimeout(timer);
      ctx.log('script', `cannot start: ${error.message}`);
      resolve(false);
    });
    child.once('close', code => {
      clearTimeout(timer);
      ctx.scripts?.delete(child);
      const took = Date.now() - started;
      if (took > (ctx.slowCheckMs ?? SLOW_CHECK_MS)) ctx.log('script', `${command}${who ? ` (${who})` : ''}: ${timedOut ? 'killed' : `exited ${code ?? 'by a signal'}`} after ${(took / 1000).toFixed(1)}s`);
      resolve(!timedOut && code === 0);
    });
  });
}
