// ASS-566 (was ASS-525's footer "queue" box): the seat queue is an overlay on the sprint screen — q opens it over the
// screen, as ? draws its menu, and q or Esc closes it. It lists the ticket variations control will give a seat to, from
// control's seat-queue.json (project.seatQueue), one per line as "<n> <key>[ <variation>] <title…> <waits>", as many as
// the screen has room for then a gray "+N more", a gray "empty" with nobody waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render, handleKey } from '../../src/tui/app.js';
import { platform } from '../../src/tui/screens/frame.js';
import { queueLines, QUEUE_KEY } from '../../src/tui/screens/queue.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const screen = { columns: 120, rows: 40, now: new Date('2026-11-17T16:04:00Z') };
const sprint = { number: 1, start: '2026-11-04', end: '2026-11-17', features: [], bugs: [], spikes: [] };
const q = (key, waits = 'build', extra = {}) => ({ key, variation: 'A', title: `Queue overlay on the sprint screen for ${key}`, waits, ...extra });
const project = (seatQueue, extra = {}) => ({
  id: 'p', name: 'P', environments: [], stateEngine: 'e', sprint, seats: [], vms: {}, workstations: {},
  devEnvironments: { mode: 'vm', workstations: [] }, seatBudget: { seats: 2 }, limits: { project: {}, harness: {} }, seatQueue, ...extra,
});
const stateOf = p => initialState({ projects: [p], workflows: [{ name: 'e', steps: [] }], assignments: [], controls: { p: { pid: 1, startTime: '2026-11-17T15:51:00Z' } }, menuHidden: true });
const press = (s, sequence, name = sequence) => handleKey(s, { sequence, name }, screen);
const opened = s => press(s, 'q');
// The overlay's lines: from its title's row to its bottom border, each "│ text │" as its text.
const overlay = (s, size = screen) => {
  const out = render(s, size).map(strip), i = out.findIndex(l => l.includes('│ seat queue'));
  if (i < 0) return null;
  const from = out[i].indexOf('│ seat queue'), end = out.findIndex((l, n) => n > i && l[from] === '└');
  return out.slice(i, end).map(l => l.slice(from).replace(/^│ (.*?) *│.*$/, '$1')).filter(Boolean);
};

test('ASS-566 AC4: q on the sprint screen opens the queue overlay over the screen; q or Esc closes it', () => {
  const s = stateOf(project([q('ASS-1')]));
  assert.equal(QUEUE_KEY, 'q');
  assert.equal(overlay(s), null, 'closed at first');
  const open = opened(s);
  assert.equal(open.queueOpen, true);
  const out = render(open, screen);
  assert.equal(out.length, screen.rows, 'drawn over the screen, which keeps its size');
  assert.ok(out.every(l => visible(l) <= screen.columns));
  assert.match(strip(out.at(-1)), /press \? for menu/, 'the screen shows round it');
  assert.ok(strip(out.join('\n')).includes('local: healthy'), 'the footer still shows under it');
  assert.equal(press(open, 'q').queueOpen, false, 'q closes it');
  assert.equal(handleKey(open, { name: 'escape', sequence: '\x1b' }, screen).queueOpen, false, 'Esc closes it');
  assert.equal(press(open, 'b').screen, 's', 'any other key does nothing while it is open');
  assert.equal(press(open, 'b').queueOpen, true);
});

test('ASS-566 AC4: q opens it only on the sprint screen, not on another screen or a ticket\'s screen', () => {
  const s = stateOf(project([q('ASS-1')]));
  assert.notEqual(press({ ...s, screen: 'b' }, 'q').queueOpen, true);
  assert.notEqual(press({ ...s, screen: 'n' }, 'q').queueOpen, true);
});

test('ASS-566 AC4: the ? menu and the sprint screen\'s key line mention q', () => {
  const s = stateOf(project([]));
  const menu = strip(render(press(s, '?'), screen).join('\n'));
  assert.match(menu, /q +seat queue/);
  assert.ok(strip(render(s, screen).join('\n')).includes('q seat queue'), 'the key under the grid');
  // q from the open menu closes it and opens the queue.
  assert.equal(press(press(s, '?'), 'q').queueOpen, true);
});

test('ASS-566 AC4 (ASS-525 AC2, AC3): one line per variation in control\'s order — position, key (variation when not A), title, and what it waits for in gray', () => {
  const s = opened(stateOf(project([q('ASS-512', 'build'), q('ASS-7', 'planning', { variation: 'B' }), q('ASS-9', 'memory'), q('ASS-10', 'planning', { full: true })])));
  assert.deepEqual(overlay(s).slice(1), [
    '1 ASS-512 Queue overlay on the sprint screen for ASS-512 build',
    '2 ASS-7 B Queue overlay on the sprint screen for ASS-7 plan',
    '3 ASS-9 Queue overlay on the sprint screen for ASS-9 memory',
    '4 ASS-10 Queue overlay on the sprint screen for ASS-10 plan, full',
  ]);
  const raw = render(s, screen).join('\n');
  assert.ok(raw.includes('\x1b[90mbuild\x1b[0m') && raw.includes('\x1b[90mmemory\x1b[0m') && raw.includes('\x1b[90mplan, full\x1b[0m'), raw);
  const reversed = opened(stateOf(project([q('Z-2'), q('A-1')])));
  assert.deepEqual(overlay(reversed).slice(1).map(l => l.split(' ').slice(0, 2).join(' ')), ['1 Z-2', '2 A-1'], 'control\'s order, no re-sorting');
});

test('ASS-566 AC4: more than 5 rows when there is room; past the room, a gray "+N more"', () => {
  const long = Array.from({ length: 12 }, (_, i) => q(`T-${i + 1}`));
  assert.equal(overlay(opened(stateOf(project(long)))).slice(1).length, 12, 'all 12 on a 40-row screen');
  const short = overlay(opened(stateOf(project(long))), { ...screen, rows: 14 }).slice(1);
  assert.equal(short.length, 7);
  assert.deepEqual(short.slice(0, 6).map(l => l.split(' ')[1]), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6']);
  assert.equal(short.at(-1), '+6 more');
  assert.ok(queueLines(project(long), 3).at(-1).includes('\x1b[90m+10 more'));
});

test('ASS-566 AC4: nobody waiting (no file, or an empty queue) — it says a gray "empty"; no active sprint, it says so', () => {
  for (const seatQueue of [[], undefined]) {
    const s = opened(stateOf(project(seatQueue)));
    assert.deepEqual(overlay(s).slice(1), ['empty']);
    assert.ok(render(s, screen).join('\n').includes('\x1b[90mempty\x1b[0m'));
  }
  assert.deepEqual(queueLines({ id: 'p', sprint: null }).map(strip), ['no active sprint']);
});

test('ASS-566 AC1: the footer has no queue box any more', () => {
  const out = platform(stateOf(project([q('ASS-1')])), screen.columns, screen.now).map(strip).join('\n');
  assert.ok(!out.includes('queue') && !out.includes('│'), out);
});
