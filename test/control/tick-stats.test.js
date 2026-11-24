// ASS-490: how long control's ticks take (src/control/tick-stats.js): the
// figures over known durations, the throttled and shut-down writes, a failed
// write logged once per streak, the slow-tick line; control itself (main.js)
// timing every tick, a thrown one too, into its project's tick-stats.json; and
// harness:tick-stats printing them, with and without a file. ASS-494: a level
// deeper inside runSteps and finishEnded (ASS-497 runs detectReverts in the background) — their helpers and
// loop bodies, agent.sh calls and script checks by command name, loads — each
// phase's load timed apart, and the nested printing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { tickStats, tickStatsFile, slowTickLine, newTickTimes, timeCall, commandName, formatTickStats, TICK_PHASES, SLOW_TICK_MS, TICK_STATS_WRITE_MS, BACKGROUND_NOTE } from '../../src/control/tick-stats.js';
import { createContext, tick as runTick } from '../../src/control/tick.js';
import { controlFixture } from './control-fixture.js';
import { run as runAgent, AGENT } from '../agent-cli/harness-fixture.js';
import { until, within } from '../support/until.js';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
// A tickStats on a fake wall clock and monotonic clock, its log kept.
function stats({ file = join(mkdtempSync(join(tmpdir(), 'tick-stats-')), 'tick-stats.json'), ...rest } = {}) {
  const clock = { mono: 0, wall: Date.parse('2026-11-17T10:00:00Z') }, said = [];
  const s = tickStats({ file, log: (phase, text) => said.push(`${phase} ${text}`), pid: 4242, tickMs: 2000, now: () => new Date(clock.wall), clock: () => clock.mono, ...rest });
  // tick(ms, phases, subs): a tick of `ms` recorded with those times, both clocks moved on by it.
  const tick = (ms, phases = {}, subs = {}) => { clock.mono += ms; clock.wall += ms; s.record(ms, { phases, subs }); };
  return { s, file, clock, said, tick };
}

test('ASS-490 AC2: the figures since start — count, lowest, highest and when, mean, last — overall, per phase and per sub-routine nested under its phase, each counted over the ticks it ran in', () => {
  const { s, tick } = stats({ writeMs: Infinity });
  const sub = (phase, ms, calls = 1, background) => ({ phase, ms, calls, ...(background ? { background } : {}) });
  tick(100, { finish: 40, dispatch: 60 }, { 'finish/finishEnded': sub('finish', 40), 'dispatch/dispatch': sub('dispatch', 60) });
  tick(300, { finish: 250, dispatch: 50 }, { 'finish/finishEnded': sub('finish', 250, 3), 'dispatch/dispatch': sub('dispatch', 50) });
  tick(200, { finish: 10, 'seats/VMs': 5 }, { 'finish/finishEnded': sub('finish', 10, 2), 'seats/VMs/superviseVms': sub('seats/VMs', 5, 1, true) });   // the data stopped this one before dispatch
  const snap = s.snapshot();
  assert.deepEqual({ ...snap, written: null }, {
    'control-pid': 4242, started: '2026-11-17T10:00:00.000Z', 'tick-ms': 2000, written: null,
    ticks: { count: 3, 'min-ms': 100, 'max-ms': 300, 'mean-ms': 200, 'last-ms': 200, 'max-at': '2026-11-17T10:00:00.400Z' },
    phases: {
      finish: { count: 3, 'min-ms': 10, 'max-ms': 250, 'mean-ms': 100, 'last-ms': 10, 'max-at': '2026-11-17T10:00:00.400Z', 'sub-routines': {
        'finish/finishEnded': { count: 3, 'min-ms': 10, 'max-ms': 250, 'mean-ms': 100, 'last-ms': 10, 'max-at': '2026-11-17T10:00:00.400Z', 'calls-last': 2, 'calls-mean': 2 },
      } },
      'seats/VMs': { count: 1, 'min-ms': 5, 'max-ms': 5, 'mean-ms': 5, 'last-ms': 5, 'max-at': '2026-11-17T10:00:00.600Z', 'sub-routines': {
        'seats/VMs/superviseVms': { count: 1, 'min-ms': 5, 'max-ms': 5, 'mean-ms': 5, 'last-ms': 5, 'max-at': '2026-11-17T10:00:00.600Z', 'calls-last': 1, 'calls-mean': 1, background: true },
      } },
      dispatch: { count: 2, 'min-ms': 50, 'max-ms': 60, 'mean-ms': 55, 'last-ms': 50, 'max-at': '2026-11-17T10:00:00.100Z', 'sub-routines': {
        'dispatch/dispatch': { count: 2, 'min-ms': 50, 'max-ms': 60, 'mean-ms': 55, 'last-ms': 50, 'max-at': '2026-11-17T10:00:00.100Z', 'calls-last': 1, 'calls-mean': 1 },
      } },
    },
  });
  assert.deepEqual(Object.keys(stats().s.snapshot().phases), []);
  assert.deepEqual(stats().s.snapshot().ticks, { count: 0 });
});

