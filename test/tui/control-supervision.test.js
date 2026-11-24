// ASS-460: the dashboard starts a crashed control again, with backoff, and
// gives up after GIVE_UP.crashes in GIVE_UP.withinMs, until R on the control
// screen; a control down shows in red in the header with its project and last
// error, and notifies once per outage; ASS-457: a control waiting for its
// data shows so. The notifier's programs are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, render, handleKey, controlStarted, controlExited, controlRestarted, controlBack, controlWaiting, RESTART_BACKOFF_MS, GIVE_UP, BACK_MS } from '../../src/tui/app.js';
import { headerWarnings, controlTroubles } from '../../src/tui/screens/frame.js';
import { headerWarningNotifier } from '../../src/notify/notifier.js';

const T0 = Date.parse('2026-11-15T09:11:07Z');
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const projects = ['p', 'q'].map(id => ({ id, name: `Project ${id}`, sprint: null, environments: [] }));
const running = () => {
  let s = initialState({ projects });
  for (const id of ['p', 'q']) s = controlStarted(s, id, { pid: 100, startTime: new Date(T0 - 60e3) });
  return { ...s, controlLog: [{ text: '2026-11-15T09:11:07.000Z error uncaught exception: Error: ENOENT: no such file or directory, open \'/d/assignments.json\'', project: 'p', at: new Date(T0) }, { text: 'control exited (code 70)', project: 'p', at: new Date(T0) }] };
};
const key = (name, extra = {}) => ({ name, ctrl: false, shift: false, ...extra });
const screen = { columns: 160, rows: 50, now: new Date(T0) };

test('ASS-460 AC4: a crashed control is started again after 5 s, 30 s, 2 min, then 5 min, and given up on at the fifth crash in 10 minutes', () => {
  let s = running(), at = T0, pid = 100;
  const delays = [];
  for (let crash = 1; crash <= 4; crash++) {
    s = controlExited(s, 'p', 70, 0, at);
    const down = s.controlsDown.p;
    assert.deepEqual([down.code, down.crashes, down.gaveUp], [70, crash, false]);
    assert.equal(s.controls.p, undefined);
    delays.push(down.restartAt - at);
    at = down.restartAt;
    s = controlRestarted(s, 'p', { pid: ++pid, startTime: new Date(at) }, at);
    assert.equal(s.controls.p.pid, pid);
    assert.deepEqual([s.controlsDown.p.restarted, s.controlsDown.p.restartAt], [at, null]);   // running again; the outage still on
    at += 1000;
  }
  assert.deepEqual(delays, [5e3, 30e3, 120e3, 300e3]);
  assert.deepEqual(RESTART_BACKOFF_MS, delays);
  assert.ok(at - T0 < GIVE_UP.withinMs);
  s = controlExited(s, 'p', 1, 0, at);                                   // the fifth in 10 minutes
  assert.deepEqual([s.controlsDown.p.gaveUp, s.controlsDown.p.restartAt, s.controlsDown.p.crashes], [true, null, 5]);
  assert.match(strip(render(s, { ...screen, now: new Date(at) }).join('\n')), /CONTROL DOWN — Project p — crashed 5 times in 10 minutes, not started again: press R on the control screen \(c\) to start it — last: error uncaught/);
  // Crashes older than the window no longer count: one after a quiet 10 minutes waits 5 s again.
  const later = controlExited(controlRestarted(s, 'p', { pid: 1, startTime: new Date(at) }, at), 'p', 1, 0, at + GIVE_UP.withinMs + 1);
  assert.deepEqual([later.controlsDown.p.crashes, later.controlsDown.p.restartAt - (at + GIVE_UP.withinMs + 1)], [1, 5e3]);
});

test('ASS-460 AC4: not started again — one that exits 0 by itself, any while quitting, or while a restart is under way; 75 is handled as before', () => {
  const s = running();
  const zero = controlExited(s, 'p', 0, 0, T0);
  assert.deepEqual([zero.controlsDown.p.restartAt, zero.controlsDown.p.gaveUp], [null, false]);
  const quitting = { ...s, quitting: true };
  assert.equal(controlExited(quitting, 'p', 1, 0, T0), quitting);
  const restarting = controlExited(s, 'q', 75, 1, T0);
  assert.deepEqual([restarting.restart, restarting.quitting, restarting.controlsDown], [true, false, {}]);
  const crashed = controlExited(restarting, 'p', 1, 0, T0);
  assert.deepEqual([crashed.controlsDown.p.restartAt, crashed.quitting], [null, true]);
});

test('ASS-460 AC4: R on the control screen asks main.js to start the selected project\'s down control, its crashes forgotten; it does nothing for one running', () => {
  const down = { ...controlExited(running(), 'p', 1, 0, T0), screen: 'c' };
  const pressed = handleKey(down, key('R', { sequence: 'R' }));
  assert.equal(pressed.controlRestart, 'p');
  assert.equal(pressed.controlCrashes.p, undefined);
  const elsewhere = handleKey({ ...down, project: 1 }, key('R', { sequence: 'R' }));   // q's control runs
  assert.equal(elsewhere.controlRestart, null);
  assert.match(strip(render(down, { ...screen, now: T0 }).join('\n')), /control: DOWN \(exit 1, restart in 5s, crash 1\)/);   // the footer's first line says when (ASS-566; its DOWN box before)
});

