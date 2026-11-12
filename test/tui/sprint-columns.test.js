// The sprint screen's ticket rows lay their icons out in one-cell columns
// (ASS-259): c1 ▮ the step color, c2 the type (✦ feature, ✘ bug, ⌕ spike), c3 ☛
// worked by hand, c4 ↯ fast-tracked, c5 one ⦿ (red: a requirements change waits;
// else blue: needs the operator; else dim grey: going on with an assumption), c6
// ⚉ an agent working on that row's ticket and variation — each a blank when it
// doesn't apply — then c7, two cells, 💺 for a variation holding a planning or
// in-progress seat by the planner (ASS-357), two blanks without — then a blank
// and the text, so the text starts on the same
// terminal column on every row. A paused variation's text starts "PAUSED " in
// blue, "UNASSIGNED " in red for a ticket reassigned away from the operator
// (ASS-345); one its dependencies hold (ASS-355) gets a second line, "↳ WAITING
// ON <KEY>" in gold, the ↳ under the key (ASS-360); no 📝 or ⏸️. Every glyph is East Asian Width N with no Emoji property. A
// key in dim text under the grid says what each means.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { visible } from '../../src/tui/text.js';
import { GLYPHS } from '../../src/tui/screens/shared.js';
import { seatsOf } from '../../src/control/plan.js';
import { waitingWho } from '../../src/tui/screens/sprint.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 80, now: new Date('2026-10-01T16:04:00Z') };
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const HAND = { by: 'alice', since: '2026-10-27T10:05:00Z' };
const CHANGE = { description: 'New requirements', 'detected-at': '2026-10-25T12:00:00Z', 'paused-variations': [] };
// A ticket at `state` (none: no step), one variation A unless `variations` names more.
const ticket = (key, title, { state = 'build', variations = ['A'], paused = false, ...extra } = {}) => ({
  key, title, ...extra,
  variations: variations.map(name => ({ name, ...(state ? { 'harness-status': hs(state) } : {}), ...(paused ? { 'is-paused': true } : {}) })),
});
// Every combination that matters: none, all, each alone, paused, no step; a
// bug and a spike for their glyphs; two variations, an agent on one.
const features = [
  ticket('A-1', 'None'),
  ticket('A-2', 'All', { 'worked-manually': HAND, 'fast-track': true, 'pending-requirements-change': CHANGE, paused: true }),
  ticket('A-3', 'Worked by hand', { 'worked-manually': HAND }),
  ticket('A-4', 'Fast-tracked', { 'fast-track': true }),
  ticket('A-5', 'Requirements change', { 'pending-requirements-change': CHANGE }),
  ticket('A-6', 'Needs the operator', { state: 'stuck' }),
  ticket('A-7', 'Assumption'),
  ticket('A-8', 'Agent working'),
  ticket('A-9', 'Paused', { paused: true }),
  ticket('A-10', 'No step', { state: null }),
  ticket('A-13', 'Two ways', { variations: ['A', 'B'] }),
];
const bugs = [ticket('A-11', 'A bug')];
const spikes = [ticket('A-12', 'A spike')];
const questions = [{ 'asked-on-ticket': 'a-7', status: 'Asked', blocking: false }];
const assignments = ['A-2', 'A-8'].map(item => ({ project: 'p', 'agent-name': 'Daredevil', 'work-item': item, variation: null }))
  .concat({ project: 'p', 'agent-name': 'Elektra', 'work-item': 'A-13', variation: 'B' });
const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs, spikes }, questions };
const state = initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments });
const raw = render(state, wide);
const out = raw.map(strip);
// The grid's row for `key` (A-13.A, A-13.B for its variations), raw or stripped.
const rowOf = (key, lines = out) => lines.find(l => new RegExp(`(^|\\s)${key.replace('.', '\\.')}: `).test(strip(l)));
// The Ticket cell after the grid's left border and its padding, and its first TEXT cells: the icon columns.
// TEXT counts UTF-16 units: the six one-cell glyphs, the seat (💺, two units and two cells, or two blanks), a blank.
const cell = key => rowOf(key).slice(2);
const TEXT = 9;
const SEAT = '💺';
const prefix = key => cell(key).slice(0, TEXT);
// What the text starts with on each row: PAUSED for a paused variation, else the key.
const textOf = key => (['A-2', 'A-9'].includes(key) ? 'PAUSED ' : `${key}: `);
const KEYS = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9', 'A-10', 'A-11', 'A-12', 'A-13.A', 'A-13.B'];
// The key under the grid: the lines right after its bottom border that start with a key entry.
const keyLines = lines => {
  const after = lines.slice(lines.findLastIndex(l => /^└/.test(strip(l))) + 1);
  const end = after.findIndex(l => !/^([▮✦✘⌕☛↯⦿⚉]|💺|PAUSED|UNASSIGNED|AWAITING|AWAITING MERGE) /u.test(strip(l)));
  return end < 0 ? after : after.slice(0, end);
};

test('ASS-259 AC8: a plain-text render of the sprint screen, every combination, and the key under it', t => {
  const top = out.findIndex(l => /^┌.*┬/.test(l));
  const bottom = out.findLastIndex(l => /^└/.test(l));
  const grid = out.slice(top, bottom + 1).filter(l => !/^│( +| +(- +)+)│$/.test(l));
  t.diagnostic(`\n${[...grid, ...keyLines(out).map(strip)].join('\n')}`);
  assert.equal(KEYS.filter(k => rowOf(k)).length, KEYS.length);
});

test('ASS-259 AC1, AC8: the ticket text starts on the same terminal column on every row, whatever the row shows', () => {
  const columns = KEYS.map(k => visible(cell(k).slice(0, cell(k).indexOf(textOf(k)))));
  assert.deepEqual(columns, KEYS.map(() => TEXT), JSON.stringify(Object.fromEntries(KEYS.map((k, i) => [k, columns[i]]))));
  for (const key of KEYS) assert.equal(cell(key)[TEXT - 1], ' ', key);   // a blank before the text
});