test('ASS-490 AC2: ctx.timed, the one timing helper, sums a sub-routine\'s calls within a tick (one per project) with their count, a top-level call adding to its phase and one inside it not, a thrown call timed too; each tick starts afresh', async () => {
  const ctx = createContext({ root: '/nowhere', env: {} });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const project of ['a', 'b']) await ctx.timed('timers', 'checkUsage', () => wait(20), { background: project === 'b' });
  await ctx.timed('seats/VMs', 'superviseVms', () => ctx.timed('seats/VMs', 'superviseVms/match', () => wait(20)));
  await assert.rejects(ctx.timed('finish', 'finishEnded', async () => { await wait(10); throw new Error('boom'); }), /boom/);
  const { phases, subs } = ctx.tickTimes;
  assert.deepEqual(Object.keys(subs), ['timers/checkUsage', 'seats/VMs/superviseVms/match', 'seats/VMs/superviseVms', 'finish/finishEnded']);
  assert.deepEqual([subs['timers/checkUsage'].calls, subs['timers/checkUsage'].background, subs['seats/VMs/superviseVms'].calls], [2, false, 1]);
  assert.ok(subs['timers/checkUsage'].ms >= 38, subs['timers/checkUsage'].ms);
  assert.equal(phases.timers, subs['timers/checkUsage'].ms);
  assert.equal(phases['seats/VMs'], subs['seats/VMs/superviseVms'].ms);                       // the inner call not counted twice
  assert.ok(phases.finish >= 9);
  // A sub-routine's times are its own: with timeCall on a fresh tick's times, the last tick's are not carried.
  const times = newTickTimes();
  await timeCall(times, 'gaps', 'detectGaps', () => wait(1));
  assert.deepEqual(Object.keys(times.subs), ['gaps/detectGaps']);
});

test('ASS-490 AC3: the file is written at the first tick, then at most every 30 seconds (by a temporary file renamed over it), and on shutdown', () => {
  assert.equal(TICK_STATS_WRITE_MS, 30_000);
  const { s, file, tick } = stats();
  tick(100);
  assert.equal(read(file).ticks.count, 1);
  assert.ok(!existsSync(`${file}.tmp`));
  tick(10_000); tick(10_000);                                       // 20.1 s since the write
  assert.equal(read(file).ticks.count, 1);
  tick(9_900);                                                      // 29.9 s since it
  assert.equal(read(file).ticks.count, 1);
  tick(100);                                                        // 30 s since it
  assert.equal(read(file).ticks.count, 5);
  tick(5);
  assert.equal(read(file).ticks.count, 5);
  s.flush();                                                        // shutdown
  assert.deepEqual([read(file).ticks.count, read(file)['control-pid'], read(file)['tick-ms']], [6, 4242, 2000]);
});

