import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowchart, column } from '../../src/tui/flowchart.js';
import { visible, link } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const step = (id, sequence, ...exits) => ({ id, sequence, name: id, 'exit-events': exits.map(to => ({ 'move-to-state': to })) });
// a → b → c → d → e, five stations on the floor
const line = [step('a', 1, 'b'), step('b', 2, 'c'), step('c', 3, 'd'), step('d', 4, 'e'), step('e', 5)];
// Two stations a row: 32 wide, 4 apart, so 68 columns; 76 centers them 4 in.
const draw = (steps, tickets = {}, columns = 68) => flowchart(steps, { tickets, columns }).map(strip);
// n placeholder tickets, without stats
const some = (n, prefix = 'T') => Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${i + 1}: Ticket`, stats: '' }));
const tops = out => out.filter(l => l.includes('┌')).map(l => [...l.matchAll(/┌─ (\d+) /g)].map(m => Number(m[1])));

test('stations run in sequence order, left to right then right to left, like a line snaking across a floor', () => {
  assert.deepEqual(tops(draw(line)), [[1, 2], [4, 3], [5]]);
});

test('a conveyor joins neighbors in a row, pointing the way the row runs, and turns down at the row\'s end', () => {
  const out = draw(line);
  const rows = out.filter(l => l.includes('═══'));
  assert.match(rows[0], /│═══▶│/);
  assert.match(rows[1], /│◀═══│/);
  const turns = out.filter(l => l.trim() === '▼');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].indexOf('▼'), 32 + 4 + 1);                  // under station 2, the first row's end
  assert.equal(turns[1].indexOf('▼'), 1);                           // under station 4, the second row's end
});

test('each station is boxed, its number in the top border and its name inside; the floor is centered and fits the screen', () => {
  const out = draw(line, {}, 76);
  assert.match(out.find(l => l.includes('┌─ 1 ')), /^ {4}┌─ 1 ─+┐ {4}┌─ 2 ─+┐$/);
  assert.ok(out.some(l => /│ █ a +│/.test(l)));
  assert.ok(out.every(l => visible(l) <= 76));
});

test('a station\'s tickets show in its top border', () => {
  const out = draw(line, { b: some(1), c: some(3) });
  assert.match(out.find(l => l.includes('┌─ 2 ')), /┌─ 2 ─+ 1 ticket ─┐/);
  assert.match(out.find(l => l.includes('┌─ 3 ')), /┌─ 3 ─+ 3 tickets ─┐/);
});

test('exits besides the next station mark the bottom border: back, ahead, repeat and to quarantine', () => {
  const steps = [step('a', 1, 'b'), step('b', 2, 'c', 'b'), step('c', 3, 'd', 'a', 'e'), step('d', 4, 'e', 'x'), step('e', 5), { ...step('x', 0), area: 'quarantine' }];
  const bottoms = draw(steps, {}, 200).filter(l => l.includes('└')).join('\n');
  assert.match(bottoms, /└─⟳─+┘/);                                  // b repeats itself
  assert.match(bottoms, /└─↺1 ↷5─+┘/);                              // c goes back to 1 or ahead to 5
  assert.match(bottoms, /└─⊘─+┘/);                                  // d can send work to quarantine
});

test('steps whose area is quarantine sit apart in quarantine, marked as returning work where it came from', () => {
  const steps = [...line, { ...step('x', 0), area: 'quarantine', name: 'Blocked', 'exit-events': [{ 'follow-return-to-state': true }] }];
  const out = draw(steps, { x: some(2) }, 200);
  const at = out.findIndex(l => l.includes('quarantine'));
  assert.ok(at > out.findIndex(l => l.includes('┌─ 5 ')));
  assert.match(out[at + 1], /┌─ 0 ─+ 2 tickets ─┐/);
  assert.ok(out.slice(at).some(l => /│ █ Blocked +│/.test(l)));
  assert.ok(out.slice(at).some(l => /└─↩─+┘/.test(l)));
});

test('sequence alone puts nothing in quarantine: a sequence 0 step without the area is on the floor, and an area step leaves it whatever its sequence', () => {
  const steps = [step('intake', 0, 'a'), ...line.slice(0, 2), { ...step('hold', 7), area: 'quarantine' }];
  const out = draw(steps, {}, 200);
  const at = out.findIndex(l => l.includes('quarantine'));
  assert.deepEqual(tops(out.slice(0, at)), [[0, 1, 2]]);
  assert.deepEqual(tops(out.slice(at)), [[7]]);
});

test('long names wrap onto a second line, and anything longer is cut with an ellipsis', () => {
  const out = draw([{ ...step('a', 1), name: 'Add Screenshots to Merge Request' }, { ...step('b', 2), name: 'A very long name that cannot possibly fit in two lines' }], {}, 76);
  assert.ok(out.some(l => /│ █ Add Screenshots to Merge +│/.test(l)));
  assert.ok(out.some(l => /│ {3}Request +│/.test(l)));
  assert.ok(out.some(l => /│ {3}\S.*… │/.test(l)));
});

test('under each station, its tickets, one a line, and the row\'s stations wait for the longest list', () => {
  const out = draw(line, { a: some(2, 'A'), b: some(3, 'B'), d: some(1, 'D') }, 76);
  const under = (top, k) => out[out.findIndex(l => l.includes(top)) + 4 + k];
  assert.equal(under('┌─ 1 ', 0).slice(4, 36), `   A-1: Ticket${' '.repeat(18)}`);
  assert.equal(under('┌─ 1 ', 1).slice(4, 36), `   A-2: Ticket${' '.repeat(18)}`);
  assert.match(under('┌─ 1 ', 0), /^ {4} {3}A-1: Ticket {18} {4} ║ B-1: Ticket/);   // side by side; the turn belt runs down station 2's list
  assert.match(under('┌─ 1 ', 2), /^ {4} {36} ║ B-3: Ticket/);
  assert.equal(under('┌─ 1 ', 3).trim(), '▼');                          // after the longest list, the turn
  assert.ok(out.some(l => /^ {4} ║ D-1: Ticket/.test(l)));                // station 4 is where the second row turns
});

test('a long ticket line is cut with an ellipsis to the station\'s width', () => {
  const out = draw(line, { a: [{ name: 'ABC-1262: Opinion detail: show parallel citations', stats: '' }] }, 76);
  const ticket = out.find(l => l.includes('ABC-1262'));
  assert.equal(ticket.slice(4, 36), '   ABC-1262: Opinion detail: sh…');
});

test('a ticket\'s stats follow its name; a long name is cut so the stats always show in full', () => {
  const out = draw(line, { a: [{ name: 'A-1: Ticket', stats: '(1, 0)' }, { name: 'ABC-1262: Opinion detail: show parallel citations', stats: '(2, 3)' }] }, 76);
  assert.ok(out.some(l => l.slice(4, 36) === `   A-1: Ticket (1, 0)${' '.repeat(11)}`));
  assert.ok(out.some(l => l.slice(4, 36) === '   ABC-1262: Opinion det… (2, 3)'));
});

test('a linked ticket line is cut to the same width, its link closed before the ellipsis', () => {
  const raw = flowchart(line, { tickets: { a: [{ name: link('ABC-1262: Opinion detail: show parallel citations', 'http://t/1262'), stats: '' }] }, columns: 76 });
  const ticket = raw.find(l => l.includes('ABC-1262'));
  assert.ok(ticket.includes('\x1b]8;;http://t/1262\x1b\\ABC-1262: Opinion detail: sh\x1b]8;;\x1b\\…'));
  assert.equal(strip(ticket.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '')).slice(4, 36), '   ABC-1262: Opinion detail: sh…');   // the station's 32 columns
  assert.equal(visible(ticket), 72);                                  // the row keeps its width
});

test('the color square takes the station\'s progress-bar color', () => {
  const raw = flowchart([{ ...step('a', 1), color: '#ff0000' }], { tickets: {}, columns: 76 });
  assert.ok(raw.some(l => l.includes('\x1b[38;2;255;0;0m█')));
});

test('a colorless station\'s square is Done\'s #3A703A at Done, darker each step back, black at the first, on the floor and in a column (ASS-48)', () => {
  const squares = out => out.flatMap(l => [...l.matchAll(/\x1b\[38;2;([\d;]+)m█/g)].map(m => m[1]));
  const ramp = ['0;0;0', '15;28;15', '29;56;29', '44;84;44', '58;112;58'];   // 1 to 5: #3A703A × 0, ¼, ½, ¾, 1
  assert.deepEqual(squares(column(line, { current: '' })), ramp);
  assert.deepEqual(squares(flowchart(line, { tickets: {}, columns: 32 })), ramp);   // one a row, in order
});

test('given notes, each station shows its notes beneath it in place of its tickets, still counting its tickets in the top border', () => {
  const out = flowchart(line, { tickets: { a: some(2, 'A') }, notes: { a: ['visits    3', 'time      2h 5m'], b: ['no finished visits'] }, columns: 76 }).map(strip);
  const under = (top, k) => out[out.findIndex(l => l.includes(top)) + 4 + k];
  assert.match(out.find(l => l.includes('┌─ 1 ')), /┌─ 1 ─+ 2 tickets ─┐/);
  assert.equal(under('┌─ 1 ', 0).slice(4, 36), `   visits    3${' '.repeat(18)}`);
  assert.equal(under('┌─ 1 ', 1).slice(4, 36), `   time      2h 5m${' '.repeat(14)}`);
  assert.ok(!out.some(l => l.includes('A-1')));
  assert.match(under('┌─ 1 ', 0), / ║ no finished visits/);
});

test('a column stacks the stations top down in sequence order, ▼ between them, each 32 wide; the station the work is at is marked in its top border', () => {
  const out = column(line, { current: 'c' }).map(strip);
  const tops = out.filter(l => l.includes('┌')).map(l => Number(l.match(/┌─ (\d+) /)[1]));
  assert.deepEqual(tops, [1, 2, 3, 4, 5]);
  assert.ok(out.every(l => visible(l) === 32));
  assert.equal(out.filter(l => l.trim() === '▼').length, 4);                 // between five stations
  assert.equal(out.indexOf(out.find(l => l.trim() === '▼')), 4);              // right under the first station's bottom border
  assert.match(out.find(l => l.includes('┌─ 3 ')), /^┌─ 3 ─+ ◀ now ─┐$/);
  assert.match(out.find(l => l.includes('┌─ 2 ')), /^┌─ 2 ─+┐$/);
  assert.ok(out.some(l => /│ █ c +│/.test(l)));
});

test('a column marks exits as the floor does, and puts quarantined steps beneath the rest', () => {
  const steps = [step('a', 1, 'b'), step('b', 2, 'c', 'a'), step('c', 3), { ...step('x', 0), area: 'quarantine', 'exit-events': [{ 'follow-return-to-state': true }] }];
  const out = column(steps, { current: '' }).map(strip);
  assert.ok(out.some(l => /^└─↺1─+┘$/.test(l)));
  const at = out.findIndex(l => l.trim() === 'quarantine');
  assert.ok(at > out.findIndex(l => l.includes('┌─ 3 ')));
  assert.match(out[at + 1], /^┌─ 0 ─+┐$/);
  assert.ok(out.slice(at).some(l => /^└─↩─+┘$/.test(l)));
  assert.ok(!out.some(l => l.includes('now')));                               // no state yet, nothing marked
});

test('a column lists each station\'s agents inside it under its name, one a line, cut with an ellipsis to fit', () => {
  const agents = { b: ['🤖 She-Ra - Running checks', '🤖 Bumblebee - A status update far too long to fit the station'] };
  const out = column(line, { current: 'b', agents }).map(strip);
  const at = out.findIndex(l => l.includes('┌─ 2 '));
  assert.equal(out[at + 3], '│ 🤖 She-Ra - Running checks   │');
  assert.equal(out[at + 4], '│ 🤖 Bumblebee - A status upd… │');
  assert.match(out[at + 5], /^└─+┘$/);                                         // then the station's bottom border
  assert.equal(out[at + 6].trim(), '▼');
  assert.ok(out.every(l => visible(l) === 32));
});

test('ASS-192 AC3: a switched-off station ("is-active": false) is marked off in its top border and dimmed, every line, on the floor (S, B) and in a column (f); a station switched on is neither', () => {
  const steps = line.map(s => (s.id === 'b' ? { ...s, 'is-active': false } : s));
  const DIM = '\x1b[2m';
  for (const raw of [flowchart(steps, { tickets: { b: some(1) }, columns: 68 }), column(steps, { current: 'b' })]) {
    const at = raw.findIndex(l => strip(l).includes('┌─ 2 '));
    assert.match(strip(raw[at]), /┌─ 2 ─+ off ─/);
    assert.ok(!raw.some(l => /┌─ [1345] [^┐]* off ─/.test(strip(l))), 'only b is off');
    for (const l of raw.slice(at, at + 4)) assert.ok(l.includes(DIM), JSON.stringify(l));   // its top border, two name lines and bottom border
  }
  const on = column(line, { current: '' });
  assert.ok(!on.some(l => l.includes('\x1b[2m') || strip(l).includes(' off ')));
  assert.ok(column(steps, { current: '' }).map(strip).every(l => visible(l) === 32));
});

test('ASS-186: given inside lines, a station shows them in its box under its name, each cut with an ellipsis to fit', () => {
  const out = draw(line, {}, 76);
  const inside = flowchart(line, { tickets: {}, inside: { b: ['· 2 3 ·', 'a line far too long to fit inside the station box'] }, columns: 76 }).map(strip);
  const at = inside.findIndex(l => l.includes('┌─ 2 '));
  assert.match(inside[at + 3], /│ · 2 3 · +│/);
  assert.match(inside[at + 4], /│ a line far too long to fit … │/);
  assert.match(inside[at + 5], /└─+┘/);
  assert.equal(inside.length, out.length + 2);                                 // the row waits for the taller station
});

// ASS-245: the box of the station or sub-flow named `name` on the floor `out`
// (stripped): its top and bottom rows, its left and right columns. A sub-flow
// carries its square and name in its top border, a station on the line under it.
function rect(out, name) {
  const r = out.findIndex(l => l.includes(`█ ${name} `));
  const col = out[r].indexOf(`█ ${name} `);
  const group = /┌─ \d+ $/.test(out[r].slice(0, col));
  const left = group ? out[r].lastIndexOf('┌', col) : col - 2;
  const top = group ? r : r - 1;
  const right = out[top].indexOf('┐', left);
  return { top, left, right, bottom: out.findIndex((l, i) => i > top && l[left] === '└') };
}
const within = (outer, inner) => outer.top < inner.top && inner.bottom < outer.bottom && outer.left < inner.left && inner.right < outer.right;
// The lines listed under a box, in its columns, trimmed, to the first blank or border.
function listed(out, { left, right, bottom }) {
  const rest = out.slice(bottom + 1).map(l => l.slice(left, right + 1).replace('║', '').trim());
  return rest.slice(0, rest.findIndex(l => !l || /^[▼─┌│└]/.test(l)) >>> 0);
}
// A floor of a → b, b running p → q, q running x, x running y: four levels.
const fourDeep = {
  b: { steps: [step('p', 1, 'q'), step('q', 2)], tickets: { p: some(1, 'P') }, subflows: {
    q: { steps: [step('x', 1)], tickets: {}, subflows: {
      x: { steps: [step('y', 1)], tickets: { y: some(1, 'Y') } } } } } },
};

test('ASS-245 AC1: a station given a sub-flow is a box titled with its number, square and name, holding the sub-flow\'s stations drawn as the floor draws them, nested to any depth', () => {
  const out = flowchart(line.slice(0, 2), { tickets: { b: some(1, 'B') }, subflows: fourDeep, columns: 400 }).map(strip);
  assert.match(out.find(l => l.includes('█ b ')), /┌─ 2 █ b ─+ 1 ticket ─┐/);
  assert.ok(within(rect(out, 'b'), rect(out, 'p')) && within(rect(out, 'b'), rect(out, 'q')));
  assert.ok(within(rect(out, 'q'), rect(out, 'x')) && within(rect(out, 'x'), rect(out, 'y')));
  assert.ok(!within(rect(out, 'p'), rect(out, 'x')));
  assert.match(out.find(l => l.includes('█ p ')), /│ █ p +│═══▶│ /);                    // p's belt runs on to q inside b
  assert.deepEqual(listed(out, rect(out, 'y')), ['Y-1: Ticket']);                         // each ticket under its own station
  assert.deepEqual(listed(out, rect(out, 'p')), ['P-1: Ticket']);
  assert.deepEqual(listed(out, rect(out, 'b')), ['B-1: Ticket']);
  assert.deepEqual(listed(out, rect(out, 'x')), []);
  assert.equal(out.filter(l => l.includes('Y-1')).length, 1);
  assert.match(out.find(l => l.includes('█ a ')), /│ █ a +│═══▶│ ┌─ 1 /);                // the floor's belt meets the box, by its stations' tops
  const width = rect(out, 'b').right - rect(out, 'b').left + 1;                             // as wide as its stations, side by side
  assert.equal(width, 4 + 32 + 4 + (4 + (4 + 32)));
});

test('ASS-245: counts sets a station\'s top-border tally in place of its tickets\' count', () => {
  const out = flowchart(line.slice(0, 2), { tickets: { b: some(1) }, counts: { a: 3, b: 4 }, subflows: fourDeep, columns: 400 }).map(strip);
  assert.match(out.find(l => l.includes('┌─ 1 ')), /┌─ 1 ─+ 3 tickets ─┐/);
  assert.match(out.find(l => l.includes('█ b ')), /┌─ 2 █ b ─+ 4 tickets ─┐/);
});

test('ASS-245 AC3: stations wider than the screen wrap onto further rows, inside a sub-flow too, each box closed around them and no line wider than the screen', () => {
  const many = { b: { steps: line.map(s => ({ ...s, id: `s${s.id}`, name: `s${s.id}` })), tickets: {}, subflows: {} } };
  const out = flowchart(line.slice(0, 2), { tickets: {}, subflows: many, columns: 80 }).map(strip);
  assert.ok(out.every(l => visible(l) <= 80), out.join('\n'));
  const box = rect(out, 'b');
  for (const name of ['sa', 'sb', 'sc', 'sd', 'se']) assert.ok(within(box, rect(out, name)), name);
  assert.equal(rect(out, 'sa').top, rect(out, 'sb').top);                                    // two a row inside b's 76 columns
  assert.equal(rect(out, 'sd').top, rect(out, 'sc').top);                                    // the next row back, right to left
  assert.ok(rect(out, 'sd').left < rect(out, 'sc').left);
  assert.ok(rect(out, 'se').top > rect(out, 'sc').top);
  assert.ok(rect(out, 'b').top > rect(out, 'a').top);                                        // b too wide to sit beside a: a row of its own
});

test('ASS-245: a switched-off sub-flow is marked off and dimmed like a station', () => {
  const raw = flowchart([line[0], { ...line[1], 'is-active': false }], { tickets: {}, subflows: fourDeep, columns: 400 });
  const at = raw.findIndex(l => strip(l).includes('█ b '));
  assert.match(strip(raw[at]), /┌─ 2 █ b ─+ off ─┐/);
  assert.ok(raw[at].includes('\x1b[2m'));
});
