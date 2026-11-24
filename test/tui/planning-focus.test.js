// ASS-531 AC2: the sprint screen shows the project's focus-on-planning switch (under the progress bar, and a header
// chip while it is on) and P flips it through `agent.sh project:set-planning-focus` (main.js runs planningFocusRun);
// P is listed in the ? menu on the sprint screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render, handleKey } from '../../src/tui/app.js';
import { focusLine, PLANNING_FOCUS_KEY } from '../../src/tui/screens/sprint.js';
import { headerWarnings } from '../../src/tui/screens/frame.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 60, now: new Date('2026-11-22T02:30:00Z') };
const P = { name: 'p', sequence: 'P' };
const steps = [
  { id: 'committed', name: 'Committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const sprint = { number: 10, start: '2026-11-16', end: '2026-11-29', features: [{ key: 'A-1', title: 'One', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }] }], bugs: [], spikes: [] };
const stateOf = planningFocus => initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint, planningFocus, limits: { project: {}, harness: {} } }], workflows: [{ name: 'e', steps }], assignments: [] });
const ON = { on: true, by: 'ada', at: '2026-11-22T01:00:00Z' };

test('AC2: P on the sprint screen flips the switch on screen and asks main.js to run project:set-planning-focus', () => {
  const on = handleKey(stateOf(null), P, wide);
  assert.deepEqual(on.planningFocusRun, ['project:set-planning-focus', 'p', 'on']);
  assert.equal(on.projects[0].planningFocus.on, true);
  const off = handleKey({ ...stateOf(ON), planningFocusRun: null }, P, wide);
  assert.deepEqual(off.planningFocusRun, ['project:set-planning-focus', 'p', 'off']);
  assert.equal(off.projects[0].planningFocus.on, false);
  // Not on another screen, nor on a past day.
  assert.equal(handleKey({ ...stateOf(null), screen: 'c' }, P, wide).planningFocusRun ?? null, null);
  assert.equal(handleKey({ ...stateOf(null), day: '2026-11-20' }, P, wide).planningFocusRun ?? null, null);
});

test('AC2: the sprint screen shows the switch under the progress bar — off, its key; on, who and since when — and a header chip while on', () => {
  const offLines = render(stateOf(null), wide).map(strip);
  assert.ok(offLines.some(l => l === `${PLANNING_FOCUS_KEY} focus on planning: off`), offLines.join('\n'));
  const onLines = render(stateOf(ON), wide).map(strip);
  assert.ok(onLines.some(l => l.startsWith('FOCUS ON PLANNING (by ada, 1h 30m ago): tickets at planning steps get seats and agents first · P turns it off')), onLines.join('\n'));
  assert.ok(onLines.some(l => l.includes('Focus on planning')), 'the header chip');
  assert.equal(strip(focusLine({ planningFocus: ON }, 20, wide.now)).length, 20);   // clipped to the width
  const chip = headerWarnings(stateOf(ON), wide.now.getTime()).find(w => w.id === 'planning-focus');
  assert.deepEqual([chip.chip, chip.operator], [true, true]);   // the operator's own: no notification
  assert.equal(headerWarnings(stateOf(null), wide.now.getTime()).some(w => w.id === 'planning-focus'), false);
});

test('AC2: the ? menu on the sprint screen lists P, saying what it does now', () => {
  const menu = s => render(handleKey(s, { name: 'question', sequence: '?' }, wide), wide).map(strip).join('\n');
  assert.match(menu(stateOf(null)), /P\s+focus on planning on/);
  assert.match(menu(stateOf(ON)), /P\s+focus on planning off/);
  assert.doesNotMatch(menu({ ...stateOf(null), screen: 'c' }), /focus on planning/);
});