test('ASS-490 AC3: a write that fails is logged once per failure streak and never throws; once one succeeds, a new failure is logged again', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'tick-stats-')), 'gone');
  const { s, said, tick } = stats({ file: join(dir, 'tick-stats.json'), writeMs: 0 });
  tick(1); tick(1); s.flush();
  assert.equal(said.length, 1, said.join('\n'));
  assert.match(said[0], /^error tick-stats: .*gone\/tick-stats\.json: ENOENT.*; the tick goes on/);
  mkdirSync(dir);
  tick(1);
  assert.equal(read(join(dir, 'tick-stats.json')).ticks.count, 3);
  rmSync(dir, { recursive: true });
  tick(1); tick(1);
  assert.equal(said.length, 2, said.join('\n'));
});

test('ASS-490 AC4, AC5: a tick over 30 seconds logs one \'tick\' line with its duration and its three slowest phases and sub-routines; one at or under it, none', () => {
  assert.equal(SLOW_TICK_MS, 30_000);
  const { said, tick } = stats({ writeMs: Infinity });
  tick(30_000, { finish: 30_000 });
  assert.deepEqual(said, []);
  tick(31_204.6, { finish: 1000, 'seats/VMs': 20_000.4, timers: 9000, dispatch: 1200, gaps: 4 }, {
    'seats/VMs/superviseVms': { phase: 'seats/VMs', ms: 19_000, calls: 1 }, 'seats/VMs/assignSeats': { phase: 'seats/VMs', ms: 1000.4, calls: 1 },
    'timers/checkUsage': { phase: 'timers', ms: 8000, calls: 3 }, 'timers/checkGcloud': { phase: 'timers', ms: 1000, calls: 1 },
    'finish/finishEnded': { phase: 'finish', ms: 1000, calls: 1 }, 'dispatch/dispatch': { phase: 'dispatch', ms: 1200, calls: 1 },
  });
  assert.deepEqual(said, ['tick slow tick: 31205ms, over 30000ms; slowest phases: seats/VMs 20000ms, timers 9000ms, dispatch 1200ms; slowest sub-routines: seats/VMs/superviseVms 19000ms, timers/checkUsage 8000ms (3 calls), dispatch/dispatch 1200ms']);
  assert.equal(slowTickLine(40_000, {}), 'slow tick: 40000ms, over 30000ms; slowest phases: none timed; slowest sub-routines: none timed');
});

test('ASS-490 AC3: the file is the project\'s for a project\'s control, $HARNESS_HOME\'s for one with no --project', () => {
  assert.equal(tickStatsFile({ paths: { projects: '/d/projects' }, home: '/h', project: 'acme-shop' }), '/d/projects/acme-shop/tick-stats.json');
  assert.equal(tickStatsFile({ paths: { projects: '/d/projects' }, home: '/h', project: null }), '/h/tick-stats.json');
});

// Control as the supervisor runs it (as control.test.js runs it): max-agents 0, its own HARNESS_HOME.
const MAIN = join(import.meta.dirname, '..', '..', 'src', 'control', 'main.js');
const children = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });
function processFixture() {
  const f = controlFixture();
  writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...f.harness(), 'max-agents': 0 }));
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  return { ...f, home, env: { ...f.env, HARNESS_HOME: home } };
}
function run(f, args, env = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...f.env, CONTROL_TEST_TICK_LINES: '1', ...env } });
  children.push(child);
  const lines = [];
  createInterface({ input: child.stdout }).on('line', line => lines.push(line));
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, lines, exit };
}
// harness:tick-stats on the fixture's data and its own HARNESS_HOME (f.agent's env has none: it would read the real one).
const tickStatsCommand = (f, ...args) => runAgent(AGENT, ['harness:tick-stats', ...args], { env: f.env });
const ticksIn = lines => lines.filter(l => / test tick ran$/.test(l)).length;

