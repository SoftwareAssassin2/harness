// The sprint screen's ticket rows lay their icons out in one-cell columns
// (ASS-259): c1 ▮ the step color, c2 the type (✦ feature, ✘ bug, ⌕ spike), c3 ☛
// worked by hand, c4 ↯ fast-tracked, c5 one ⦿ (red: a requirements change waits;
// else blue: needs the operator; else dim grey: going on with an assumption), c6
// ⚉ an agent working on that row's ticket and variation — each a blank when it
// doesn't apply — then a blank and the text, so the text starts on the same
// terminal column on every row. A paused variation's text starts "PAUSED " in
// blue — "WAITING ON <KEY>" in gold in its place for one its dependencies
// hold (ASS-355), "UNASSIGNED " in red for a ticket reassigned away from the
// operator (ASS-345); no 📝 or ⏸️. Every glyph is East Asian Width N with no Emoji property. A
// key in dim text under the grid says what each means.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { visible } from '../../src/tui/text.js';
import { GLYPHS } from '../../src/tui/screens/shared.js';

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
const cell = key => rowOf(key).slice(2);
const TEXT = 7;
const prefix = key => cell(key).slice(0, TEXT);
// What the text starts with on each row: PAUSED for a paused variation, else the key.
const textOf = key => (['A-2', 'A-9'].includes(key) ? 'PAUSED ' : `${key}: `);
const KEYS = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9', 'A-10', 'A-11', 'A-12', 'A-13.A', 'A-13.B'];
// The key under the grid: the lines right after its bottom border that start with a key entry.
const keyLines = lines => {
  const after = lines.slice(lines.findLastIndex(l => /^└/.test(strip(l))) + 1);
  const end = after.findIndex(l => !/^([▮✦✘⌕☛↯⦿⚉]|PAUSED|UNASSIGNED|WAITING ON) /.test(strip(l)));
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
  const expect = {
    'A-1': '▮✦    ',
    'A-2': '▮✦☛↯⦿⚉',
    'A-3': '▮✦☛   ',
    'A-4': '▮✦ ↯  ',
    'A-5': '▮✦  ⦿ ',
    'A-6': '▮✦  ⦿ ',
    'A-7': '▮✦  ⦿ ',
    'A-8': '▮✦   ⚉',
    'A-9': '▮✦    ',
    'A-10': ' ✦    ',
    'A-11': '▮✘    ',
    'A-12': '▮⌕    ',
    'A-13.A': '▮✦    ',
    'A-13.B': '▮✦   ⚉',
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
  // Nothing else in any row's prefix: GLYPHS or blanks, no VS16.
  for (const key of KEYS) assert.ok([...prefix(key)].every(c => c === ' ' || Object.values(GLYPHS).includes(c)), key);
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
  assert.equal(strip(key.join('  ')), '▮ step  ✦ feature  ✘ bug  ⌕ spike  ☛ by hand  ↯ fast-tracked  ⦿ requirements change  ⦿ needs you  ⦿ assumption  ⚉ agent working  PAUSED paused  UNASSIGNED reassigned away  WAITING ON a dependency not done yet');
  const all = key.join('');
  for (const kind of ['31', '34', '2;90']) assert.ok(all.includes(`\x1b[${kind}m⦿\x1b[0m`), kind);   // ⦿ in each of its colors
  assert.ok(all.includes('\x1b[34mPAUSED\x1b[0m'));
  assert.ok(all.includes('\x1b[2m requirements change\x1b[0m') && all.includes('\x1b[2m▮\x1b[0m'));   // dim
});

test('ASS-259 AC7: the key wraps between entries at the screen width, never inside one, and is never cut off — the grid gives up rows', () => {
  const ENTRIES = ['▮ step', '✦ feature', '✘ bug', '⌕ spike', '☛ by hand', '↯ fast-tracked', '⦿ requirements change', '⦿ needs you', '⦿ assumption', '⚉ agent working', 'PAUSED paused', 'UNASSIGNED reassigned away', 'WAITING ON a dependency not done yet'];
  for (const columns of [200, 100, 60, 40]) {
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

// ASS-355 AC7: a variation its dependencies hold (control's dependencyHold, on
// a project with wait-for-dependencies) starts its row "WAITING ON <KEY>" in
// gold — several keys "WAITING ON <KEY>, <KEY>" — in PAUSED's place, paused
// too or not; UNASSIGNED still says more; the key explains it.
test('ASS-355 AC7: a held row starts "WAITING ON <KEY>" — "<KEY>, <KEY>" for several — in gold, in PAUSED\'s place; the key under the grid explains it', () => {
  const GOLD = '\x1b[38;2;255;215;0m';
  const held = [
    ticket('W-1', 'One outside', { dependencies: ['EX-1'] }),
    ticket('W-2', 'Two of them', { dependencies: ['EX-1', 'W-9'] }),
    ticket('W-3', 'Paused too', { dependencies: ['EX-1'], paused: true }),
    ticket('W-4', 'Theirs is done', { dependencies: ['EX-2'] }),
    ticket('W-5', 'Done itself', { state: 'done', dependencies: ['EX-1'] }),
    ticket('W-9', 'Building'),
  ];
  const outside = [{ key: 'EX-1', 'ticket-system-status': 'In Review', 'ticket-system-assignment': 'A Teammate' }, { key: 'EX-2', 'ticket-system-status': 'Done' }];
  const engine = [...steps.filter(x => x.id !== 'done'), { ...steps.find(x => x.id === 'done'), 'paired-ticket-system-status': 'Done' }];
  const s = initialState({ projects: [{ ...project, waitForDependencies: true, outside, sprint: { ...project.sprint, features: held, bugs: [], spikes: [] }, questions: [] }], workflows: [{ name: 'e', steps: engine }], assignments: [] });
  const r = render(s, wide);
  const text = key => strip(rowOf(key, r)).slice(2 + TEXT);
  assert.ok(text('W-1').startsWith('WAITING ON EX-1 W-1: '), text('W-1'));
  assert.ok(text('W-2').startsWith('WAITING ON EX-1, W-9 W-2: '), text('W-2'));
  assert.ok(text('W-3').startsWith('WAITING ON EX-1 W-3: '), text('W-3'));                  // in PAUSED's place
  assert.ok(text('W-4').startsWith('W-4: '), text('W-4'));
  assert.ok(text('W-5').startsWith('W-5: '), text('W-5'));                                  // a done step is never held
  assert.ok(rowOf('W-1', r).includes(`${GOLD}WAITING ON EX-1\x1b[0m W-1: `), rowOf('W-1', r));
  const key = keyLines(r);
  assert.ok(key.join('').includes(`${GOLD}WAITING ON\x1b[0m\x1b[2m a dependency not done yet\x1b[0m`), key.join('\n'));
  // The same project with the flag off holds nothing: no prefix.
  const off = render(initialState({ projects: [{ ...project, outside, sprint: { ...project.sprint, features: held, bugs: [], spikes: [] }, questions: [] }], workflows: [{ name: 'e', steps: engine }], assignments: [] }), wide);
  assert.ok(strip(rowOf('W-1', off)).slice(2 + TEXT).startsWith('W-1: '));
});