test('ASS-259 AC1: c1 ▮ step, c2 type, c3 ☛, c4 ↯, c5 ⦿, c6 ⚉ — each one cell, a blank when it does not apply', () => {
  // Then c7 (ASS-357): 💺 where the planner seats the variation — no limits here, so every one in
  // motion — two blanks for paused (A-2, A-9), worked by hand (A-3), blocked (A-6) and no step (A-10).
  const expect = {
    'A-1': `▮✦    ${SEAT}`,
    'A-2': '▮✦☛↯⦿⚉  ',
    'A-3': '▮✦☛     ',
    'A-4': `▮✦ ↯  ${SEAT}`,
    'A-5': `▮✦  ⦿ ${SEAT}`,
    'A-6': '▮✦  ⦿   ',
    'A-7': `▮✦  ⦿ ${SEAT}`,
    'A-8': `▮✦   ⚉${SEAT}`,
    'A-9': '▮✦      ',
    'A-10': ' ✦      ',
    'A-11': `▮✘    ${SEAT}`,
    'A-12': `▮⌕    ${SEAT}`,
    'A-13.A': `▮✦    ${SEAT}`,
    'A-13.B': `▮✦   ⚉${SEAT}`,
  };
  for (const key of KEYS) assert.equal(prefix(key), `${expect[key]} `, key);
  assert.ok(rowOf('A-1', raw).includes('m▮\x1b[0m'));                // ▮ in the step's color
});

// The code points of U+2000–U+2BFF whose East Asian Width is not N (A, W, Na or H),
// from the UCD 16.0 EastAsianWidth.txt; every row glyph lies in that span.
const NOT_N = (
  '2010:A 2013-2016:A 2018-2019:A 201C-201D:A 2020-2022:A 2024-2027:A 2030:A 2032-2033:A 2035:A 203B:A 203E:A ' +
  '2074:A 207F:A 2081-2084:A 20A9:H 20AC:A 2103:A 2105:A 2109:A 2113:A 2116:A 2121-2122:A 2126:A 212B:A ' +
  '2153-2154:A 215B-215E:A 2160-216B:A 2170-2179:A 2189:A 2190-2199:A 21B8-21B9:A 21D2:A 21D4:A 21E7:A 2200:A ' +
  '2202-2203:A 2207-2208:A 220B:A 220F:A 2211:A 2215:A 221A:A 221D-2220:A 2223:A 2225:A 2227-222C:A 222E:A ' +
  '2234-2237:A 223C-223D:A 2248:A 224C:A 2252:A 2260-2261:A 2264-2267:A 226A-226B:A 226E-226F:A 2282-2283:A ' +
  '2286-2287:A 2295:A 2299:A 22A5:A 22BF:A 2312:A 231A-231B:W 2329-232A:W 23E9-23EC:W 23F0:W 23F3:W 2460-24E9:A ' +
  '24EB-254B:A 2550-2573:A 2580-258F:A 2592-2595:A 25A0-25A1:A 25A3-25A9:A 25B2-25B3:A 25B6-25B7:A 25BC-25BD:A ' +
  '25C0-25C1:A 25C6-25C8:A 25CB:A 25CE-25D1:A 25E2-25E5:A 25EF:A 25FD-25FE:W 2605-2606:A 2609:A 260E-260F:A ' +
  '2614-2615:W 261C:A 261E:A 2630-2637:W 2640:A 2642:A 2648-2653:W 2660-2661:A 2663-2665:A 2667-266A:A ' +
  '266C-266D:A 266F:A 267F:W 268A-268F:W 2693:W 269E-269F:A 26A1:W 26AA-26AB:W 26BD-26BE:W 26BF:A 26C4-26C5:W ' +
  '26C6-26CD:A 26CE:W 26CF-26D3:A 26D4:W 26D5-26E1:A 26E3:A 26E8-26E9:A 26EA:W 26EB-26F1:A 26F2-26F3:W 26F4:A ' +
  '26F5:W 26F6-26F9:A 26FA:W 26FB-26FC:A 26FD:W 26FE-26FF:A 2705:W 270A-270B:W 2728:W 273D:A 274C:W 274E:W ' +
  '2753-2755:W 2757:W 2776-277F:A 2795-2797:W 27B0:W 27BF:W 27E6-27ED:Na 2985-2986:Na 2B1B-2B1C:W 2B50:W 2B55:W ' +
  '2B56-2B59:A'
).trim().split(' ').map(r => r.split(':')[0].split('-').map(h => parseInt(h, 16)));
const eastAsianN = glyph => {
  const cp = glyph.codePointAt(0);
  return cp >= 0x2000 && cp <= 0x2bff && !NOT_N.some(([lo, hi = lo]) => cp >= lo && cp <= hi);
};

test('ASS-259 AC2: every prefix glyph is East Asian Width N with no Emoji property, one code point, one cell', () => {
  assert.deepEqual(Object.values(GLYPHS).sort(), [...'▮✦✘⌕☛↯⦿⚉'].sort());
  for (const glyph of Object.values(GLYPHS)) {
    assert.equal([...glyph].length, 1, glyph);
    assert.ok(eastAsianN(glyph), `${glyph} East Asian Width N`);
    assert.ok(!/\p{Emoji}/u.test(glyph) && !/\p{Extended_Pictographic}/u.test(glyph), `${glyph} no Emoji property`);
    assert.equal(visible(glyph), 1, glyph);
  }
  assert.ok(!eastAsianN('●') && !eastAsianN('█') && !eastAsianN('✨') && !eastAsianN('⚡'));   // the old glyphs: A, A, W, W
  // Nothing else in any row's six glyph columns: GLYPHS or blanks, no VS16; then the seat column, 💺 or two blanks (ASS-357).
  for (const key of KEYS) assert.ok([...prefix(key).slice(0, 6)].every(c => c === ' ' || Object.values(GLYPHS).includes(c)), key);
  for (const key of KEYS) assert.ok([SEAT, '  '].includes(prefix(key).slice(6, 8)), key);
});

