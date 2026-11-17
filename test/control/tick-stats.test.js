// ASS-490: how long control's ticks take (src/control/tick-stats.js): the
// figures over known durations, the throttled and shut-down writes, a failed
// write logged once per streak, the slow-tick line; control itself (main.js)
// timing every tick, a thrown one too, into its project's tick-stats.json; and
// harness:tick-stats printing them, with and without a file.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { tickStats, tickStatsFile, slowTickLine, newTickTimes, timeCall, TICK_PHASES, SLOW_TICK_MS, TICK_STATS_WRITE_MS, BACKGROUND_NOTE } from '../../src/control/tick-stats.js';
import { createContext } from '../../src/control/tick.js';
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
  // Each call tick.js makes, nested under its phase as '<phase>/<function>'; the VM phase's marked as background.
  assert.deepEqual(Object.keys(s.phases.timers['sub-routines']).toSorted(), ['timers/checkApiCost', 'timers/checkGcloud', 'timers/checkGlab', 'timers/checkPushAccount', 'timers/checkUsage', 'timers/detectReverts', 'timers/fireTimers']);
  assert.deepEqual(Object.keys(s.phases.steps['sub-routines']).toSorted(), ['steps/checkCredentials', 'steps/checkDisk', 'steps/checkRateLimits', 'steps/fastTrack', 'steps/runSteps']);
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