test('ASS-490 AC1, AC2, AC3: control --project times each tick and each of tick.js\'s nine phases into data/projects/<project>/tick-stats.json, with its pid, start and tick-ms', async () => {
  const f = processFixture();
  const control = run(f, ['--once', '--project', 'p', '--tick-ms', '1234']);
  assert.deepEqual(await within(control.exit), { code: 0, signal: null });
  const file = join(f.dir, 'projects', 'p', 'tick-stats.json');
  const s = read(file);
  assert.equal(s['control-pid'], control.child.pid);
  assert.equal(s['tick-ms'], 1234);
  assert.ok(Date.parse(s.started) <= Date.parse(s.written));
  assert.equal(s.ticks.count, 1);
  assert.ok(s.ticks['min-ms'] > 0 && s.ticks['min-ms'] === s.ticks['max-ms'] && s.ticks['last-ms'] === s.ticks['mean-ms']);
  assert.deepEqual(Object.keys(s.phases), TICK_PHASES);
  // Each call tick.js makes, nested under its phase as '<phase>/<function>' (ASS-494: its loads too, as '<phase>/load';
  // the deeper keys under runSteps left out here); the VM phase's marked as background.
  const top = (phase, keys) => Object.keys(keys).filter(k => !k.slice(phase.length + 1).includes('/')).toSorted();
  assert.deepEqual(top('timers', s.phases.timers['sub-routines']), ['timers/checkApiCost', 'timers/checkGcloud', 'timers/checkGlab', 'timers/checkPushAccount', 'timers/checkUsage', 'timers/detectReverts', 'timers/fireTimers', 'timers/load', 'timers/refreshCommitLists']);   // ASS-558: refreshCommitLists
  assert.deepEqual(top('steps', s.phases.steps['sub-routines']), ['steps/checkCredentials', 'steps/checkDisk', 'steps/checkRateLimits', 'steps/fastTrack', 'steps/load', 'steps/runSteps']);
  assert.equal(s.phases['seats/VMs']['sub-routines']['seats/VMs/superviseVms'].background, true);
  assert.equal(s.phases.finish['sub-routines']['finish/finishEnded']['calls-last'], 1);
  const phaseSum = Object.values(s.phases).reduce((sum, p) => sum + p['last-ms'], 0);
  assert.ok(phaseSum <= s.ticks['last-ms'] + 0.05, `${phaseSum} > ${s.ticks['last-ms']}`);
  assert.ok(!existsSync(join(f.home, 'tick-stats.json')));
});

test('ASS-490 AC1, AC3: a tick that throws is counted, and on shutdown the file holds every tick; with no --project it is $HARNESS_HOME\'s', async () => {
  const f = processFixture();
  const control = run(f, ['--tick-ms', '50'], { CONTROL_TEST_FAULT: 'tick' });
  try {
    assert.ok(await until(() => ticksIn(control.lines) >= 4), control.lines.join('\n'));
    control.child.stdin.end();
    assert.deepEqual(await within(control.exit), { code: 0, signal: null });
    const s = read(join(f.home, 'tick-stats.json'));
    assert.equal(s.ticks.count, ticksIn(control.lines), control.lines.join('\n'));                  // the two thrown ones too
    assert.equal(s.phases.finish.count, s.ticks.count - 2);                                         // the thrown ones ran no phase
  } finally { control.child.kill('SIGKILL'); }
});