test('ASS-259 AC3: c5 is red for a requirements change waiting, else blue for one needing the operator, else dim grey for an assumption; no 📝; the count is unchanged', () => {
  const dot = key => rowOf(key, raw).match(/\x1b\[([0-9;]+)m⦿/)?.[1];
  assert.equal(dot('A-5'), '31');                                    // a requirements change: red, though it is at a human gate too
  assert.equal(dot('A-2'), '31');                                    // red even paused and worked by hand
  assert.equal(dot('A-6'), '34');                                    // blocked: blue
  assert.equal(dot('A-7'), '2;90');                                  // a non-blocking question: dim grey
  for (const key of ['A-1', 'A-3', 'A-4', 'A-8', 'A-9', 'A-10']) assert.equal(dot(key), undefined, key);
  assert.ok(!out.some(l => l.includes('📝')));
  assert.equal(Number(strip(out[7]).match(/│ +(\d+) +│/)[1]), 2);   // A-5 and A-6, as before (ASS-242/248/254)
});

test('ASS-259 AC4: ⚉ only on the rows of the ticket and variation an agent is working on, and on no past day', () => {
  assert.deepEqual(KEYS.filter(k => prefix(k).includes('⚉')), ['A-2', 'A-8', 'A-13.B']);
  const past = { ...state, day: '2026-09-30', projects: [{ ...project, days: { '2026-09-30': project.sprint } }] };
  assert.ok(!render(past, wide).map(strip).some(l => /A-\d+: /.test(l) && l.slice(2, 2 + TEXT).includes('⚉')));
});

test('ASS-259 AC5: a paused variation shows no ⏸️; its text starts "PAUSED " in blue, then the key and title', () => {
  assert.ok(!out.some(l => l.includes('⏸️')));
  for (const key of ['A-2', 'A-9']) {
    assert.ok(cell(key).slice(TEXT).startsWith(`PAUSED ${key}: `), key);
    assert.ok(rowOf(key, raw).includes('\x1b[34mPAUSED\x1b[0m '), key);
  }
  assert.ok(!['A-1', 'A-3', 'A-8'].some(k => cell(k).includes('PAUSED')));
});

test('ASS-259 AC6: the ? menu explains ⦿ in its three colors, ⚉ and the type, hand and fast-track glyphs', () => {
  const menu = render(handleKey(state, { sequence: '?' }, wide), wide);
  const line = text => menu.find(l => strip(l).includes(text)) ?? '';
  assert.ok(line('needs you').includes('\x1b[34m⦿'), 'blue ⦿');
  assert.ok(line('assumption').includes('\x1b[2;90m⦿'), 'grey ⦿');
  assert.ok(line('requirements change').includes('\x1b[31m⦿'), 'red ⦿');
  assert.match(strip(line('agent is working')), /⚉ an agent is working on it/);
  assert.match(strip(line('feature')), /✦ feature +✘ bug +⌕ spike +☛ worked by hand +↯ fast-tracked/);
});

test('ASS-259 AC7: a dim key directly under the grid shows each glyph as drawn in the rows, with its meaning, and PAUSED', () => {
  const bottom = raw.findLastIndex(l => /^└/.test(strip(l)));
  const key = keyLines(raw);
  assert.equal(raw.indexOf(key[0]), bottom + 1);                     // directly under the grid
  assert.equal(strip(key.join('  ')), '▮ step  ✦ feature  ✘ bug  ⌕ spike  ☛ by hand  ↯ fast-tracked  ⦿ requirements change  ⦿ needs you  ⦿ assumption  ⚉ agent working  💺 holds a seat (planning or in progress)  PAUSED paused  UNASSIGNED reassigned away  AWAITING a dependency not done yet  AWAITING MERGE MRs to merge, in order');
  const all = key.join('');
  for (const kind of ['31', '34', '2;90']) assert.ok(all.includes(`\x1b[${kind}m⦿\x1b[0m`), kind);   // ⦿ in each of its colors
  assert.ok(all.includes('\x1b[34mPAUSED\x1b[0m'));
  assert.ok(all.includes('\x1b[2m requirements change\x1b[0m') && all.includes('\x1b[2m▮\x1b[0m'));   // dim
});

test('ASS-259 AC7: the key wraps between entries at the screen width, never inside one, and is never cut off — the grid gives up rows', () => {
  const ENTRIES = ['▮ step', '✦ feature', '✘ bug', '⌕ spike', '☛ by hand', '↯ fast-tracked', '⦿ requirements change', '⦿ needs you', '⦿ assumption', '⚉ agent working', '💺 holds a seat (planning or in progress)', 'PAUSED paused', 'UNASSIGNED reassigned away', 'AWAITING a dependency not done yet', 'AWAITING MERGE MRs to merge, in order'];
  assert.equal(Math.max(...ENTRIES.map(visible)), 41);   // the seat's entry (ASS-357), the widest: no narrower screen holds it whole
  for (const columns of [200, 100, 60, 41]) {
    const size = { ...wide, columns, rows: 40 };
    const lines = render(state, size);
    const key = keyLines(lines).map(strip);
    assert.ok(key.length >= 1, String(columns));
    assert.ok(key.every(l => visible(l) <= columns), String(columns));
    assert.deepEqual(key.flatMap(l => l.split('  ')), ENTRIES, String(columns));   // each entry whole, in order
    if (columns < 200) assert.ok(key.length > 1, String(columns));
    assert.equal(lines.length, 40);
    assert.equal(lines.findLastIndex(l => /^└/.test(strip(l))) + 1, lines.indexOf(keyLines(lines)[0]));
  }
  // Short of room, the grid shows fewer rows; the key stays whole. With no
  // room even for the grid's headers, the grid's lines are cut, not the key's.
  const at = rows => render(state, { ...wide, rows }).map(strip);
  const shown = lines => KEYS.filter(k => lines.some(l => l.includes(`${k}: `))).length;
  assert.ok(shown(at(40)) < shown(at(80)) && shown(at(40)) > 0);
  const whole = lines => keyLines(['└', ...lines.slice(lines.findIndex(l => l.startsWith('▮ step')))]).join('  ');
  for (const rows of [40, 30]) assert.equal(whole(at(rows)), keyLines(at(80)).join('  '), String(rows));
  const short = at(30);
  assert.ok(!short.slice(short.findIndex(l => /^│ +Ticket +│/.test(l))).some(l => l.startsWith('└')));   // at 30 rows the grid's bottom border went instead
});

// ASS-345 AC5: a ticket ticket:sync holds as reassigned away from the operator
// (its reassigned, to another person or to nobody) starts each of its rows
// "UNASSIGNED " in red (ASS-355; ASS-345 drew it in PAUSED's blue), in PAUSED's place — paused by the operator
// too or not; a row paused by the operator alone still starts "PAUSED ".
test('ASS-345 AC5, ASS-355 AC7: a reassigned ticket\'s rows start "UNASSIGNED " in red, not "PAUSED "; one paused by the operator alone still starts "PAUSED "; the key lists UNASSIGNED', () => {
  const away = to => ({ to, 'to-id': to && `acc-${to}`, 'detected-at': '2026-11-10T13:00:00Z', 'paused-variations': ['A'] });
  const held = [
    ticket('R-1', 'To another', { paused: true, reassigned: away('bea') }),
    ticket('R-2', 'To nobody', { paused: true, reassigned: away(null) }),
    ticket('R-3', 'Two ways', { variations: ['A', 'B'], paused: true, reassigned: away('bea') }),   // B paused by the operator too
    ticket('R-4', 'Operator only', { paused: true }),
  ];
  const s = initialState({ projects: [{ ...project, sprint: { ...project.sprint, features: held, bugs: [], spikes: [] }, questions: [] }], workflows: [{ name: 'e', steps }], assignments: [] });
  const r = render(s, wide);
  const text = key => strip(r.find(l => new RegExp(`(^|\\s)${key.replace('.', '\\.')}: `).test(strip(l)))).slice(2 + TEXT);
  for (const key of ['R-1', 'R-2', 'R-3.A', 'R-3.B']) assert.ok(text(key).startsWith(`UNASSIGNED ${key}: `), `${key}: ${text(key)}`);
  assert.ok(text('R-4').startsWith('PAUSED R-4: '), text('R-4'));
  assert.ok(!['R-1', 'R-2', 'R-3.A', 'R-3.B'].some(k => text(k).includes('PAUSED')));
  assert.ok(r.some(l => l.includes('\x1b[31mUNASSIGNED\x1b[0m R-1: ')));                 // red (ASS-355)
  const key = keyLines(r);
  assert.ok(key.join('').includes('\x1b[31mUNASSIGNED\x1b[0m\x1b[2m reassigned away\x1b[0m'), key.join('\n'));
});

// ASS-355 AC7, ASS-360 AC2/AC3/AC7: a variation its dependencies hold (control's
// dependencyHold, on a project with wait-for-dependencies) keeps its first line
// as an unheld row's — PAUSED too when paused — and gets a second, "↳ AWAITING
// <KEY> (<who>), <KEY>" in gold, the ↳ under the key, at most WAITING_KEYS keys
// then "+N"; UNASSIGNED still says more, with no waiting line; the key explains it.
const GOLD = '\x1b[38;2;255;215;0m';
const OPERATOR = 'Alex Operator';
const heldTickets = [
  ticket('W-1', 'One outside', { dependencies: ['EX-1'] }),
  ticket('W-2', 'Two of them', { dependencies: ['EX-1', 'W-9'] }),
  ticket('W-3', 'Paused too', { dependencies: ['EX-1'], paused: true }),
  ticket('W-4', 'Theirs is done', { dependencies: ['EX-2'] }),
  ticket('W-5', 'Done itself', { state: 'done', dependencies: ['EX-1'] }),
  ticket('W-6', 'Mine', { dependencies: ['W-8'] }),
  ticket('W-7', 'Many', { dependencies: ['EX-1', 'W-9', 'W-8', 'EX-3'] }),
  ticket('W-10', 'Reassigned', { dependencies: ['EX-1'], paused: true, reassigned: { to: 'bea', 'to-id': 'acc-bea', 'detected-at': '2026-11-10T13:00:00Z', 'paused-variations': ['A'] } }),
  ticket('W-8', 'Mine, building', { 'ticket-system-assignment': OPERATOR }),
  ticket('W-9', 'Nobody\'s, building'),
].map(t => ({ 'ticket-system-assignment': OPERATOR, ...t }));
delete heldTickets.find(t => t.key === 'W-9')['ticket-system-assignment'];
const heldOutside = [
  { key: 'EX-1', 'ticket-system-status': 'In Review', 'ticket-system-assignment': 'Sam Rivera' },
  { key: 'EX-2', 'ticket-system-status': 'Done' },
  { key: 'EX-3', 'ticket-system-status': 'To Do', 'ticket-system-assignment': 'Ann Lee' },
];
const heldEngine = [...steps.filter(x => x.id !== 'done'), { ...steps.find(x => x.id === 'done'), 'paired-ticket-system-status': 'Done' }];
const heldState = (on = true) => initialState({ projects: [{ ...project, waitForDependencies: on, outside: heldOutside, sprint: { ...project.sprint, features: heldTickets, bugs: [], spikes: [] }, questions: [] }], workflows: [{ name: 'e', steps: heldEngine }], assignments: [] });
// A row's Ticket cell lines, raw: its first line and the one under it (the grid's left border and padding off).
const ticketLines = (lines, key) => {
  const at = lines.findIndex(l => new RegExp(`(^|\\s)${key}: `).test(strip(l)));
  const width = strip(lines.find(l => /│ +Ticket +│/.test(strip(l)))).indexOf('│', 1) - 1;   // the Ticket column, padding included, by the header's divider
  return [lines[at], lines[at + 1]].map(l => strip(l).slice(1, 1 + width).trimEnd()).concat(lines[at + 1]);
};

test('ASS-360 AC2: a held row\'s first line is as for an unheld row — icons, seat, PAUSED or UNASSIGNED if they apply, then the key — no AWAITING', () => {
  const r = render(heldState(), wide);
  const text = key => ticketLines(r, key)[0].slice(1 + TEXT);
  for (const key of ['W-1', 'W-2', 'W-4', 'W-5', 'W-6', 'W-7']) assert.ok(text(key).startsWith(`${key}: `), text(key));
  assert.ok(text('W-3').startsWith('PAUSED W-3: '), text('W-3'));                     // paused and waiting: PAUSED shows
  assert.ok(text('W-10').startsWith('UNASSIGNED W-10: '), text('W-10'));
  assert.ok(!r.some(l => strip(l).includes('AWAITING') && /W-\d+: /.test(strip(l))), 'never on the key\'s line');
});

test('ASS-360 AC3, ASS-355 AC7: a held row\'s second line is "↳ AWAITING …" in gold, the ↳ under the key; an unheld or UNASSIGNED row has none; the key under the grid explains it', () => {
  const r = render(heldState(), wide);
  const second = key => ticketLines(r, key)[1];
  for (const key of ['W-1', 'W-2', 'W-3', 'W-6', 'W-7']) {
    const [first, under] = ticketLines(r, key);
    assert.ok(under.trimStart().startsWith('↳ AWAITING '), `${key}: ${under}`);
    assert.equal(under.indexOf('↳'), 1 + TEXT, key);                                   // after the icon and seat columns
    assert.equal(first.indexOf(key === 'W-3' ? 'PAUSED' : `${key}:`), 1 + TEXT, key);   // under the line's text
  }
  assert.equal(second('W-1').trim(), '↳ AWAITING EX-1 (Sam)');
  assert.ok(ticketLines(r, 'W-1')[2].includes(`↳ ${GOLD}AWAITING EX-1 (Sam)\x1b[0m`), ticketLines(r, 'W-1')[2]);
  for (const key of ['W-4', 'W-5', 'W-8', 'W-9', 'W-10']) assert.ok(!second(key).includes('AWAITING'), `${key}: ${second(key)}`);
  const key = keyLines(r);
  assert.ok(key.join('').includes(`${GOLD}AWAITING\x1b[0m\x1b[2m a dependency not done yet\x1b[0m`), key.join('\n'));
  // The same project with the flag off holds nothing: no waiting line.
  const off = render(heldState(false), wide);
  assert.ok(!ticketLines(off, 'W-1')[1].includes('AWAITING'));
});

test('ASS-360 AC7: each key on the AWAITING line names its assignee\'s first name when not the operator, "(unassigned)" for nobody, nothing for the operator or an unknown key; +N past WAITING_KEYS stays', () => {
  const r = render(heldState(), wide);
  const second = key => ticketLines(r, key)[1].trim();
  assert.equal(second('W-1'), '↳ AWAITING EX-1 (Sam)');                   // someone else, outside
  assert.equal(second('W-2'), '↳ AWAITING EX-1 (Sam), W-9 (unassigned)');  // nobody, in the sprint
  assert.equal(second('W-6'), '↳ AWAITING W-8');                               // the operator
  // A key whose assignee is not known at all — no row for it, or found nowhere (control ignores such a key, so
  // it is never waited on in the grid) — gets no suffix.
  const t = { 'ticket-system-assignment': OPERATOR, dependencyRows: [{ key: 'ZZ-404', where: 'unknown', assignee: null }, { key: 'ex-5', where: 'outside', assignee: 'Bea  Smith' }] };
  assert.equal(waitingWho(t)('ZZ-404'), '');
  assert.equal(waitingWho(t)('NO-1'), '');
  assert.equal(waitingWho(t)('EX-5'), ' (Bea)');                                   // matched whatever its case
  assert.equal(waitingWho({})('EX-5'), '');
  assert.equal(second('W-7'), '↳ AWAITING EX-1 (Sam), W-9 (unassigned) +2');
});

test('ASS-360 AC4: the Ticket column is floored at the waiting line when it is wider than the first line needs, and never otherwise; selection and scrolling count the two-line cell', () => {
  const long = 'LONG-KEY-12345';   // its line 9 + 37 = 46 wide: over the floor, still on a 60-column screen (render cuts lines at the screen's width)
  const outside = [long, 'EX-9'].map(key => ({ key, 'ticket-system-status': 'To Do', 'ticket-system-assignment': 'Sam Long' }));
  const one = deps => initialState({ projects: [{ ...project, waitForDependencies: true, outside,
    sprint: { ...project.sprint, features: [ticket('L-1', 'A title well over twenty-four characters', { dependencies: deps })], bugs: [], spikes: [] }, questions: [] }], workflows: [{ name: 'e', steps: heldEngine }], assignments: [] });
  const ticketWidth = lines => strip(lines.find(l => /│ +Ticket +│/.test(strip(l)))).indexOf('│', 1) - 3;
  // Narrow: Ticket gets its floor, the key and TITLE_CHARS of title (9 + 5 + 24 + 1 = 39). A shorter waiting line leaves it there; a wider one floors it at its own width.
  const narrow = { ...wide, columns: 60 };
  const floor = ticketWidth(render(one([]), narrow));
  assert.equal(floor, TEXT + 5 + 24 + 1);
  const shorter = render(one(['EX-9']), narrow);
  assert.equal(ticketLines(shorter, 'L-1')[1].trim(), '↳ AWAITING EX-9 (Sam)');
  assert.equal(ticketWidth(shorter), floor);
  const wider = render(one([long]), narrow);
  const under = ticketLines(wider, 'L-1')[1].trim();
  assert.equal(under, `↳ AWAITING ${long} (Sam)`);                               // whole, never cut
  assert.equal(ticketWidth(wider), TEXT + visible(under));
  // Selection reverses both of a held row's lines; moving down past it lands on the next row.
  const size = { ...wide, rows: 36 };   // room for a few rows: the rest scroll into view
  let s = { ...heldState(), focus: 'tickets' };
  const rowAt = st => { const r = render(st, size); const i = r.findIndex(l => l.includes('\x1b[7m')); return [r, i]; };
  const seen = [];
  for (let n = 0; n < heldTickets.length; n++) {
    const [r, i] = rowAt(s);
    assert.ok(i >= 0, `row ${n}: none selected\n${r.map(strip).join('\n')}`);
    const key = strip(r[i]).match(/ (W-\d+): /)[1];
    seen.push(key);
    if (key === 'W-1') {
      assert.ok(r[i + 1].includes('\x1b[7m'), r[i + 1]);
      assert.match(strip(r[i + 1]), /↳ AWAITING EX-1/);
    }
    s = handleKey(s, { name: 'down' }, size);
  }
  assert.deepEqual([...seen].sort(), heldTickets.map(t => t.key).sort());               // each row selected once, in turn, scrolled into view
});

// ===== ASS-357: 💺 on every row whose variation holds a planning or in-progress seat =====
// The planner's seats (control/plan.js seatsOf), not the steps: an engine with
// a queue (Committed), a planning step and a build step, a project capped at one
// planning and three in-progress seats. In rank order (manual-priority): S-11.A
// takes an in-progress seat (S-11.B is done); S-1 the planning seat, S-2 waits
// over the limit; S-3 a seat; S-10 is held by an open blocking question and S-4
// paused, neither seated; S-5 the last seat, S-6 over the limit; S-7 done, S-8
// blocked, S-9 in the queue — none seated.
const seatSteps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'committed', name: 'Committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
  { id: 'plan', name: 'Plan', sequence: 2, 'is-planning-stage': true, action: { type: 'prompt' } },
  { id: 'build', name: 'Build', sequence: 5, 'is-planning-stage': false, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, 'paired-ticket-system-status': 'Done', action: { type: 'none' } },   // an outside dependency Done on the board is done (ASS-355)
];
const seatTicket = (key, rank, states, extra = {}) => ({
  key, title: 'T', 'manual-priority': rank, ...extra,
  variations: states.map(([name, state, v = {}]) => ({ name, 'harness-status': hs(state), ...v })),
});
const seatFeatures = [
  seatTicket('S-11', 1, [['A', 'build'], ['B', 'done']]),
  seatTicket('S-1', 2, [['A', 'plan']]),
  seatTicket('S-2', 3, [['A', 'plan']]),
  seatTicket('S-3', 4, [['A', 'build']]),
  seatTicket('S-10', 5, [['A', 'build']]),
  seatTicket('S-4', 6, [['A', 'build', { 'is-paused': true }]]),
  seatTicket('S-5', 7, [['A', 'build']]),
  seatTicket('S-6', 8, [['A', 'build']]),
  seatTicket('S-7', 9, [['A', 'done']]),
  seatTicket('S-8', 10, [['A', 'stuck']]),
  seatTicket('S-9', 11, [['A', 'committed']]),
];
const SEAT_KEYS = ['S-11.A', 'S-11.B', 'S-1', 'S-2', 'S-3', 'S-10', 'S-4', 'S-5', 'S-6', 'S-7', 'S-8', 'S-9'];
// S-10's question in its own work/S-10/questions-and-answers.json, as loadQuestions tags it.
const seatQuestions = [{ 'asked-on-ticket': 'S-10', status: 'Asked', blocking: true, source: 'S-10', index: 0 }];
const seatProject = (limits = {}) => ({
  id: 'p', name: 'P', stateEngine: 'e', questions: seatQuestions,
  limits: { project: { 'max-tickets-in-planning': 1, 'max-tickets-in-progress': 3 }, harness: {}, ...limits },
  sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features: seatFeatures, bugs: [], spikes: [] },
});
const seatState = (projects = [seatProject()]) => initialState({ projects, workflows: [{ name: 'e', steps: seatSteps }], assignments: [] });
const seatRow = (lines, key) => lines.find(l => new RegExp(`(^|\\s)${key.replace('.', '\\.')}: `).test(strip(l)));
const seated = lines => SEAT_KEYS.filter(k => strip(seatRow(lines, k)).slice(2, 2 + TEXT).includes(SEAT));

