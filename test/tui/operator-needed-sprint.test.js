// Operator Needed Tickets counts only the sprint on show (ASS-254): a backlog
// ticket never counts, whatever its marks or questions, though it keeps its
// red ● or grey ● on the backlog screen; a sprint ticket waiting on the
// operator counts, once, even when it is in the backlog too; and with a past
// day on show, that day's sprint is the one counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialState, handleKey, render } from '../../src/tui/app.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 44, now: new Date('2026-10-01T16:04:00Z') };
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const refinement = { name: 'r', steps: [{ id: 'groom', name: 'Groom', sequence: 1, action: { type: 'prompt' } }, { id: 'ready', name: 'Ready', sequence: 2, 'is-done': true, action: { type: 'none' } }] };
const ticket = (key, state) => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': hs(state) }] });
const groomed = key => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'r' } }] });
const busy = ticket('A-0', 'build');                                                  // worked, so no warning takes the tiles' room (ASS-59)
const asked = (key, blocking) => ({ 'asked-on-ticket': key.toLowerCase(), status: 'Asked', ...(blocking == null ? {} : { blocking }) });
const RED = '\x1b[31m●', GREY = '\x1b[2;90m●';
const sprintOf = features => ({ number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] });

// The tile's count and the tickets wearing each ● on the backlog screen.
function shown(features, { backlog = [], questions = [], days = {}, day = null } = {}) {
  const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf(features), backlog, questions, days };
  const s = { ...initialState({ projects: [project], workflows: [{ name: 'e', steps }, refinement], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] }), day };
  const out = render(s, wide);
  const raw = render(handleKey(s, { name: 'b' }), wide);
  const marked = dot => [...new Set(raw.filter(l => l.includes(dot)).map(l => strip(l).match(/● (A-\d+)/)?.[1]).filter(Boolean))].sort();
  const tile = strip(out[7]).match(/│ +(\d+) +│/);
  return { n: Number(tile[1]), red: marked(RED), grey: marked(GREY) };
}

test('AC1, AC4: a backlog ticket with an open blocking question is not counted, and keeps its red ●', () => {
  const r = shown([busy], { backlog: [groomed('A-5')], questions: [asked('A-5', true)] });
  assert.deepEqual([r.n, r.red], [0, ['A-5']]);
});

test('AC1, AC2: backlog tickets waiting on the operator in other ways (blocked, non-blocking question) are not counted, and keep their marks', () => {
  const stuck = { key: 'A-6', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'stuck', 'state-engine': 'e' } }] };
  const r = shown([busy], { backlog: [stuck, groomed('A-7')], questions: [asked('A-7', false)] });
  assert.deepEqual([r.n, r.red, r.grey], [0, ['A-6'], ['A-7']]);
});

test('AC1, AC4: a sprint ticket with an open blocking question is counted, beside backlog ones that are not', () => {
  const r = shown([busy, ticket('A-1', 'build')], { backlog: [groomed('A-5'), groomed('A-8')], questions: [asked('A-1', true), asked('A-5', true), asked('A-8')] });
  assert.equal(r.n, 1);
});

test('AC1, AC4: a ticket in both the sprint and the backlog is counted once', () => {
  const r = shown([busy, ticket('A-1', 'build')], { backlog: [groomed('A-1')], questions: [asked('A-1', true)] });
  assert.equal(r.n, 1);
});

test('AC1: with a past day on show, that day\'s sprint is counted — not the live sprint\'s, never the backlog\'s', () => {
  const days = { '2026-09-30': sprintOf([busy, ticket('A-2', 'build')]) };
  const r = shown([busy, ticket('A-1', 'build')], { backlog: [groomed('A-5')], questions: [asked('A-1', true), asked('A-2', true), asked('A-5', true)], days, day: '2026-09-30' });
  assert.equal(r.n, 1);
});