test('ASS-490 AC5: harness:tick-stats prints each project\'s figures in seconds, the per-phase table and the background note; without a file, that none are recorded yet (exit 0); an unknown project fails', async () => {
  const f = processFixture();
  const none = await tickStatsCommand(f, 'p');
  assert.equal(none.stdout, 'p: control hasn\'t recorded any tick times yet (no tick-stats.json)\n');
  writeFileSync(join(f.dir, 'projects', 'p', 'tick-stats.json'), JSON.stringify({
    'control-pid': 77, started: '2026-11-17T10:00:00.000Z', 'tick-ms': 2000, written: '2026-11-17T11:00:00.000Z',
    ticks: { count: 1800, 'min-ms': 41.2, 'max-ms': 12345.6, 'mean-ms': 456.789, 'last-ms': 400, 'max-at': '2026-11-17T10:30:00.000Z' },
    phases: {
      finish: { count: 1800, 'min-ms': 1, 'max-ms': 50, 'mean-ms': 5.5, 'last-ms': 4, 'max-at': '2026-11-17T10:10:00.000Z', 'sub-routines': {
        'finish/finishEnded': { count: 1800, 'min-ms': 1, 'max-ms': 50, 'mean-ms': 5.5, 'last-ms': 4, 'max-at': '2026-11-17T10:10:00.000Z', 'calls-last': 1, 'calls-mean': 1 },
      } },
      'seats/VMs': { count: 1799, 'min-ms': 20, 'max-ms': 12000, 'mean-ms': 300, 'last-ms': 250, 'max-at': '2026-11-17T10:30:00.000Z', 'sub-routines': {
        'seats/VMs/assignSeats': { count: 1799, 'min-ms': 5, 'max-ms': 900, 'mean-ms': 20, 'last-ms': 10, 'max-at': '2026-11-17T10:20:00.000Z', 'calls-last': 1, 'calls-mean': 1 },
        'seats/VMs/superviseVms': { count: 1799, 'min-ms': 10, 'max-ms': 11000, 'mean-ms': 270, 'last-ms': 230, 'max-at': '2026-11-17T10:30:00.000Z', 'calls-last': 2, 'calls-mean': 1.5, background: true },
      } },
    },
  }));
  const { stdout } = await tickStatsCommand(f, 'p');
  assert.equal(stdout, [
    'p: control pid 77, started 2026-11-17T10:00:00.000Z, tick every 2000ms, written 2026-11-17T11:00:00.000Z',
    '  ticks    1800',
    '  lowest   0.04s',
    '  highest  12.35s (at 2026-11-17T10:30:00.000Z)',
    '  average  0.46s',
    '  last     0.40s',
    '',
    '  phase / sub-routine                      ticks  lowest  highest  average   last  calls/tick  highest at',
    '  finish                                    1800   0.00s    0.05s    0.01s  0.00s              2026-11-17T10:10:00.000Z',
    '    finish/finishEnded                      1800   0.00s    0.05s    0.01s  0.00s           1  2026-11-17T10:10:00.000Z',
    '  seats/VMs                                 1799   0.02s   12.00s    0.30s  0.25s              2026-11-17T10:30:00.000Z',
    '    seats/VMs/superviseVms (awaited part)   1799   0.01s   11.00s    0.27s  0.23s         1.5  2026-11-17T10:30:00.000Z',
    '    seats/VMs/assignSeats                   1799   0.01s    0.90s    0.02s  0.01s           1  2026-11-17T10:20:00.000Z',
    `  ${BACKGROUND_NOTE}`,
    '',
  ].join('\n'));
  assert.match(BACKGROUND_NOTE, /VM lifecycle jobs/);
  // Every project (the fixture has p alone), and the harness-wide control's file when there is one.
  const all = await tickStatsCommand(f);
  assert.equal(all.stdout, stdout);
  writeFileSync(join(f.home, 'tick-stats.json'), JSON.stringify({ 'control-pid': 78, started: 'S', 'tick-ms': 2000, written: 'W', ticks: { count: 0 }, phases: {} }));
  const both = await tickStatsCommand(f);
  assert.match(both.stdout, /\nall projects \(a control with no --project\): control pid 78, started S, tick every 2000ms, written W\n {2}ticks {4}0\n/);
  await assert.rejects(tickStatsCommand(f, 'nope'), /harness:tick-stats: no project nope/);
});