test('ASS-357 AC1: 💺 on exactly the rows whose variation holds a planning or in-progress seat by the planner (seatsOf); over the limits, paused, held by a question, done, blocked or queued: none', () => {
  const lines = render(seatState(), wide);
  assert.deepEqual(seated(lines), ['S-11.A', 'S-1', 'S-3', 'S-5']);
  // The planner's own answer, asked of control's state shape directly.
  const engine = { steps: seatSteps };
  const tickets = seatFeatures.map(t => ({ ...t, type: 'feature' }));
  const project = { id: 'p', json: { 'max-tickets-in-planning': 1, 'max-tickets-in-progress': 3 }, engine, engines: { e: engine }, tickets, asking: new Map([['S-10', ['?']]]) };
  const seats = seatsOf({ projects: [project], allProjects: [project], engines: { e: engine }, assignments: [], harness: {} }, project);
  assert.deepEqual(seats['in-planning'], ['S-1 A']);
  assert.deepEqual(seats['in-progress'], ['S-11 A', 'S-3 A', 'S-5 A']);
  assert.deepEqual(seats['over-the-limits'], ['S-2 A', 'S-6 A']);                  // waiting: no 💺
  const fromRows = SEAT_KEYS.filter(k => seated(lines).includes(k)).map(k => k.replace('.', ' ').replace(/^(S-\d+)$/, '$1 A'));
  assert.deepEqual(fromRows.toSorted(), [...seats['in-planning'], ...seats['in-progress']].toSorted());
});

