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
// that file names a live process; it records the commit it runs
// (control-commit.js, ASS-393); it then removes every assignment — its
// project's only, for a project's control — with what its agent cost, so
// their steps are dispatched again, and ends any run of the removed ticket
// health check left with them (triggers.js endTicketHealthRuns, ASS-450). It exits when its stdin closes (the supervisor's pipe: a
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
//
// ASS-460, ASS-457, ASS-458 — what control survives, and how it exits when it
// cannot go on:
// - A tick that throws, or the restart checks around it, is logged under
//   "error" with its stack (one line, " | " between its frames), and the next
//   tick runs after the usual pause.
// - Its data failing to read (the drive dropping out, a file a merge is
//   rewriting) skips ticks (tick.js) — and holds the startup clean-up, which
//   removes nothing it could not read — until it reads; past harness.json's
//   data-unreadable-exit-seconds (300) it exits with DATA_EXIT_CODE (69).
// - An unhandled rejection is logged and control keeps running: a promise
//   nobody awaited failed, nothing was left half-done on the stack. An
//   uncaught exception is logged and control exits with CRASH_EXIT_CODE (70)
//   after the usual shut-down: it was thrown out of the middle of whatever
//   ran, so control's own state (the agents it tracks, a write half-made) can
//   no longer be trusted, and Node's own advice is not to carry on. The
//   dashboard starts a control that exits with anything but 0 or 75 again,
//   with backoff (src/tui/app.js controlExited).
// - On any exit its agents' and scripts' process groups are stopped (SIGTERM,
//   SIGKILL after 5 seconds: stop.js), and the pidfile removed when it names
//   this process; process 'exit' SIGKILLs what is still running, should an
//   exit come any other way. At start, a pidfile naming a dead process, or a
//   live one that is not a control (its pid reused), is removed and said so.
// - ASS-470: on any exit — the supervisor's stop (stdin's end, SIGTERM to its
//   group), a restart (75), SIGTERM, SIGINT, SIGHUP, an uncaught exception
//   (70), unreadable data (69) — the GCP workstation connections it owns are
//   closed: those its phase opened and those a command it ran opened
//   (workstations.js disconnectWorkstations; the live data's control-pid,
//   agent-cli/workstation.bash). The closing runs detached, so the
//   supervisor's SIGKILL cannot cut it short, and process 'exit' starts it for
//   any connection still owned, whatever the way out; a stop does not wait
//   past 8 seconds for a tick still running. Only a SIGKILL (or a lost Mac)
//   skips it: the next control closes, at its start, a connection whose owner
//   is no running control. One opened by hand, and one another running
//   control owns, are left alone.
//
// ASS-490: each tick is timed (performance.now, from the call to its return
// or throw; the sleep between ticks not counted) and its figures since start —
// overall, per tick.js phase and per call tick.js makes — kept by
// tick-stats.js, written to data/projects/<project>/tick-stats.json
// ($HARNESS_HOME/tick-stats.json without --project) at most every 30 seconds
// and on shutdown; a tick over 30 seconds logs a 'tick' line with its three
// slowest phases and sub-routines. harness:tick-stats prints them.
//
// For the tests only (ASS-425): with CONTROL_TEST_TICK_LINES=1 it also says
// "<ISO time> test tick ran" after each tick, so a test counts ticks in the
// same stream as the lines it checks, rather than timing them. ASS-460: with
// CONTROL_TEST_FAULT=tick its first two ticks throw; =uncaught an exception is
// thrown outside any tick after the first; =rejection a promise is rejected
// with nobody awaiting it after the first.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createContext, tick, startDrain, drained, waitForData, dataRecovered, restartRequestedBy } from './tick.js';
import { troubleOf } from './read.js';
import { stopStarted, killStarted } from './stop.js';
import { startForwarder } from './forwarder.js';
import { disconnectWorkstations, disconnectAtExit, closeLeftovers } from './workstations.js';
import { sessionSpend } from './finish.js';
import { endTicketHealthRuns } from './triggers.js';
import { recordControlCommit } from './control-commit.js';
import { tickStats, tickStatsFile, newTickTimes } from './tick-stats.js';

