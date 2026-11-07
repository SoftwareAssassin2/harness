// ASS-263: the sprint flow (S) and backlog flow (B) floors scroll with ↑/↓,
// PgUp/PgDn, Home and End from the moment the screen opens, whatever has the
// focus. Every key goes through handleKey as main.js hands it a readline
// keypress, on a floor taller than its box with nested sub-flows open
// (ASS-245).
//
// AC1, why they stopped: S and B scrolled only while the floor itself held
// the focus (state.focus 'flowchart' / 'backlogflow'), a gate the flowchart
// has had since it first scrolled (6098f23). S never gave the floor the
// focus when it opened — ASS-103 (81d3264) put the floor on S without adding
// it to the screens that open on their own component, as B is — and the
// dashboard starts with the day focused (eb19f5a), so on S ↑/↓ did nothing
// until tab, and the unfocused hint ("tab to choose what each station
// shows") never said that tab was also what scrolling needed. B opened
// focused, but tab (to the day or project, the only way to change them on B)
// took scrolling away with nothing on screen saying so. Since ASS-245
// (e477547) g also changes the floor's length without touching its scroll:
// scrolled down with every sub-flow open, g closing them left the scroll past
// the shorter floor's end, so ↑ did nothing for as many presses as it had
// shrunk (a terminal grown taller did the same). The floor's height and
// length maths, its clipping and app.js's routing were otherwise sound: the
// same keys scroll both floors to their last line once the floor has the
// focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const size = { columns: 120, rows: 30, now: new Date('2026-10-01T16:04:00Z') };
// Keypresses as node:readline emits them (main.js hands them on as they come).
const KEYS = {
  up: { name: 'up', sequence: '\x1b[A' }, down: { name: 'down', sequence: '\x1b[B' },
  left: { name: 'left', sequence: '\x1b[D' }, right: { name: 'right', sequence: '\x1b[C' },
  pageup: { name: 'pageup', sequence: '\x1b[5~' }, pagedown: { name: 'pagedown', sequence: '\x1b[6~' },
  home: { name: 'home', sequence: '\x1b[H' }, end: { name: 'end', sequence: '\x1b[F' },
  tab: { name: 'tab', sequence: '\t' }, g: { name: 'g', sequence: 'g' },
  S: { name: 's', sequence: 'S', shift: true }, B: { name: 'b', sequence: 'B', shift: true },
};
const press = (s, names, at = size) => [names].flat().reduce((st, name) => handleKey(st, { ctrl: false, meta: false, shift: false, ...KEYS[name] }, at), s);

// The execution engine e: Build runs sub-engine sub, whose Check runs subsub —
// three levels. Its backlog-refinement-steps names r, the refinement engine,
// whose Refine runs rs.
const workflows = [
  { name: 'e', lists: { 'backlog-refinement-steps': [{ id: 'backlog-refinement', sequence: 1, name: 'Backlog Refinement', action: { type: 'state-engine', engine: 'r' } }] }, steps: [
    { id: 'backlog', name: 'Backlog', sequence: 1 },
    { id: 'build', name: 'Build', sequence: 2, action: { type: 'state-engine', engine: 'sub' } },
    { id: 'done', name: 'Done', sequence: 3, 'is-done': true },
  ] },
  { name: 'sub', steps: [
    { id: 'draft', name: 'Draft', sequence: 1, action: { type: 'prompt' } },
    { id: 'check', name: 'Check', sequence: 2, action: { type: 'state-engine', engine: 'subsub' } },
  ] },
  { name: 'subsub', steps: [{ id: 'inspect', name: 'Inspect', sequence: 1, action: { type: 'prompt' } }, { id: 'look', name: 'Look Again', sequence: 2, action: { type: 'prompt' } }] },
  { name: 'r', steps: [
    { id: 'groom', name: 'Groom', sequence: 1 },
    { id: 'refine', name: 'Refine', sequence: 2, action: { type: 'state-engine', engine: 'rs' } },
    { id: 'ready', name: 'Ready', sequence: 3 },
  ] },
  { name: 'rs', steps: [{ id: 'ask', name: 'Ask', sequence: 1, action: { type: 'prompt' } }, { id: 'answer', name: 'Answer', sequence: 2, action: { type: 'prompt' } }] },
];
// 40 sprint tickets three levels down, at Build › Check › Inspect; 40 backlog tickets at Refine › Ask.
const features = Array.from({ length: 40 }, (_, i) => ({
  key: `T-${i + 1}`, title: `Sprint ticket ${i + 1}`, priority: i + 1,
  variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e', 'sub-status': { state: 'check', 'state-engine': 'sub', 'sub-status': { state: 'inspect', 'state-engine': 'subsub' } } } }],
}));
const backlog = Array.from({ length: 40 }, (_, i) => ({
  key: `R-${i + 1}`, title: `Backlog ticket ${i + 1}`, priority: i + 1, 'manual-backlog-priority': null,
  variations: [{ name: 'A', 'harness-status': { state: 'refine', 'state-engine': 'r', 'sub-status': { state: 'ask', 'state-engine': 'rs' } } }],
}));
const project = { id: 'p', name: 'P', stateEngine: 'e', backlog, sprint: { number: 1, start: '2026-09-25', end: '2026-10-08', features, bugs: [], spikes: [] } };
// As main.js starts the dashboard: the project menu hidden, the day focused, on
// the sprint screen; S showing its tickets, as B does by default.
const started = (extra = {}) => ({ ...initialState({ projects: [project], workflows, menuHidden: true, ...extra }), flowchartView: 'tickets' });

