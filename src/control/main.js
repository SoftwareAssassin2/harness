#!/usr/bin/env node
// Control: the long-lived process that moves work through the state engines.
// Every tick (tick.js) it finishes the
// agents whose turns ended, runs the steps no agent works, starts the runs
// its triggers call for, tends the agents, and dispatches the next. It reads
// the JSON files directly and writes nothing itself: every change is an
// agent.sh call (cli.js). One line per action on stdout, "<ISO time> <phase>
// <detail>", which the dashboard's control screen shows.
//
//   node src/control/main.js [--once] [--tick-ms N] [--project <id>]
//   --once          one tick, then exit
//   --tick-ms N     the pause between ticks (default 2000)
//   --project <id>  this project's control alone (ASS-9; the dashboard runs one per project)
//
// On start it writes its pid to $HARNESS_HOME/run.pid (~/.harness by
// default; run-<id>.pid for a project's control) and refuses to start while
// that file names a live process; it then removes every assignment — its
// project's only, for a project's control — with what its agent cost, so
// their steps are dispatched again. It exits when its stdin closes (the supervisor's pipe: a
// supervisor that died cannot leave it running) or on SIGTERM: every agent's
// process group is signalled, given 5 seconds, then killed; the pidfile is
// removed. Each project's zot, which the ticks keep running (registry.js), is
// left running: it is in its own session, and harmless. The agent-cli's path overrides (ASSIGNMENTS_FILE, PROJECTS_DIR, …)
// point it at other data, used by tests.
//
// With harness.json's forwarder-port it serves the forwarder (forwarder.js,
// ASS-74) on 127.0.0.1:<port> while it runs, for the agents in VMs; one
// control holds it for every VM, so a control that finds the port held says
// so once and tries again every 10 seconds, taking it over should the other
// end.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createContext, tick, startDrain, drained } from './tick.js';
import { startForwarder } from './forwarder.js';
import { sessionSpend } from './finish.js';

const ROOT = join(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const once = args.includes('--once');
const tickMs = Number(args[args.indexOf('--tick-ms') + 1]) || 2000;
const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;
if (project != null && !/^[A-Za-z0-9_-]+$/.test(project)) { console.error(`control: invalid project '${project}'`); process.exit(1); }
const home = process.env.HARNESS_HOME ?? join(homedir(), '.harness');
const pidfile = join(home, project ? `run-${project}.pid` : 'run.pid');
const say = (phase, text) => console.log(`${new Date().toISOString()} ${phase} ${text}`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

mkdirSync(home, { recursive: true });
if (existsSync(pidfile)) {
  const pid = Number(readFileSync(pidfile, 'utf8'));
  if (pid && pid !== process.pid && alive(pid)) {
    console.error(`control: already running as pid ${pid} (${pidfile})`);
    process.exit(1);
  }
}
writeFileSync(pidfile, `${process.pid}\n`);

const ctx = createContext({ root: ROOT, env: process.env, log: say, project });
say('startup', `control ${process.pid}, tick every ${tickMs}ms`);

// A control that starts owns no agent, so every record is stale: one whose
// process is gone died with its control; one whose process is still alive is
// an earlier control's leftover, and its group gets SIGTERM (SIGKILL after 5
// seconds). Once the leftovers have ended, every record is removed, with what
// its agent cost (ASS-268: its session's usage.json — finish.js sessionSpend —
// exact where every turn ended, else estimated, with its billing) and its
// memory use, so the planner dispatches its step again.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let stale = 0;
const records = ctx.load().assignments.filter(a => !project || a.project === project);
const leftovers = new Set();
for (const record of records) {
  const pid = record['process-id'];
  if (pid == null || !alive(pid)) continue;
  leftovers.add(record['agent-name']);
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}
const pids = records.filter(r => leftovers.has(r['agent-name'])).map(r => r['process-id']);
for (const end = Date.now() + 5000; Date.now() < end && pids.some(alive);) await pause(100);
for (const pid of pids.filter(alive)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
for (const record of records) {
  const pid = record['process-id'], name = record['agent-name'];
  await ctx.attempt('startup', name, async () => {
    await ctx.cli(['assignments:remove', name, ...sessionSpend(ctx, record)]);
    say('startup', leftovers.has(name) ? `stopped ${name} (pid ${pid}), left by an earlier control, and removed its assignment` : `removed the stale assignment of ${name} (pid ${pid ?? 'none'})`);
    stale++;
  });
}
say('startup', `${stale} stale assignment${stale === 1 ? '' : 's'} removed`);

let forwarder = null, retry = null, said = false;
const forwarderPort = JSON.parse(readFileSync(ctx.paths.harness, 'utf8'))['forwarder-port'];
const serve = () => startForwarder({ root: ROOT, env: process.env, port: forwarderPort, log: say }).then(server => {
  forwarder = server;
  say('forwarder', `listening on 127.0.0.1:${forwarderPort}`);
}, error => {
  if (!said) say('forwarder', error.code === 'EADDRINUSE' ? `127.0.0.1:${forwarderPort} is held, by another control: it serves every VM` : `cannot listen on 127.0.0.1:${forwarderPort}: ${error.message}`);
  said = true;
  retry = setTimeout(serve, 10_000);
  retry.unref();
});
if (forwarderPort != null) await serve();

// Stopping: stdin's end or a signal ends the wait between ticks and the loop.
let stopping = false, wake = () => {};
const stop = () => { stopping = true; wake(); };
process.stdin.on('end', stop).on('error', stop).resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });

// restartRequested() — harness:request-restart named this control (see that
// command): it drains — dispatches nothing more, its steps still run, while
// every control's running agents end their turns, up to restart-drain-seconds
// (ASS-200, ASS-236, see tick.js) — and then
// exits with code 75 once the rest are stopped, for the dashboard to start it
// again on the new code.
const RESTART = join(home, 'restart-requested.json');
const restartRequested = () => { try { return JSON.parse(readFileSync(RESTART, 'utf8')); } catch { return null; } };
let restart = null;
while (!stopping) {
  const request = restart ? null : restartRequested();
  if (request?.['control-pid'] === process.pid || request?.['control-pids']?.includes(process.pid)) {
    restart = request;
    say('shutdown', `a restart was requested (self-healing, ${(request.tickets ?? [request.ticket]).join(', ')}); control exits with code 75 to be started again`);
    startDrain(ctx);
  }
  if (restart && drained(ctx)) break;
  await tick(ctx);
  if (once) break;
  await sleep(tickMs);
}

// Shutdown: SIGTERM every agent's group, wait up to 5
// seconds for them to end, SIGKILL the rest.
if (ctx.agents.size) {
  say('shutdown', `stopping ${ctx.agents.size} agent${ctx.agents.size === 1 ? '' : 's'}`);
  ctx.stopAgents();
  for (const end = Date.now() + 5000; Date.now() < end && [...ctx.agents.values()].some(l => !l.exited);) await sleep(100);
  for (const live of ctx.agents.values()) {
    if (live.exited) continue;
    try { process.kill(-live.agent.pid, 'SIGKILL'); } catch { /* gone */ }
    say('shutdown', `${live.name} killed`);
  }
}
clearTimeout(retry);
forwarder?.close();
rmSync(pidfile, { force: true });
say('shutdown', 'control exiting');
process.exit(restart ? 75 : 0);
