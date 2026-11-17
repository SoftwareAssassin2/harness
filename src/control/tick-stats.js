// ASS-490: how long control's ticks take. main.js times each tick(ctx) call
// with a monotonic clock (performance.now), from the call to its return or
// throw — a tick that throws counted too, the sleep between ticks not. Inside
// the tick, every call tick.js itself makes is timed by one helper, ctx.timed
// (timeCall below), under a sub-routine key '<phase>/<name>' (the phase one of
// TICK_PHASES, the name the called function's): its time and calls are summed
// over the tick (a call made once per project counts each), and the top-level
// ones — not one timed inside another — add up to their phase's time. Timing
// deeper later is wrapping more calls in ctx.timed; nothing else changes.
//
// Kept since the control started: the tick count, the lowest, highest and
// mean duration in ms, the last tick's, and when the highest happened; the
// same for each phase and each sub-routine, over the ticks it ran in (a tick
// the data stopped part way, or a drain's skipped dispatch, leaves out what it
// did not reach), a sub-routine with its calls per tick too.
//
// Written to data/projects/<project>/tick-stats.json ($HARNESS_HOME's
// tick-stats.json, ~/.harness by default, for a control with no --project) at
// most every TICK_STATS_WRITE_MS and on shutdown, by a temporary file renamed
// over it (as seats.js writes seats.json):
//   { "control-pid", "started" (ISO), "tick-ms", "written" (ISO),
//     "ticks": <figures>,
//     "phases": { <phase>: { <figures>…, "sub-routines": { "<phase>/<name>": { <figures>…, "calls-last", "calls-mean", "background"? } } } } }
//   <figures>: count, "min-ms", "max-ms", "mean-ms", "last-ms", "max-at" (ISO)
// "background": true marks a sub-routine that starts work it does not await
// (vm-lifecycle.js's VM jobs, steps.js's script steps left running; ASS-497:
// the periodic checks that call out, background-checks.js): only the
// part the tick awaits is timed. A write that fails is logged under "error"
// once per failure streak and never stops the tick. A tick over SLOW_TICK_MS
// logs one 'tick' line with its duration and its three slowest phases and
// sub-routines. harness:tick-stats prints the figures (formatTickStats).
//
// ASS-494: a level deeper inside the sub-routines tick.js marks `deeper`
// (runSteps, finishEnded; ASS-497 moved detectReverts to the background). timeCall runs its fn inside an
// AsyncLocalStorage scope naming the call's key, so a call made within it —
// awaited in turn or synchronous — knows its parent: timeHere(times, name, fn)
// times fn under '<parent key>/<name>' when the parent is deeper (its helpers
// and per-item loop bodies, 'steps/runSteps/runVariation'; ctx.cli and
// ctx.script by command name (ASS-493's ctx.succeeds runs in the background,
// untimed), 'steps/runSteps/runVariation/cli
// ticket:record-output', no arguments; ctx.load as '<parent key>/load'), and
// elsewhere just calls it, untimed. Like ASS-490's, a deeper key is kept flat
// under its phase in tick-stats.json, its parent the key without its last
// '/<name>'; harness:tick-stats indents it under that parent. tick.js times
// each phase's own ctx.load() apart, as '<phase>/load', a top-level call: it
// counts in the phase's time and not in its sub-routine's.
// The depth counter (times.depth: 0 means a top-level call, whose time is the
// phase's) assumes timed calls are awaited in turn, each ending before the one
// that started it: work started in the background and not awaited (steps.js's
// script steps left running, vm-lifecycle.js's VM jobs) must never be timed —
// started outside any deeper scope, or inside one escaped by untimed — or the
// depth would stay up past its parent and the phases after it go unrecorded.
import { AsyncLocalStorage } from 'node:async_hooks';
import { renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// The tick.js phases, as its header numbers them, in order.
export const TICK_PHASES = ['finish', 'registries', 'seats/VMs', 'steps', 'gaps', 'timers', 'dependencies', 'supervise', 'dispatch'];
export const TICK_STATS_WRITE_MS = 30_000;
export const SLOW_TICK_MS = 30_000;
export const BACKGROUND_NOTE = 'Background work the tick starts and does not wait for (VM lifecycle jobs, script steps left running, and since ASS-497 the reverts, gcloud and glab login, usage, API cost and push account checks) is not included: a sub-routine marked (awaited part) is timed only for what the tick waits on; a background check over 10 s logs a \'timers\' line.';

// tickStatsFile({ paths, home, project }) — where a control's figures go: its project's folder, or `home` with none.
export const tickStatsFile = ({ paths, home, project }) => project ? join(paths.projects, project, 'tick-stats.json') : join(home, 'tick-stats.json');

// newTickTimes() — one tick's times, as timeCall fills them: { phases: { <phase>: ms }, subs: { <key>: { phase, ms, calls, background } }, depth }.
export const newTickTimes = () => ({ phases: {}, subs: {}, depth: 0 });

// The timed call this code runs within (ASS-494): { times, phase, key, deeper } — `deeper` when calls inside it are
// timed too (timeHere) — or undefined outside any.
const scope = new AsyncLocalStorage();

// measure(times, phase, name, fn, background, deeper) — fn() run within its scope (above) and timed (performance.now:
// monotonic), thrown or not, into `times` under '<phase>/<name>', summed with its other calls this tick; a top-level
// call (not inside another timed one) adds to its phase's time too. What fn returns is returned as it is when it is
// no promise — a synchronous call (ctx.load) stays synchronous, timed to its return — and a promise is
// timed to its settling, resolving or rejecting as fn's would.
function measure(times, phase, name, fn, background, deeper) {
  const began = performance.now(), key = `${phase}/${name}`;
  const end = () => {
    const ms = performance.now() - began;
    times.depth--;
    const sub = times.subs[key] ??= { phase, ms: 0, calls: 0, background };
    sub.ms += ms; sub.calls++;
    if (times.depth === 0) times.phases[phase] = (times.phases[phase] ?? 0) + ms;
  };
  times.depth++;
  let result;
  try { result = scope.run({ times, phase, key, deeper }, fn); } catch (error) { end(); throw error; }
  if (typeof result?.then !== 'function') { end(); return result; }
  return result.then(value => { end(); return value; }, error => { end(); throw error; });
}

// timeCall(times, phase, name, fn, { background, deeper }) — fn() awaited and timed (measure) under the sub-routine
// '<phase>/<name>'. ctx.timed (tick.js) is this on ctx.tickTimes. `deeper` (ASS-494): calls inside it are timed too
// (timeHere); a call inside a deeper one is deeper itself unless it says otherwise.
export async function timeCall(times, phase, name, fn, { background = false, deeper } = {}) {
  const parent = scope.getStore();
  return await measure(times, phase, name, fn, background, deeper ?? (parent?.times === times && parent.deeper));
}

// timeSync(times, phase, name, fn) — fn() timed as timeCall times it, but not awaited (ASS-494: tick.js's ctx.load()
// of a phase, synchronous, so its time is the phase's without the tick awaiting anything more).
export const timeSync = (times, phase, name, fn) => measure(times, phase, name, fn, false, false);

// timeHere(times, name, fn) — ASS-494: fn() timed under '<parent key>/<name>' (measure; synchronous or not, as fn is)
// when called within a deeper timed call of these `times`; anywhere else fn() just called. Never for work not
// awaited in turn (see the module comment). ctx.timedHere, ctx.cli, ctx.script and ctx.load (tick.js)
// are this on ctx.tickTimes.
export function timeHere(times, name, fn) {
  const at = scope.getStore();
  if (!at?.deeper || at.times !== times) return fn();
  return measure(times, at.phase, `${at.key.slice(at.phase.length + 1)}/${name}`, fn, false, true);
}

// untimed(fn) — ASS-494: fn() run outside any timed call, so nothing it starts is timed, now or once it runs on in
// the background (steps.js's script steps).
export const untimed = fn => scope.run(undefined, fn);

// commandName(argv) — ASS-494: what a script's timing key calls it, its arguments dropped: an agent.sh command's
// name (`./agent.sh automated-tests:verify-exist-and-runnable …` → automated-tests:verify-exist-and-runnable), else
// the program's file name.
export const commandName = argv => (/(^|\/)agent\.sh$/.test(argv[0] ?? '') && argv[1] ? argv[1] : basename(String(argv[0] ?? '?')));

const figures = () => ({ count: 0, total: 0, min: Infinity, max: -Infinity, last: null, maxAt: null });
const add = (f, ms, at) => {
  f.count++; f.total += ms; f.last = ms;
  if (ms < f.min) f.min = ms;
  if (ms > f.max) { f.max = ms; f.maxAt = at; }
};
const order = p => { const i = TICK_PHASES.indexOf(p); return i < 0 ? TICK_PHASES.length : i; };
const ms2 = ms => Math.round(ms * 100) / 100;
const json = f => ({ count: f.count, 'min-ms': ms2(f.min), 'max-ms': ms2(f.max), 'mean-ms': ms2(f.total / f.count), 'last-ms': ms2(f.last), 'max-at': f.maxAt });

// slowTickLine(ms, times) — the slow-tick line's text for a tick of `ms` with its times (newTickTimes' shape), or
// null when it is not over SLOW_TICK_MS (`limit`).
export function slowTickLine(ms, { phases = {}, subs = {} } = {}, limit = SLOW_TICK_MS) {
  if (!(ms > limit)) return null;
  const top3 = entries => entries.sort((a, b) => b[1] - a[1]).slice(0, 3);
  const phase = top3(Object.entries(phases)).map(([p, t]) => `${p} ${Math.round(t)}ms`);
  const sub = top3(Object.entries(subs).map(([k, s]) => [k, s.ms, s.calls])).map(([k, t, n]) => `${k} ${Math.round(t)}ms${n > 1 ? ` (${n} calls)` : ''}`);
  return `slow tick: ${Math.round(ms)}ms, over ${limit}ms; slowest phases: ${phase.join(', ') || 'none timed'}; slowest sub-routines: ${sub.join(', ') || 'none timed'}`;
}

// tickStats({ file, log, pid, tickMs, now, clock, writeMs, slowMs }) — the figures of one control: record(ms, times)
// after each tick (`times` its newTickTimes; a slow tick logged, the file written when writeMs has passed since the
// last write, or at the first), flush() on shutdown, snapshot() what the file holds. now() the wall clock (a Date),
// clock() the monotonic one in ms (the throttle's); tests replace them. Nothing it does throws.
export function tickStats({ file, log = () => {}, pid = process.pid, tickMs, now = () => new Date(), clock = () => performance.now(), writeMs = TICK_STATS_WRITE_MS, slowMs = SLOW_TICK_MS }) {
  const started = now().toISOString(), ticks = figures(), phases = new Map(), subs = new Map();
  let lastWrite = null, failing = false;
  const snapshot = () => {
    const nested = new Map([...phases].sort(([a], [b]) => order(a) - order(b)).map(([p, f]) => [p, { ...json(f), 'sub-routines': {} }]));
    for (const [key, s] of [...subs].sort(([a], [b]) => a.localeCompare(b))) {
      if (!nested.has(s.phase)) nested.set(s.phase, { count: 0, 'sub-routines': {} });
      nested.get(s.phase)['sub-routines'][key] = { ...json(s.figures), 'calls-last': s.callsLast, 'calls-mean': ms2(s.calls / s.figures.count), ...(s.background ? { background: true } : {}) };
    }
    return { 'control-pid': pid, started, 'tick-ms': tickMs, written: now().toISOString(), ticks: ticks.count ? json(ticks) : { count: 0 }, phases: Object.fromEntries(nested) };
  };
  const write = () => {
    lastWrite = clock();
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(snapshot(), null, 2)}\n`);
      renameSync(tmp, file);
      failing = false;
    } catch (error) {
      if (!failing) log('error', `tick-stats: ${file}: ${error.message}; the tick goes on, and this is not said again until a write succeeds`);
      failing = true;
    }
  };
  return {
    snapshot,
    record(ms, times = newTickTimes()) {
      try {
        const at = now().toISOString();
        add(ticks, ms, at);
        for (const [p, t] of Object.entries(times.phases ?? {})) { if (!phases.has(p)) phases.set(p, figures()); add(phases.get(p), t, at); }
        for (const [key, s] of Object.entries(times.subs ?? {})) {
          if (!subs.has(key)) subs.set(key, { phase: s.phase, figures: figures(), calls: 0, callsLast: 0, background: false });
          const kept = subs.get(key);
          add(kept.figures, s.ms, at);
          kept.calls += s.calls; kept.callsLast = s.calls; kept.background ||= Boolean(s.background);
        }
        const slow = slowTickLine(ms, times, slowMs);
        if (slow) log('tick', slow);
        if (lastWrite == null || clock() - lastWrite >= writeMs) write();
      } catch (error) { log('error', `tick-stats: ${error.message}`); }
    },
    flush() { try { write(); } catch { /* never in the way of a shutdown */ } },
  };
}

// nested(phase, subs) — ASS-494: a phase's sub-routines ({ key: figures }) as [key, figures, depth] in display order:
// each under its parent — the longest of its key's '/'-prefixes that is a sub-routine too, else the phase (depth 1) —
// at its parent's depth + 1, slowest average first among those of one parent.
function nested(phase, subs) {
  const children = new Map();
  for (const key of Object.keys(subs)) {
    const parts = key.slice(phase.length + 1).split('/');
    let parent = null;
    for (let n = parts.length - 1; n > 0 && parent == null; n--) if (subs[`${phase}/${parts.slice(0, n).join('/')}`]) parent = `${phase}/${parts.slice(0, n).join('/')}`;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(key);
  }
  const out = [];
  const walk = (parent, depth) => {
    for (const key of (children.get(parent) ?? []).sort((a, b) => (subs[b]['mean-ms'] ?? 0) - (subs[a]['mean-ms'] ?? 0))) {
      out.push([key, subs[key], depth]);
      walk(key, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

// formatTickStats(label, stats) — harness:tick-stats's text for one control's file (or null: none yet), seconds to
// 2 decimals: the tick's figures, then the phase table, each phase's sub-routines indented under it, slowest
// average first; ASS-494: a deeper one indented 2 spaces more under its parent sub-routine, each level slowest
// average first.
const s = ms => ms == null ? '-' : `${(ms / 1000).toFixed(2)}s`;
export function formatTickStats(label, stats) {
  if (!stats) return `${label}: control hasn't recorded any tick times yet (no tick-stats.json)\n`;
  const t = stats.ticks ?? {};
  const lines = [
    `${label}: control pid ${stats['control-pid']}, started ${stats.started}, tick every ${stats['tick-ms']}ms, written ${stats.written}`,
    `  ticks    ${t.count ?? 0}`,
  ];
  if (t.count) lines.push(
    `  lowest   ${s(t['min-ms'])}`,
    `  highest  ${s(t['max-ms'])} (at ${t['max-at']})`,
    `  average  ${s(t['mean-ms'])}`,
    `  last     ${s(t['last-ms'])}`,
  );
  const row = (name, f, calls) => [name, String(f.count ?? 0), s(f['min-ms']), s(f['max-ms']), s(f['mean-ms']), s(f['last-ms']), calls, f['max-at'] ?? '-'];
  const rows = [];
  for (const [p, f] of Object.entries(stats.phases ?? {})) {
    rows.push(row(p, f, ''));
    for (const [key, sub, depth] of nested(p, f['sub-routines'] ?? {})) rows.push(row(`${'  '.repeat(depth)}${key}${sub.background ? ' (awaited part)' : ''}`, sub, String(sub['calls-mean'] ?? '')));
  }
  if (rows.length) {
    const table = [['phase / sub-routine', 'ticks', 'lowest', 'highest', 'average', 'last', 'calls/tick', 'highest at'], ...rows];
    const widths = table[0].map((_, i) => Math.max(...table.map(r => r[i].length)));
    lines.push('', ...table.map(r => `  ${r.map((c, i) => i === 0 || i === r.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join('  ').trimEnd()}`));
  }
  lines.push(`  ${BACKGROUND_NOTE}`);
  return `${lines.join('\n')}\n`;
}