// ASS-370: the project menu's red ● before each project with Operator Needed tickets.
test('ASS-370 AC1-AC3: the menu dots each project with tickets waiting on the operator, the selected one agreeing with its tile, a past day changing nothing', () => {
  const project = (id, features, questions = [], days = {}) => ({ id, name: id.toUpperCase(), stateEngine: 'e', sprint: sprintOf(features), backlog: [], questions, days });
  const days = { '2026-09-30': sprintOf([busy]) };
  const projects = [project('p', [busy, ticket('A-1', 'build')], [asked('A-1', true)], days), project('q', [busy]), project('r', [busy, ticket('A-3', 'stuck')])];
  const s = initialState({ projects, workflows: [{ name: 'e', steps }, refinement], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
  const out = render(s, wide);
  const names = out[2], counts = out[3];
  assert.match(names, /\x1b\[31m●\x1b\[0m(\x1b\[7m)? P /);             // the highlight put back after the dot (ASS-438)
  assert.match(strip(names), /● P\s+Q\s+● R/);
  assert.ok(!strip(names).includes('● Q'));
  assert.equal(Number(strip(out[7]).match(/│ +(\d+) +│/)[1]), 1);            // the selected project's tile agrees
  const centre = (line, text) => { const v = strip(line); return v.indexOf(text) + text.length / 2; };
  assert.equal(Math.floor(centre(names, '● P')), Math.floor(centre(counts, '🤖x1')));
  assert.equal(render({ ...s, day: '2026-09-30' }, wide)[2], names);           // a past day leaves the dots alone
});

// ASS-430 AC3: the tile, while its count is above 0, filled with the red the
// Blocked for Human state is drawn in — that state's own color in the viewed
// project's execution state engine, as a 24-bit background — else plain red.
test('ASS-430 AC3: Operator Needed Tickets above 0 is filled with the engine\'s Blocked for Human color, read from the engine; plain red without one; unfilled at 0', () => {
  const tileLine = (engineSteps, features) => {
    const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf(features), backlog: [] };
    return render(initialState({ projects: [project], workflows: [{ name: 'e', steps: engineSteps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] }), wide)[7];
  };
  const human = color => ({ id: 'blocked-for-human', name: 'Blocked for Human', sequence: 0, area: 'quarantine', 'is-blocked-state': true, ...(color ? { color } : {}) });
  const fill = line => line.match(/│\x1b\[([0-9;]+)m +\d+ +\x1b\[0m│/)?.[1];
  const blocked = [busy, { key: 'A-1', title: 'T', variations: [{ name: 'A', 'harness-status': hs('blocked-for-human') }] }];
  assert.equal(fill(tileLine([human('#ff0000'), ...steps.slice(1)], blocked)), '48;2;255;0;0;97');   // white on the state's red
  assert.equal(fill(tileLine([human('#c03030'), ...steps.slice(1)], blocked)), '48;2;192;48;48;97');   // whatever the engine says, not a copy
  assert.equal(fill(tileLine([human('#ffcccc'), ...steps.slice(1)], blocked)), '48;2;255;204;204;30');   // a light one: black text, readable
  assert.equal(fill(tileLine([human(null), ...steps.slice(1)], blocked)), '41;97');                    // the state without a color: plain red
  assert.equal(fill(tileLine(steps, [busy, ticket('A-1', 'stuck')])), '41;97');                         // no Blocked for Human state: plain red
  const zero = tileLine([human('#ff0000'), ...steps.slice(1)], [busy]);
  assert.match(strip(zero), /│ +0 +│/);
  assert.equal(fill(zero), undefined);                                                                  // 0: unfilled
  // The harness's own engine: its Blocked for Human's color, whatever it is.
  const engine = JSON.parse(readFileSync(new URL('../../engines/harness-development-grouped/state-engine.json', import.meta.url), 'utf8'));
  const color = engine.steps.find(s => s.name === 'Blocked for Human').color;
  const real = render(initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf(blocked), backlog: [] }], workflows: [{ ...engine, name: 'e' }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] }), wide)[7];
  assert.ok(fill(real)?.startsWith(`48;2;${[1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)).join(';')};`), JSON.stringify(real));
});

// ASS-438: the menu's dot is the needs-you red, from markDot's one definition,
// and the selected project's highlight — reverse video with the menu focused,
// an underline otherwise — covers its whole label, dot and name, the dot red
// in it. Each visible cell of the names line read with the highlight and the
// foreground in force where it is drawn.
const cells = (line, mark) => {
  let on = false, fg = null;
  const out = [];
  for (const [, code, ch] of line.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/gu)) {
    if (code === '0') { on = false; fg = null; } else if (code === mark) on = true; else if (code != null) fg = code;
    if (ch != null) out.push({ ch, on, fg });
  }
  return out;
};
const lit = (line, mark) => { const c = cells(line, mark); const first = c.findIndex(x => x.on), last = c.findLastIndex(x => x.on); return { text: c.filter(x => x.on).map(x => x.ch).join(''), whole: c.slice(first, last + 1).every(x => x.on), dot: c.find(x => x.ch === '●' && x.on) }; };
test('ASS-438 AC1-AC4: the dot is markDot\'s needs-you red, and the selected project is highlighted across its whole label, with a dot or without, focused or not', async () => {
  const { markDot } = await import('../../src/tui/screens/shared.js');
  assert.equal(markDot('●', 'needed'), '\x1b[31m●\x1b[0m');                     // ASS-430's red, the one definition
  const project = (id, features, questions = []) => ({ id, name: id.toUpperCase(), stateEngine: 'e', sprint: sprintOf(features), backlog: [], questions, days: {} });
  const projects = [project('p', [busy, ticket('A-1', 'build')], [asked('A-1', true)]), project('q', [busy]), project('r', [busy, ticket('A-3', 'stuck')])];
  const s = initialState({ projects, workflows: [{ name: 'e', steps }, refinement], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
  for (const [focus, mark] of [['menu', '7'], ['day', '4']]) {
    for (const [i, label] of [[0, ' ● P '], [1, ' Q  ']]) {
      const out = render({ ...s, project: i, focus }, wide);
      const hl = lit(out[2], mark);
      assert.equal(hl.text, label, `${focus} ${label}`);                          // the whole label, padding, dot and name
      assert.ok(hl.whole, `${focus} ${label}`);                                     // unbroken
      if (i === 0) assert.equal(hl.dot.fg, '31');                                   // the dot red inside the highlight
      assert.ok(out[2].includes(markDot('●', 'needed')));                           // R's dot (and P's) drawn by markDot
      // Unselected projects as before; the counts centred under the names.
      if (i === 1) assert.ok(out[2].includes(` ${markDot('●', 'needed')} P `));        // P unselected: plain, its dot red
      assert.ok(out[2].endsWith(`   ${markDot('●', 'needed')} R `));                  // R never selected: as before
      const centre = (line, text) => { const v = strip(line); return v.indexOf(text) + text.length / 2; };
      assert.equal(Math.floor(centre(out[2], '● P')), Math.floor(centre(out[3], '🤖x1')));
    }
  }
  // With no dots the menu is unchanged: the mark, the label, one reset.
  const calm = initialState({ projects: [project('p', [busy]), project('q', [busy])], workflows: [{ name: 'e', steps }, refinement], assignments: [] });
  assert.ok(render(calm, wide)[2].includes('\x1b[7m P  \x1b[0m   Q  '));
  assert.ok(render({ ...calm, focus: 'day' }, wide)[2].includes('\x1b[4m P  \x1b[0m   Q  '));
});