const ROOT = join(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const once = args.includes('--once');
const tickMs = Number(args[args.indexOf('--tick-ms') + 1]) || 2000;
const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;
if (project != null && !/^[A-Za-z0-9_-]+$/.test(project)) { console.error(`control: invalid project '${project}'`); process.exit(1); }
const home = process.env.HARNESS_HOME ?? join(homedir(), '.harness');
const pidfile = join(home, project ? `run-${project}.pid` : 'run.pid');
const say = (phase, text) => console.log(`${new Date().toISOString()} ${phase} ${text}`);
const tickLines = process.env.CONTROL_TEST_TICK_LINES === '1';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fault = process.env.CONTROL_TEST_FAULT ?? '';
// The exit codes the dashboard restarts on (with any other but 0 and 75): see above.
const DATA_EXIT_CODE = 69, CRASH_EXIT_CODE = 70;
// An error with its stack, on one line.
const withStack = error => String(error?.stack ?? error).split('\n').map(l => l.trim()).filter(Boolean).join(' | ');
// isControl(pid) — whether the live process `pid` runs src/control/main.js (by ps); when ps cannot say, taken as one.
const isControl = pid => {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.error ? true : ps.stdout.includes(join('control', 'main.js'));
};

mkdirSync(home, { recursive: true });
let stalePidfile = null;
if (existsSync(pidfile)) {
  const pid = Number(readFileSync(pidfile, 'utf8'));
  if (pid && pid !== process.pid && alive(pid) && isControl(pid)) {
    console.error(`control: already running as pid ${pid} (${pidfile})`);
    process.exit(1);
  }
  if (pid !== process.pid) stalePidfile = `${pidfile} named pid ${pid || '(none)'}, ${pid && alive(pid) ? 'a process that is not a control' : 'which is not running'}: removed`;
}
writeFileSync(pidfile, `${process.pid}\n`);

// ASS-470: every agent.sh control runs, and every command that runs in turn, carries its pid (HARNESS_CONTROL_PID), so a
// workstation connection one of them opens is recorded as this control's (workstation.bash says how).
const ctx = createContext({ root: ROOT, env: { ...process.env, HARNESS_CONTROL_PID: String(process.pid) }, log: say, project });
// The pidfile removed, when it still names this process; on 'exit', whatever the way out, with what still runs killed
// and the workstation connections it still owns closing (ASS-470: detached, they outlive it).
const removePidfile = () => { try { if (Number(readFileSync(pidfile, 'utf8')) === process.pid) rmSync(pidfile, { force: true }); } catch { /* gone */ } };
// ASS-490: the ticks' timings (tick-stats.js), written on shutdown too.
const timings = tickStats({ file: tickStatsFile({ paths: ctx.paths, home, project }), log: say, tickMs });
process.on('exit', () => { killStarted(ctx); try { disconnectAtExit(ctx); } catch { /* the last resort: nothing more to do */ } removePidfile(); });
say('startup', `control ${process.pid}, tick every ${tickMs}ms`);
if (stalePidfile) say('startup', stalePidfile);

// Stopping: stdin's end or a signal ends the wait between ticks and the loop.
// ASS-470: a tick still running STOP_GRACE_MS (8 seconds) later is not waited
// for: the shutdown starts then, so it ends inside the supervisor's 20 seconds
// (src/tui/shutdown.js), whose SIGKILL would skip it — and leave the
// workstation connections open.
const STOP_GRACE_MS = 8000;
let stopping = false, wake = () => {};
let restart = null, exitCode = null;
const stop = () => {
  if (!stopping) setTimeout(() => shutdown(exitCode ?? (restart ? 75 : 0)), STOP_GRACE_MS).unref();
  stopping = true;
  wake();
};
process.stdin.on('end', stop).on('error', stop).resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });

// Shutting down, once: every script step's command and every agent stopped,
// and the background checks (ASS-497: background-checks.js; a restart's drain
// ends here too) stopped and waited for, none writing after (stop.js), each workstation connection this control owns closed — opened by
// its phase or by a command it ran (ASS-433, ASS-470: a workstation it kept up
// can stop itself once idle; workstations.js disconnectWorkstations) — the
// forwarder closed, the pidfile removed; then exit with `code`.
let forwarder = null, retry = null, ending = null;
const shutdown = code => (ending ??= (async () => {
  await stopStarted(ctx, say);
  try { await disconnectWorkstations(ctx); } catch (error) { say('error', `shutdown workstations: ${error.message}`); }
  clearTimeout(retry);
  forwarder?.close();
  timings.flush();
  removePidfile();
  say('shutdown', 'control exiting');
  process.exit(code);
})());
// ASS-460: see above. A second uncaught exception while shutting down kills what runs at once ('exit').
process.on('unhandledRejection', error => say('error', `unhandled rejection, control keeps running: ${withStack(error)}`));
process.on('uncaughtException', error => {
  say('error', `uncaught exception: ${withStack(error)}`);
  if (ending) process.exit(CRASH_EXIT_CODE);
  say('shutdown', `control exits with code ${CRASH_EXIT_CODE} for the dashboard to start it again`);
  stopping = true;
  wake();
  shutdown(CRASH_EXIT_CODE);
});
// ASS-393: the commit this control runs, for ticket:fix-landed (control-commit.js).
const commit = recordControlCommit(ROOT, ctx.paths, project);
say('startup', commit ? `running commit ${commit}` : 'the commit this checkout runs could not be read; none recorded');