test('ASS-490 AC5: harness:tick-stats is listed in agent.sh\'s help with the other harness: commands', async () => {
  const f = processFixture();
  const { stdout } = await f.agent('--help');
  assert.match(stdout, /\nharness:\n(?: {2}harness:.*\n)* {2}harness:tick-stats +Print how long control's ticks take/);
});

// ASS-494: a root whose agent.sh echoes its arguments; `fail` exits 3 with "nope" on stderr; `slow <file>` waits
// first until <file> exists (ASS-545: a gate the test opens, not a fixed sleep a loaded machine could outlast).
function echoRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tick-stats-root-'));
  writeFileSync(join(root, 'agent.sh'), '#!/bin/sh\n[ "$1" = fail ] && { echo nope >&2; exit 3; }\nif [ "$1" = slow ]; then while [ ! -e "$2" ]; do sleep 0.05; done; fi\necho "$@"\n', { mode: 0o755 });
  return root;
}
const subsOf = ctx => Object.fromEntries(Object.entries(ctx.tickTimes.subs).map(([k, s]) => [k, s.calls]));

test('ASS-494 AC1, AC2, AC4: within a deeper sub-routine, each helper and loop body is timed under \'<phase>/<parent>/<name>\', and the agent.sh calls and scripts within by command name (the background script checks of ASS-493 untimed) with no arguments, summed per tick with their calls; errors and synchronous results as before', async () => {
  const ctx = createContext({ root: echoRoot(), env: { PATH: process.env.PATH } });
  await ctx.timed('steps', 'runSteps', async () => {
    await ctx.timedHere('escalateFailedStarts', async () => {});
    for (const v of ['A', 'B']) {
      await ctx.timedHere('runVariation', async () => {
        assert.equal(await ctx.cli(['ticket:record-output', 'p', 'T-1', v, 'out', '{"x":1}']), `ticket:record-output p T-1 ${v} out {"x":1}\n`);
        assert.equal(await ctx.succeeds(['./agent.sh', 'automated-tests:verify-exist-and-runnable', 'p', 'T-1', v]), true);   // ASS-493: run in the background, so untimed
        assert.equal((await ctx.script(['./agent.sh', 'tests:run', 'T-1', v])).exitCode, 0);
      });
    }
    await assert.rejects(ctx.cli(['fail', 'T-1']), /agent\.sh fail T-1: nope/);                                    // a failure rejects as before
    assert.equal(ctx.timedHere('ranked', () => 5), 5);                                                             // a synchronous call stays synchronous
    assert.throws(() => ctx.timedHere('broken', () => { throw new Error('sync boom'); }), /sync boom/);           // …and throws synchronously
  }, { deeper: true });
  assert.deepEqual(subsOf(ctx), {
    'steps/runSteps/escalateFailedStarts': 1,
    'steps/runSteps/runVariation/cli ticket:record-output': 2,
    'steps/runSteps/runVariation/script tests:run': 2,
    'steps/runSteps/runVariation': 2,
    'steps/runSteps/cli fail': 1,
    'steps/runSteps/ranked': 1,
    'steps/runSteps/broken': 1,
    'steps/runSteps': 1,
  });
  const { subs, phases, depth } = ctx.tickTimes;
  assert.equal(depth, 0);
  assert.equal(phases.steps, subs['steps/runSteps'].ms);                                                           // the deeper ones not counted twice
  const inner = ['cli ticket:record-output', 'script tests:run'].reduce((sum, k) => sum + subs[`steps/runSteps/runVariation/${k}`].ms, 0);
  assert.ok(subs['steps/runSteps/runVariation'].ms >= inner, `${subs['steps/runSteps/runVariation'].ms} < ${inner}`);
  assert.equal(subs['steps/runSteps/runVariation'].phase, 'steps');
});