test('ASS-460 AC6: a control down shows in red in the header, whichever project is selected, with its project and last error, until it has run BACK_MS again', () => {
  const s = controlExited(running(), 'p', 70, 0, T0);
  for (const selected of [0, 1]) {
    const header = render({ ...s, project: selected }, screen).find(l => strip(l).includes('CONTROL DOWN'));
    assert.ok(header, `project ${selected}`);
    assert.ok(header.includes('\x1b[31m'));                                // red
    assert.match(strip(header), /CONTROL DOWN — Project p — starting again in 5s \(crash 1\) — last: error uncaught exception: Error: ENOENT: no such file or directory, open '\/d\/assignments\.json'/);
  }
  assert.deepEqual(headerWarnings({ ...s, project: 1 }, T0).filter(w => w.id.startsWith('control-')).map(w => [w.id, w.scope, w.text]),
    [['control-down:p', 'harness', 'Control Project p down: error uncaught exception: Error: ENOENT: no such file or di…']]);
  const restarted = controlRestarted(s, 'p', { pid: 7, startTime: new Date(T0 + 5e3) }, T0 + 5e3);
  assert.match(strip(render(restarted, screen).join('\n')), /CONTROL DOWN — Project p — started again at 09:11:12 UTC — last: /);
  assert.ok(!render(restarted, screen).some(l => strip(l).includes('│ control DOWN')));   // its box shows it running
  assert.equal(controlBack(restarted, 'p', 8), restarted);               // another pid: not it
  const back = controlBack(restarted, 'p', 7);
  assert.deepEqual(back.controlsDown, {});
  assert.equal(controlTroubles(back, T0).length, 0);
  assert.equal(BACK_MS, 60e3);
});

test('ASS-460 AC6: one notification per outage — not again as it crashes on, sent again only once it was back and goes down anew', () => {
  const dir = mkdtempSync(join(tmpdir(), 'control-notify-'));
  writeFileSync(join(dir, 'terminal-notifier'), '');
  chmodSync(join(dir, 'terminal-notifier'), 0o755);
  const runs = [];
  const notifier = headerWarningNotifier({ seenFile: join(dir, 'seen.json'), agentSh: '/h/agent.sh', env: { PATH: dir }, run: (file, args, _opts, done) => { runs.push(args); done(null); }, clock: () => T0 });
  const titles = () => runs.map(args => args[args.indexOf('-title') + 1]);
  let s = running();
  notifier.check(s);                                                     // the start: nothing
  s = controlExited(s, 'p', 70, 0, T0);
  notifier.check(s);
  assert.deepEqual(titles(), ['Control Project p down: error uncaught exception: Error: ENOENT: no such file or di…']);
  s = controlRestarted(s, 'p', { pid: 7, startTime: new Date(T0) }, T0 + 5e3);
  notifier.check(s);
  s = controlExited(s, 'p', 70, 0, T0 + 6e3);                            // the same outage
  notifier.check(s);
  assert.equal(runs.length, 1);
  s = controlRestarted(s, 'p', { pid: 8, startTime: new Date(T0) }, T0 + 40e3);
  s = controlBack(s, 'p', 8);
  notifier.check(s);                                                     // back: cleared
  s = controlExited(s, 'p', 1, 0, T0 + 200e3);
  notifier.check(s);
  assert.equal(runs.length, 2);
});

test('ASS-457 AC2: control\'s "data waiting" line shows it waiting for its data, in the header and the footer, until its "data recovered" line', () => {
  const s = running();
  const at = new Date(T0);
  const waiting = controlWaiting(s, 'p', '2026-11-15T09:11:07.000Z data waiting: cannot read /d/assignments.json (ENOENT: no such file or directory); control skips its ticks until it reads, and exits if it cannot for 300s', at);
  assert.deepEqual(waiting.dataWaiting, { p: { text: 'cannot read /d/assignments.json (ENOENT: no such file or directory)', since: at } });
  assert.equal(controlWaiting(waiting, 'p', '2026-11-15T09:11:09.000Z dispatch x'), waiting);   // any other line: nothing
  const text = strip(render(waiting, screen).join('\n'));
  assert.match(text, /CONTROL PROJECT P WAITING FOR ITS DATA since 09:11:07 UTC — cannot read \/d\/assignments\.json \(ENOENT/);
  assert.match(text, /control: waiting for its data \(/);   // the footer's first line (ASS-566; its box's status before)
  const warning = headerWarnings(waiting, T0).find(w => w.id === 'control-data-wait');
  assert.deepEqual([warning.scope, warning.text, warning.after], ['project', 'Control waiting for its data', 60e3]);
  const recovered = controlWaiting(waiting, 'p', '2026-11-15T09:11:20.000Z data recovered: it reads again after 13s (/d/assignments.json); control carries on with its agents, VMs and workstations');
  assert.deepEqual(recovered.dataWaiting, {});
  assert.ok(!strip(render(recovered, screen).join('\n')).includes('WAITING FOR ITS DATA'));
});