// A control that starts owns no agent, so every record is stale: one whose
// process is gone died with its control; one whose process is still alive is
// an earlier control's leftover, and its group gets SIGTERM (SIGKILL after 5
// seconds). Once the leftovers have ended, every record is removed, with what
// its agent cost (ASS-268: its session's usage.json — finish.js sessionSpend —
// exact where every turn ended, else estimated, with its billing) and its
// memory use, so the planner dispatches its step again.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let stale = 0;
// ASS-457: until the data reads, nothing is removed — an assignment it could not read is never taken as none — and control waits, as a tick does.
let records = null;
while (records == null) {
  try { records = ctx.load().assignments.filter(a => !project || a.project === project); } catch (error) {
    const trouble = troubleOf(ctx, error);
    if (!trouble) throw error;
    waitForData(ctx, trouble);
    if (ctx.dataExit || stopping) break;
    await sleep(tickMs);
  }
}
if (records == null) {
  if (ctx.dataExit) say('shutdown', `${ctx.dataExit}; control exits with code ${DATA_EXIT_CODE} for the dashboard to start it again`);
  await shutdown(ctx.dataExit ? DATA_EXIT_CODE : 0);
}
dataRecovered(ctx);
// ctx.attempt, but the data failing to read mid-way (which it throws on, for a tick to stop) logged too: the next control removes what is left.
const startupAttempt = (what, fn) => ctx.attempt('startup', what, fn).catch(error => say('error', `startup ${what}: ${error.message}`));
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
  await startupAttempt(name, async () => {
    await ctx.cli(['assignments:remove', name, ...sessionSpend(ctx, record)]);
    say('startup', leftovers.has(name) ? `stopped ${name} (pid ${pid}), left by an earlier control, and removed its assignment` : `removed the stale assignment of ${name} (pid ${pid ?? 'none'})`);
    stale++;
  });
}
say('startup', `${stale} stale assignment${stale === 1 ? '' : 's'} removed`);
// ASS-450: a ticket health check run an earlier harness left (removed: never dispatched again) ended, with the runs under it.
await startupAttempt('ticket health check runs', () => endTicketHealthRuns(ctx));
// ASS-470: a workstation connection a control no longer running owns (its crash's, its kill -9's) closed, before the
// first tick decides which workstations are needed (workstations.js closeLeftovers).
await startupAttempt('workstation connections', () => closeLeftovers(ctx, pid => alive(pid) && isControl(pid)));

let said = false;
let forwarderPort = null;
try { forwarderPort = ctx.load().harness['forwarder-port']; } catch (error) { say('forwarder', `harness.json could not be read (${error.message}): no forwarder from this control`); }
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

// restartRequested() — harness:request-restart named this control (see that
// command): it drains — dispatches nothing more, its steps still run, while
// every control's running agents end their turns, up to restart-drain-seconds
// (ASS-200, ASS-236, see tick.js) — and then
// exits with code 75 once the rest are stopped, for the dashboard to start it
// again on the new code.
const RESTART = join(home, 'restart-requested.json');
const restartRequested = () => { try { return JSON.parse(readFileSync(RESTART, 'utf8')); } catch { return null; } };
let faults = 0;
while (!stopping) {
  try {
    const request = restart ? null : restartRequested();
    if (request?.['control-pid'] === process.pid || request?.['control-pids']?.includes(process.pid)) {
      restart = request;
      say('shutdown', `a restart was requested (${restartRequestedBy(request)}); control exits with code 75 to be started again`);
      startDrain(ctx);
    }
    if (restart && drained(ctx)) break;
    // ASS-490: timed from the call to its return or throw (a throw counted too); CONTROL_TEST_FAULT's throw stands for the tick's.
    const began = performance.now();
    ctx.tickTimes = newTickTimes();
    try {
      if (fault === 'tick' && faults < 2) { faults++; throw new Error('test: the tick failed'); }
      await tick(ctx);
    } finally { timings.record(performance.now() - began, ctx.tickTimes); }
  } catch (error) {
    say('error', `the tick failed, control goes on: ${withStack(error)}`);
  }
  if (ctx.dataExit) {
    say('shutdown', `${ctx.dataExit}; control exits with code ${DATA_EXIT_CODE} for the dashboard to start it again`);
    exitCode = DATA_EXIT_CODE;
    break;
  }
  if (tickLines) say('test', 'tick ran');
  if (fault === 'uncaught' && !faults++) setImmediate(() => { throw new Error('test: thrown outside a tick'); });
  if (fault === 'rejection' && !faults++) Promise.reject(new Error('test: rejected with nobody awaiting'));
  if (once) break;
  await sleep(tickMs);
}

// Shutdown (see shutdown): 75 for a restart, else 0 — or why it could not go on.
await shutdown(exitCode ?? (restart ? 75 : 0));