test('ASS-494 AC4: outside a deeper sub-routine nothing more is timed; work started untimed and not awaited is never timed, and the phases after it are recorded as before', async () => {
  const ctx = createContext({ root: echoRoot(), env: { PATH: process.env.PATH } });
  assert.equal(await ctx.cli(['ticket:get', 'T-1']), 'ticket:get T-1\n');                                         // no timed call around it
  assert.equal(ctx.timedHere('x', () => 1), 1);
  await ctx.timed('timers', 'checkUsage', () => ctx.cli(['usage:check']));                                          // not a deeper one
  let background, settled = false;
  const gate = join(mkdtempSync(join(tmpdir(), 'tick-stats-gate-')), 'open');
  await ctx.timed('steps', 'runSteps', () => ctx.timedHere('runVariation', async () => {
    background = ctx.untimed(() => ctx.cli(['slow', gate]));                                                        // a script step left running
    background.finally(() => { settled = true; });
  }), { deeper: true });
  assert.equal(ctx.tickTimes.depth, 0);
  await ctx.timed('dispatch', 'dispatch', async () => {});
  // ASS-545: the slow call not waited for — it cannot end before the gate opens, so the phases above returned
  // without it, whatever the machine's speed (was: steps under 300 ms, against a 0.3 s sleep).
  assert.equal(settled, false, 'the phases did not wait for the slow call');
  writeFileSync(gate, '');
  assert.equal(await background, `slow ${gate}\n`);
  assert.deepEqual(subsOf(ctx), { 'timers/checkUsage': 1, 'steps/runSteps/runVariation': 1, 'steps/runSteps': 1, 'dispatch/dispatch': 1 });
  assert.deepEqual(Object.keys(ctx.tickTimes.phases), ['timers', 'steps', 'dispatch']);
});

test('ASS-494 AC2: a script\'s key names its agent.sh command, or else its program, its arguments dropped', () => {
  assert.equal(commandName(['./agent.sh', 'automated-tests:verify-exist-and-runnable', 'p', 'T-1', 'A']), 'automated-tests:verify-exist-and-runnable');
  assert.equal(commandName(['/opt/harness/agent.sh', 'vm:step-start', 'x']), 'vm:step-start');
  assert.equal(commandName(['/usr/bin/test', '-f', '/repos/.setup-complete']), 'test');
  assert.equal(commandName(['npm', 'test']), 'npm');
});

test('ASS-494 AC1, AC3: in a tick, each phase\'s load is timed apart as \'<phase>/load\', the phase\'s time its top-level calls\' with it; runSteps\' and finishEnded\'s deeper keys recorded, ticket names in none', async () => {
  const f = controlFixture();
  // ASS-545: no agent dispatched (max-agents 0), so the ghost below is the only agent finishEnded can see: before, the
  // plan agent the first tick dispatched sometimes ended before the second tick (a loaded machine's timing), giving
  // finishOne a second call.
  const harness = join(f.dir, 'harness.json');
  writeFileSync(harness, JSON.stringify({ ...JSON.parse(readFileSync(harness, 'utf8')), 'max-agents': 0 }));
  await runTick(f.ctx);                                                                                            // ABC-3 A: backlog → committed
  assert.equal(f.ctx.agents.size, 0, 'no agent dispatched');
  const check = () => {
    const { phases, subs, depth } = f.ctx.tickTimes;
    assert.equal(depth, 0);
    for (const phase of TICK_PHASES) {
      assert.ok(subs[`${phase}/load`]?.calls >= 1, `${phase}/load`);
      const top = Object.entries(subs).filter(([k, s]) => s.phase === phase && !k.slice(phase.length + 1).includes('/'));
      const sum = top.reduce((t, [, s]) => t + s.ms, 0);
      assert.ok(Math.abs(phases[phase] - sum) < 1e-6, `${phase}: ${phases[phase]} ≠ ${sum}`);
    }
    assert.ok(!Object.keys(subs).some(k => /ABC-3|\bp\b/.test(k)), Object.keys(subs).join('\n'));
    return subs;
  };
  let subs = check();
  assert.equal(subs['finish/load'].calls, 1);
  assert.equal(subs['timers/load'].calls, 8);                                                                      // one per timers phase function (ASS-558: refreshCommitLists the eighth)
  for (const key of ['steps/runSteps/escalateFailedStarts', 'steps/runSteps/blockFailing', 'steps/runSteps/stopAtSpendingLimit', 'steps/runSteps/load', 'steps/runSteps/runVariation', 'steps/runSteps/runVariation/load', 'steps/runSteps/runVariation/cli ticket:change-state']) assert.ok(subs[key], key);
  assert.equal(subs['steps/runSteps/runVariation'].calls, 1);
  // An agent that ended with no assignment left: finishEnded's finishOne for it, its load inside.
  f.ctx.agents.set('ghost', { name: 'ghost', result: {}, agent: { stop() {} }, record: {} });
  await runTick(f.ctx);
  subs = check();
  assert.equal(subs['finish/finishEnded/finishOne'].calls, 1);
  assert.equal(subs['finish/finishEnded/finishOne/load'].calls, 1);
  assert.ok(!f.ctx.agents.has('ghost'));
});

