// ASS-497: control's periodic checks that call out — detectReverts
// (reverts.js), the gcloud and glab login checks (triggers.js loginCheck),
// checkUsage (usage.js), checkApiCost (api-cost.js) and checkPushAccount
// (push-account.js) — run their slow part as a background job the tick does
// not await, as vm-lifecycle.js runs its VM jobs. Each check decides in the
// tick whether it is due (its clock set then, as before), and starts its job
// with backgroundCheck under a key — '<check>/<project>' (or '<check>/harness'
// for the harness org's API cost) — that has at most one job in flight: a
// check whose last job still runs is not started again. What the tick reads
// from a check (its data files, through loadState, and control's memory) is
// what the last finished job recorded, as between checks before.
//
// A job works on its own view of the context (jobContext): its attempt logs
// whatever is thrown, the data failing to read too, rather than stop the tick
// that happens to be running (ctx.trouble is the tick's alone); its timed runs
// the call untimed (tick-stats.js timeCall's depth counting assumes calls
// awaited in turn, so background work is never timed into a tick); its cli
// refuses to run once the checks are stopping; `checkSignal` aborts with them
// (reverts.js passes it to its forge calls). A job over SLOW_CHECK_MS (10 s;
// ctx.slowCheckMs in tests) logs a 'timers' line with how long it took.
//
// stopChecks — shutdown and the end of a restart drain (main.js shutdown,
// stop.js stopStarted): no check starts any more, the in-flight forge calls
// are aborted, no check writes through cli after, and the jobs are waited for
// (up to STOP_CHECKS_MS), so none is left writing a data file once control exits.
import { untimed } from './tick-stats.js';

export const SLOW_CHECK_MS = 10_000;
export const STOP_CHECKS_MS = 5_000;

// ASS-497: its jobs kept apart from ASS-493's script-check answers (checks.js, ctx.memory.checks).
const checks = ctx => (ctx.memory.backgroundChecks ??= new Map());
const control = ctx => (ctx.memory.checksStop ??= new AbortController());
class Stopped extends Error {}

// jobContext(ctx) — the context a background job works with (see above).
function jobContext(ctx) {
  const { signal } = control(ctx);
  const job = Object.create(ctx);
  job.checkSignal = signal;
  job.timed = (phase, name, fn) => fn();
  job.cli = (...args) => (signal.aborted ? Promise.reject(new Stopped('stopped with control')) : ctx.cli(...args));
  job.attempt = async (phase, what, fn) => {
    try { await fn(); } catch (error) {
      if (!signal.aborted) ctx.log('error', `${phase} ${what}: ${error.message}`);
    }
  };
  return job;
}

// backgroundCheck(ctx, key, fn) — fn(job), job the job's context, started as
// the background job `key` and not awaited; null, nothing started, while
// `key`'s last job still runs or once the checks are stopping. Returns the
// job's promise, which never rejects: what it throws is logged under "error"
// as "<key>: <message>" (not once stopping: a check stopped with control is
// not an error).
export function backgroundCheck(ctx, key, fn) {
  const jobs = checks(ctx), { signal } = control(ctx);
  if (jobs.has(key) || signal.aborted) return null;
  const began = performance.now();
  // Started outside any timed call (tick-stats.js untimed, ASS-494): a background job is never timed, nor what it calls.
  const job = untimed(() => Promise.resolve().then(() => fn(jobContext(ctx))))
    .catch(error => { if (!signal.aborted) ctx.log('error', `${key}: ${error.message}`); })
    .finally(() => {
      jobs.delete(key);
      const ms = performance.now() - began;
      if (ms > (ctx.slowCheckMs ?? SLOW_CHECK_MS)) ctx.log('timers', `${key} took ${(ms / 1000).toFixed(1)}s in the background`);
    });
  jobs.set(key, job);
  return job;
}

// settled(jobs) — the started jobs (nulls skipped) as one promise, for a check's caller to await (tests) or leave (the tick).
export const settled = jobs => Promise.all(jobs.filter(Boolean)).then(() => {});

// checksRunning(ctx) — the keys of the background checks in flight.
export const checksRunning = ctx => [...checks(ctx).keys()];

// settleChecks(ctx) — waits until no background check is in flight (those a finishing one starts too).
export async function settleChecks(ctx) {
  while (checks(ctx).size) await Promise.all(checks(ctx).values());
}

// stopChecks(ctx, say, waitMs) — see the module comment; what still runs after `waitMs` is logged and left.
export async function stopChecks(ctx, say = ctx.log, waitMs = STOP_CHECKS_MS) {
  if (!ctx.memory) return;   // a context that never ran a check (tests' bare ones)
  control(ctx).abort();
  const jobs = checks(ctx);
  if (!jobs.size) return;
  say('shutdown', `stopping ${jobs.size} background check${jobs.size === 1 ? '' : 's'} (${[...jobs.keys()].join(', ')})`);
  let timer;
  const out = new Promise(resolve => { timer = setTimeout(resolve, waitMs); timer.unref?.(); });
  await Promise.race([Promise.all(jobs.values()), out]);
  clearTimeout(timer);
  if (jobs.size) say('shutdown', `${[...jobs.keys()].join(', ')} still running after ${waitMs / 1000}s: left, starting no write from now`);
}