// Each floor: its screen key and the state field holding its first line shown.
const FLOORS = [['S', 'flowchartScroll'], ['B', 'backlogFlowScroll']];

// The floor's box on screen: its body rows, borders cut off, and whether the
// scrollbar thumb sits on its first and last rows.
function box(s, at = size) {
  const out = render(s, at).map(strip);
  const top = out.findIndex(l => l.startsWith('┌'));
  const bottom = out.findIndex((l, i) => i > top && l.startsWith('└'));
  const rows = out.slice(top + 1, bottom);
  return { body: rows.map(l => l.slice(1, -1)), thumbTop: rows[0].at(-1) === '█', thumbBottom: rows.at(-1).at(-1) === '█', thumb: rows.some(l => l.at(-1) === '█'), out };
}

for (const [screen, field] of FLOORS) {
  test(`ASS-263 AC2/AC4: ${screen} opens with its floor taller than the box, nested sub-flows open, and ↑/↓ scroll it line by line at once — to the last line and back to the first`, () => {
    const opened = press(started(), screen);
    const first = box(opened);
    assert.ok(first.thumb && first.thumbTop && !first.thumbBottom, 'the floor is taller than its box');
    assert.ok(first.out.some(l => l.includes(screen === 'S' ? 'Inspect' : 'Ask')), 'a nested sub-flow is open');
    // Line by line: each ↓ moves every row up one.
    let at = opened, steps = 0;
    for (;;) {
      const next = press(at, 'down');
      if (next[field] === at[field]) break;
      assert.deepEqual(box(next).body.slice(0, -1).map(l => l.slice(0, -1)), box(at).body.slice(1).map(l => l.slice(0, -1)), `↓ ${steps + 1} moves the floor one line`);
      at = next;
      steps++;
    }
    assert.ok(steps > 10, `↓ scrolled ${steps} lines`);
    assert.ok(box(at).thumbBottom, 'the last line reached');
    assert.deepEqual(press(at, 'down'), at, 'no further than the last line');
    for (let i = 0; i < steps; i++) at = press(at, 'up');
    assert.equal(at[field], 0);
    assert.deepEqual(box(at).body, first.body, 'back to the first line');
    assert.deepEqual(press(at, 'up'), at, 'no further than the first line');
  });

  test(`ASS-263 AC2/AC4: ${screen} scrolls whatever has the focus — the day, the project menu or the floor`, () => {
    for (const focus of ['day', 'menu', screen === 'S' ? 'flowchart' : 'backlogflow']) {
      const opened = { ...press(started({ menuHidden: focus !== 'day' }), screen), focus };
      assert.equal(press(opened, ['down', 'down', 'down'])[field], 3, focus);
    }
    const tabbed = press(started(), [screen, 'tab', 'tab']);
    assert.equal(press(tabbed, 'down')[field], 1, 'after tab round to the day again');
  });

  test(`ASS-263 AC2/AC4: on ${screen} PgDn/PgUp move a box's height of lines, Home and End go to the first and last line`, () => {
    const opened = press(started(), [screen, 'g']);                       // every sub-flow open: more than a page taller than the box
    const shown = box(opened).body.length;
    const end = press(opened, 'end');
    assert.ok(end[field] > shown, `${end[field]} lines to scroll`);
    const page = press(opened, 'pagedown');
    assert.equal(page[field], shown);
    assert.equal(box(page).body[0], box(press(opened, Array(shown).fill('down'))).body[0]);
    assert.equal(press(page, 'pageup')[field], 0);
    assert.ok(box(end).thumbBottom, 'End shows the last line');
    assert.deepEqual(press(end, 'down'), end);
    assert.deepEqual(press(end, 'pagedown'), end, 'PgDn no further than the last line');
    assert.equal(press(end, 'home')[field], 0);
    assert.deepEqual(box(press(end, 'home')).body, box(opened).body);
    assert.deepEqual(press(opened, 'pageup'), opened, 'PgUp no further than the first line');
    // PgDn steps to the last line, never past it.
    let at = opened;
    for (let i = 0; i < 20; i++) at = press(at, 'pagedown');
    assert.equal(at[field], end[field]);
  });

  test(`ASS-263 AC2: on ${screen} the scroll stays in bounds when g closes or opens sub-flows, or the terminal grows or shrinks — the next ↑ moves the floor one line on screen`, () => {
    const opened = press(started(), screen);
    const expanded = screen === 'S' ? 'flowchartExpanded' : 'backlogFlowExpanded';
    // g opens every sub-flow: a taller floor; at its end, g closes the empty ones again: a shorter one.
    const open = press(opened, ['g', 'end']);
    assert.ok(open[expanded]);
    const closed = press(open, 'g');
    const furthest = press({ ...closed, [field]: 0 }, 'end')[field];
    assert.ok(closed[field] <= furthest, `g keeps the scroll within the shorter floor (${closed[field]} of ${furthest})`);
    const up = press(closed, 'up');
    assert.deepEqual(box(up).body.slice(1).map(l => l.slice(0, -1)), box(closed).body.slice(0, -1).map(l => l.slice(0, -1)), 'after g, ↑ moves the floor one line');
    // The terminal grows: the scroll at the end of a short screen is past the end of a tall one.
    const short = { ...size, rows: 24 }, taller = { ...size, rows: 34 };
    const end = press(press(started(), screen, short), 'end', short);
    const grown = press(end, 'up', taller);
    assert.deepEqual(box(grown, taller).body.slice(1).map(l => l.slice(0, -1)), box(end, taller).body.slice(0, -1).map(l => l.slice(0, -1)), 'after a resize, ↑ moves the floor one line');
  });

  test(`ASS-263 AC3: ${screen}'s hint line says how to scroll from the moment it opens, focused or not`, () => {
    const opened = press(started(), screen);
    for (const s of [opened, { ...opened, focus: screen === 'S' ? 'flowchart' : 'backlogflow' }]) {
      const hint = box(s).out.find(l => l.includes('each station shows'));
      assert.ok(hint, 'the hint line');
      for (const words of ['↑/↓ scroll', 'PgUp/PgDn', 'Home/End']) assert.ok(hint.includes(words), `${s.focus}: ${hint}`);
    }
  });
}

test('ASS-263: ←/→ still choose what each station shows only while the floor has the focus; on the day they still change the day', () => {
  const opened = press(started(), 'S');
  assert.equal(opened.focus, 'day');
  assert.equal(press(opened, 'right').flowchartView, opened.flowchartView);
  assert.notEqual(press(opened, ['tab', 'right']).flowchartView, opened.flowchartView);
  assert.equal(press(started(), ['B', 'right']).backlogFlowView, 'metrics');
});