test('ASS-494 AC5: harness:tick-stats indents each deeper key 2 more spaces under its parent sub-routine, slowest average first at each level; tick-stats.json keeps them flat under their phase', () => {
  const fig = (mean, calls = 1) => ({ count: 10, 'min-ms': mean / 2, 'max-ms': mean * 2, 'mean-ms': mean, 'last-ms': mean, 'max-at': 'T', 'calls-last': calls, 'calls-mean': calls });
  const text = formatTickStats('p', {
    'control-pid': 1, started: 'S', 'tick-ms': 2000, written: 'W', ticks: { count: 0 },
    phases: {
      steps: { ...fig(2000), 'sub-routines': {
        'steps/load': fig(10),
        'steps/runSteps': { ...fig(1700), background: true },
        'steps/runSteps/load': fig(20, 3),
        'steps/runSteps/runTransient': fig(300, 2),
        'steps/runSteps/runTransient/cli transient-state-engine:create': fig(200),
        'steps/runSteps/runVariation': fig(1200, 4),
        'steps/runSteps/runVariation/cli ticket:change-state': fig(400, 2),
        'steps/runSteps/runVariation/scriptExit': fig(700),
        'steps/runSteps/runVariation/load': fig(30, 5),
        'steps/fastTrack': fig(50),
      } },
      'seats/VMs': { ...fig(100), 'sub-routines': {
        'seats/VMs/superviseVms': fig(60),
        'seats/VMs/superviseVms/match': fig(40),
        'seats/VMs/gone/orphan': fig(90),                                                                        // its parent never timed: under the phase
      } },
    },
  });
  const names = text.split('\n').filter(l => /^ {2}\S| {4}/.test(l) && / T$/.test(l)).map(l => l.replace(/ {2,}\d.*$/, ''));
  assert.deepEqual(names, [
    '  steps',
    '    steps/runSteps (awaited part)',
    '      steps/runSteps/runVariation',
    '        steps/runSteps/runVariation/scriptExit',
    '        steps/runSteps/runVariation/cli ticket:change-state',
    '        steps/runSteps/runVariation/load',
    '      steps/runSteps/runTransient',
    '        steps/runSteps/runTransient/cli transient-state-engine:create',
    '      steps/runSteps/load',
    '    steps/fastTrack',
    '    steps/load',
    '  seats/VMs',
    '    seats/VMs/gone/orphan',
    '    seats/VMs/superviseVms',
    '      seats/VMs/superviseVms/match',
  ]);
  // The file keeps ASS-490's shape: each deeper key flat under its phase.
  const { s, tick } = stats({ writeMs: Infinity });
  tick(100, { steps: 90 }, { 'steps/runSteps': { phase: 'steps', ms: 80, calls: 1 }, 'steps/runSteps/runVariation/cli ticket:change-state': { phase: 'steps', ms: 30, calls: 2 }, 'steps/load': { phase: 'steps', ms: 10, calls: 1 } });
  assert.deepEqual(Object.keys(s.snapshot().phases.steps['sub-routines']), ['steps/load', 'steps/runSteps', 'steps/runSteps/runVariation/cli ticket:change-state']);
  assert.equal(s.snapshot().phases.steps['sub-routines']['steps/runSteps/runVariation/cli ticket:change-state']['calls-last'], 2);
});