test('ASS-357 AC1: harness.json\'s limits count every project\'s seats, as control plans them: another project\'s seat leaves this one fewer', () => {
  const other = { id: 'q', name: 'Q', stateEngine: 'e', questions: [], limits: { project: {}, harness: { 'max-tickets-in-progress': 3 } },
    sprint: { number: 1, start: '2026-09-18', end: '2026-10-01', features: [seatTicket('Q-1', 1, [['A', 'build']])], bugs: [], spikes: [] } };
  const lines = render(seatState([seatProject({ harness: { 'max-tickets-in-progress': 3 } }), other]), wide);
  assert.deepEqual(seated(lines), ['S-11.A', 'S-1', 'S-3']);                       // Q-1 holds the third harness seat: S-5 waits
});

test('ASS-357 AC2: the key under the grid lists 💺 as "holds a seat (planning or in progress)"', () => {
  const key = keyLines(render(seatState(), wide)).map(strip).join('  ');
  assert.ok(key.split('  ').includes('💺 holds a seat (planning or in progress)'), key);
});

test('ASS-357 AC3: a past day\'s snapshot shows no 💺, as it shows no ⚉ — seats are live state', () => {
  const live = seatState();
  const past = { ...live, day: '2026-09-30', projects: [{ ...live.projects[0], days: { '2026-09-30': live.projects[0].sprint } }] };
  const lines = render(past, wide);
  assert.equal(SEAT_KEYS.filter(k => seatRow(lines, k)).length, SEAT_KEYS.length);   // every row is there
  assert.deepEqual(seated(lines), []);
  assert.ok(keyLines(lines).map(strip).join('  ').includes('💺 holds a seat'));        // the key still explains it
});

