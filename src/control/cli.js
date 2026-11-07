// How control changes anything: agent.sh at the repo root, run as a child
// (control never writes a JSON file itself), and how
// it runs a step's script. Every call is logged through the context's log.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { inVm, limaEnv } from './vm.js';

const show = argv => argv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

// runCli(ctx, args, env) — runs `<ctx.root>/agent.sh <args>` with ctx.env (the
// agent-cli's path overrides, for tests) and `env` over it (a move's
// MOVE_CAUSE, moves.js), logging "agent.sh <args>" and any
// stderr under the phase "cli". Resolves to its stdout; rejects, the stderr
// in the message, when it exits with anything but 0.
export function runCli(ctx, args, env) {
  ctx.log('cli', `agent.sh ${show(args)}`);
  return new Promise((resolve, reject) => {
    execFile(join(ctx.root, 'agent.sh'), args, { env: env ? { ...ctx.env, ...env } : ctx.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stderr.trim()) ctx.log('cli', `stderr: ${stderr.trim().replace(/\n/g, ' | ')}`);
      if (error) reject(new Error(`agent.sh ${show(args)}: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

// where(ctx, argv, vm) — the argv and env a step's command runs with: as
// they are, in ctx.root; or, given the variation's VM (run-location: vm,
// ASS-74), in it, in /repos/, its ./agent.sh the VM's own agent.sh (on its
// PATH: the forwarder's client, which runs the command on the Mac for that
// ticket variation alone).
function where(ctx, argv, vm) {
  if (!vm) return { argv, env: ctx.env };
  return { argv: inVm(vm, argv[0] === './agent.sh' ? ['agent.sh', ...argv.slice(1)] : argv), env: limaEnv(ctx.env) };
}

// runScript(ctx, argv, vm) — runs a step's filled command (see placeholders.js)
// in ctx.root with ctx.env, or in the VM `vm` (where), logging it under
// "script". Resolves to { exitCode, stdout }; never rejects: a command that
// cannot start has exit code 127, its error logged.
export function runScript(ctx, given, vm) {
  const { argv, env } = where(ctx, given, vm);
  ctx.log('script', vm ? `${vm}: ${show(argv.slice(6))}` : show(argv));
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { cwd: ctx.root, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stderr.trim()) ctx.log('script', `stderr: ${stderr.trim().replace(/\n/g, ' | ')}`);
      if (error && error.code === 'ENOENT') ctx.log('script', `cannot start: ${error.message}`);
      resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stdout });
    });
  });
}

// scriptSucceeds(ctx, argv, vm) — whether the command exits 0, waited for: the
// yes or no a `script-succeeds` condition asks while the exits are evaluated;
// in the VM `vm` when given, as runScript — but a ./agent.sh command on the
// Mac (ASS-137): in the VM it would be forwarded back to this process's own
// forwarder, which cannot answer while this waits, and the answer is the same.
export function scriptSucceeds(ctx, given, vm) {
  const at = given[0] === './agent.sh' ? undefined : vm, { argv, env } = where(ctx, given, at);
  ctx.log('script', at ? `${at}: ${show(argv.slice(6))}` : show(argv));
  return spawnSync(argv[0], argv.slice(1), { cwd: ctx.root, env, stdio: 'ignore' }).status === 0;
}