test('ASS-357 AC4: 💺 is two cells wide; seated and unseated rows stay aligned, the text on the same column, every grid line the screen\'s width', () => {
  assert.equal(visible(SEAT), 2);
  for (const columns of [200, 160]) {
    const lines = render(seatState(), { ...wide, columns });
    const top = lines.findIndex(l => /^┌.*┬/.test(strip(l))), bottom = lines.findLastIndex(l => /^└/.test(strip(l)));
    for (const l of lines.slice(top, bottom + 1)) assert.equal(visible(l), columns, strip(l));
    const starts = SEAT_KEYS.map(k => { const c = strip(seatRow(lines, k)); return visible(c.slice(0, c.indexOf(k === 'S-4' ? 'PAUSED ' : `${k}: `))); });
    assert.deepEqual(new Set(starts), new Set([2 + 6 + 2 + 1]), JSON.stringify(starts));   // border and blank, six glyphs, the seat's two cells, a blank
    // The columns after Ticket start at the same place on every row: each row's Priority ("<rank> 🪪") on one column.
    const rank = k => seatFeatures.find(t => t.key === k.split('.')[0])['manual-priority'];
    const priority = SEAT_KEYS.map(k => { const c = strip(seatRow(lines, k)); return visible(c.slice(0, c.indexOf(` ${rank(k)} 🪪`))); });
    assert.equal(new Set(priority).size, 1, JSON.stringify(priority));
  }
});

// ASS-357 with ASS-355: the planner skips a variation its dependencies hold
// (dependencies.js heldBy), so its row has no 💺 and its seat goes to the next
// ticket. Capped at two in-progress seats: D-1 waits on D-2 (in the sprint, at
// Build), D-3 on X-1 (outside-tickets.json, In Progress); D-4's X-2 is Done.
test('ASS-357 AC1: a variation its dependencies hold (AWAITING) holds no seat, as control plans it; its seat goes to the next ticket', () => {
  const deps = [
    seatTicket('D-1', 1, [['A', 'build']], { dependencies: ['D-2'] }),
    seatTicket('D-3', 2, [['A', 'build']], { dependencies: ['X-1'] }),
    seatTicket('D-4', 3, [['A', 'build']], { dependencies: ['X-2'] }),
    seatTicket('D-2', 4, [['A', 'build']]),
  ];
  const outside = [{ key: 'X-1', 'ticket-system-status': 'In Progress' }, { key: 'X-2', 'ticket-system-status': 'Done' }];
  const project = on => ({
    id: 'p', name: 'P', stateEngine: 'e', questions: [], backlog: [], outside, waitForDependencies: on,
    limits: { project: { 'max-tickets-in-progress': 2 }, harness: {} },
    sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features: deps, bugs: [], spikes: [] },
  });
  const keys = ['D-1', 'D-3', 'D-4', 'D-2'];
  const seatedOf = lines => keys.filter(k => strip(seatRow(lines, k)).slice(2, 2 + TEXT).includes(SEAT));
  const held = render(seatState([project(true)]), wide);
  assert.deepEqual(seatedOf(held), ['D-4', 'D-2']);
  for (const [k, on] of [['D-1', 'D-2'], ['D-3', 'X-1']]) assert.ok(strip(held[held.indexOf(seatRow(held, k)) + 1]).includes(`↳ AWAITING ${on}`), k);   // under the key (ASS-360)
  assert.deepEqual(seatedOf(render(seatState([project(false)]), wide)), ['D-1', 'D-3']);   // the flag off: nothing held, the first two seated
  // Control's own answer on its state shape: the same seats.
  const engine = { steps: seatSteps };
  const control = { id: 'p', json: { 'max-tickets-in-progress': 2, 'wait-for-dependencies': true }, engine, engines: { e: engine }, tickets: deps.map(t => ({ ...t, type: 'feature' })), backlog: [], outside, asking: new Map() };
  const seats = seatsOf({ projects: [control], allProjects: [control], engines: { e: engine }, assignments: [], harness: {} }, control);
  assert.deepEqual(seats['in-progress'], ['D-4 A', 'D-2 A']);
});

// ASS-404: a variation whose VM control holds for want of memory (its
// project's memory-hold.json `held`) holds no seat either; its seat goes to the
// next ticket, as control plans it.
test('ASS-404 AC3: a variation whose VM is held for memory holds no seat, as control plans it; its seat goes to the next ticket', () => {
  const tickets = [seatTicket('M-1', 1, [['A', 'build']]), seatTicket('M-2', 2, [['A', 'build']]), seatTicket('M-3', 3, [['A', 'build']])];
  const project = memoryHold => ({
    id: 'p', name: 'P', stateEngine: 'e', questions: [], backlog: [], outside: [], memoryHold,
    limits: { project: { 'max-tickets-in-progress': 2 }, harness: {} },
    sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features: tickets, bugs: [], spikes: [] },
  });
  const keys = ['M-1', 'M-2', 'M-3'];
  const seatedOf = lines => keys.filter(k => strip(seatRow(lines, k)).slice(2, 2 + TEXT).includes(SEAT));
  const hold = { since: '2026-10-01T16:00:00Z', vm: 'm-1-a', held: [{ vm: 'm-1-a', key: 'M-1', variation: 'A', state: 'build' }] };
  assert.deepEqual(seatedOf(render(seatState([project(hold)]), wide)), ['M-2', 'M-3']);
  assert.deepEqual(seatedOf(render(seatState([project(null)]), wide)), ['M-1', 'M-2']);
});

// ===== ASS-363: "↳ AWAITING MERGE" under a ticket held at a step with shows-merge-train =====
// A variation whose status chain is at a step with shows-merge-train (grouped-build's Await Sequential Merge; here
// `await`, top level, and `wait` in a sub-engine) gets an extra Ticket-cell line, after any AWAITING one and
// indented as it is: each train an awaited merge request — one a merge request of the variation depends on, in
// another repository, neither Merged nor Closed — then every one depending on it, directly or not, in depends-on
// order, " → " between them and "; " between trains. From the recorded merge-request list alone.
const API = 'https://gitlab.example.com/acme/api', WEB = 'https://gitlab.example.com/acme/web', LIB = 'https://gitlab.example.com/acme/lib';
const mr = (id, repository, key, extra = {}) => ({ id, repository, ...(key ? { key, url: `${repository}/-/merge_requests/${key.slice(1)}`, status: 'Open' } : { status: 'Not Created' }), ...extra });
const train = [mr(1, API, '!12'), mr(2, WEB, '!7', { 'depends-on': [1] }), mr(3, WEB, null, { 'depends-on': [2] })];
const mergeEngine = [...heldEngine, { id: 'await', name: 'Await Sequential Merge', sequence: 6, 'shows-merge-train': true, action: { type: 'script' } }];
const subEngine = [{ id: 'wait', name: 'Wait', sequence: 1, 'shows-merge-train': true, action: { type: 'script' } }];
const merging = (key, mrs, { state = 'await', sub, ...extra } = {}) => ({
  key, title: 'Merge me', 'ticket-system-assignment': OPERATOR, ...extra,
  variations: [{ name: 'A', 'harness-status': { ...hs(state), ...(sub ? { 'sub-status': { state: sub, 'state-engine': 'sub' } } : {}) }, 'merge-request': mrs }],
});
const mergeTickets = [
  merging('M-1', train),
  merging('M-2', train, { state: 'build' }),                                                                       // no flag at its step
  merging('M-3', [mr(1, API, '!12', { status: 'Merged' }), mr(2, WEB, '!7', { 'depends-on': [1] })]),            // nothing awaited
  merging('M-4', [mr(1, WEB, '!6'), mr(2, WEB, '!7', { 'depends-on': [1] })]),                                    // its own repository: stacked, not awaited
  merging('M-5', [mr(1, API, '!12'), mr(2, WEB, '!7', { 'depends-on': [1] }), mr(3, LIB, '!4'), mr(4, WEB, '!8', { 'depends-on': [3] })]),
  merging('M-6', train, { dependencies: ['EX-1'] }),                                                               // AWAITING too
  merging('M-7', train, { state: 'build', sub: 'wait' }),                                                         // the flag deeper in the chain
  merging('M-8', [mr(1, API, '!12', { status: 'Closed' }), mr(2, WEB, '!7', { 'depends-on': [1] })]),            // Closed: nothing to wait for
];
const mergeState = (tickets = mergeTickets) => initialState({ projects: [{ ...project, waitForDependencies: true, outside: heldOutside, sprint: { ...project.sprint, features: tickets, bugs: [], spikes: [] }, questions: [] }],
  workflows: [{ name: 'e', steps: mergeEngine }, { name: 'sub', steps: subEngine }], assignments: [] });
// A row's Ticket cell lines (stripped, the grid's border and padding off): its first and the `n` - 1 under it.
const cellLines = (lines, key, n = 3) => {
  const at = lines.findIndex(l => new RegExp(`(^|\\s)${key}: `).test(strip(l)));
  const width = strip(lines.find(l => /│ +Ticket +│/.test(strip(l)))).indexOf('│', 1) - 1;
  return lines.slice(at, at + n).map(l => strip(l).slice(1, 1 + width).trimEnd());
};

test('ASS-363 AC3: a variation at a shows-merge-train step gets "↳ AWAITING MERGE <repo> <key> → …" under the key, each repo and key linked; a planned one shows "MR <id>"; several trains joined by "; "', () => {
  const r = render(mergeState(), wide);
  const second = key => cellLines(r, key)[1];
  assert.equal(second('M-1').trim(), '↳ AWAITING MERGE api !12 → web !7 → web MR 3');
  assert.equal(second('M-1').indexOf('↳'), 1 + TEXT);                                   // under the key, as AWAITING
  assert.equal(second('M-5').trim(), '↳ AWAITING MERGE api !12 → web !7; lib !4 → web !8');
  assert.equal(second('M-7').trim(), '↳ AWAITING MERGE api !12 → web !7 → web MR 3');   // a sub-engine's step with the flag
  const raw = r[r.findIndex(l => / M-1: /.test(strip(l))) + 1];
  assert.ok(raw.includes(`${GOLD}AWAITING MERGE\x1b[0m`), raw);
  assert.ok(raw.includes(`\x1b]8;;${API}\x1b\\api\x1b]8;;\x1b\\ \x1b]8;;${API}/-/merge_requests/12\x1b\\!12\x1b]8;;\x1b\\`), raw);
  assert.ok(raw.includes(`\x1b]8;;${WEB}\x1b\\web\x1b]8;;\x1b\\ MR 3`), raw);              // planned: its repository linked, "MR <id>" not
  const key = keyLines(r);
  assert.ok(key.join('').includes(`${GOLD}AWAITING MERGE\x1b[0m\x1b[2m MRs to merge, in order\x1b[0m`), key.join('\n'));
});

test('ASS-363 AC3: a train goes on through every merge request depending on the awaited one, directly or not, in depends-on order whatever the list order', async () => {
  const { mergeTrains } = await import('../../src/tui/screens/sprint.js');
  const at = { status: { chain: [{ step: { 'shows-merge-train': true } }] } };
  const keys = mrs => mergeTrains({ ...at, variation: { 'merge-request': mrs } }).map(tr => tr.map(m => m.key ?? `MR ${m.id}`));
  // Listed backwards, a fork after web !7 in its own repository: both branches follow it, each after what it depends on.
  assert.deepEqual(keys([mr(4, WEB, '!9', { 'depends-on': [3, 2] }), mr(3, WEB, '!8', { 'depends-on': [2] }), mr(2, WEB, '!7', { 'depends-on': [1] }), mr(1, API, '!12')]), [['!12', '!7', '!8', '!9']]);
  // Across three repositories web !7 is awaited too (lib !4 depends on it), but already in api !12's train: one train, not two.
  assert.deepEqual(keys([mr(1, API, '!12'), mr(2, WEB, '!7', { 'depends-on': [1] }), mr(3, LIB, '!4', { 'depends-on': [2] })]), [['!12', '!7', '!4']]);
  // A merged dependent still shows in its place; one depending on an unrelated merge request does not join.
  assert.deepEqual(keys([mr(1, API, '!12'), mr(2, WEB, '!7', { 'depends-on': [1], status: 'Merged' }), mr(5, LIB, '!5')]), []);   // the only dependent is merged: nothing waits
  assert.deepEqual(keys([mr(1, API, '!12'), mr(2, WEB, '!7', { 'depends-on': [1] }), mr(5, LIB, '!5', { 'depends-on': [9] })]), [['!12', '!7']]);
  // The flag absent from every level, or no chain: none.
  assert.deepEqual(mergeTrains({ status: { chain: [{ step: { id: 'await-dependencies', name: 'Await Sequential Merge' } }] }, variation: { 'merge-request': train } }), []);
  assert.deepEqual(mergeTrains({ variation: { 'merge-request': train } }), []);
});

test('ASS-363 AC4: no AWAITING MERGE line with nothing awaited or without the flag; AWAITING comes first, then AWAITING MERGE', () => {
  const r = render(mergeState(), wide);
  for (const key of ['M-2', 'M-3', 'M-4', 'M-8']) assert.ok(!cellLines(r, key)[1].includes('AWAITING MERGE'), `${key}: ${cellLines(r, key)[1]}`);
  const [first, waiting, awaiting] = cellLines(r, 'M-6');
  assert.ok(first.slice(1 + TEXT).startsWith('M-6: '), first);
  assert.equal(waiting.trim(), '↳ AWAITING EX-1 (Sam)');
  assert.equal(awaiting.trim(), '↳ AWAITING MERGE api !12 → web !7 → web MR 3');
  assert.equal(waiting.indexOf('↳'), awaiting.indexOf('↳'));
});

test('ASS-363 AC4: the Ticket column is floored at an AWAITING MERGE line wider than the first line needs; selection and scrolling count the three-line cell', () => {
  const narrow = { ...wide, columns: 100 };
  const ticketWidth = lines => strip(lines.find(l => /│ +Ticket +│/.test(strip(l)))).indexOf('│', 1) - 3;
  const long = [mr(1, API, '!12'), mr(2, WEB, '!7', { 'depends-on': [1] }), mr(3, LIB, '!4', { 'depends-on': [2] }), mr(4, WEB, '!8', { 'depends-on': [3] })];
  const r = render(mergeState([merging('M-9', long, { dependencies: ['EX-1'] })]), narrow);
  const under = cellLines(r, 'M-9')[2].trim();
  assert.equal(under, '↳ AWAITING MERGE api !12 → web !7 → lib !4 → web !8');           // whole, never cut
  assert.equal(ticketWidth(r), TEXT + visible(under));
  // Selection reverses all three of M-6's lines; moving down past it lands on the next row.
  const size = { ...wide, rows: 36 };
  let s = { ...mergeState(), focus: 'tickets' };
  const seen = [];
  for (let n = 0; n < mergeTickets.length; n++) {
    const lines = render(s, size);
    const i = lines.findIndex(l => l.includes('\x1b[7m'));
    assert.ok(i >= 0, `row ${n}: none selected`);
    const key = strip(lines[i]).match(/ (M-\d+): /)[1];
    seen.push(key);
    if (key === 'M-6') {
      for (const j of [1, 2]) assert.ok(lines[i + j].includes('\x1b[7m'), lines[i + j]);
      assert.match(strip(lines[i + 2]), /↳ AWAITING MERGE api !12/);
    }
    s = handleKey(s, { name: 'down' }, size);
  }
  assert.deepEqual([...seen].sort(), mergeTickets.map(t => t.key).sort());
});
