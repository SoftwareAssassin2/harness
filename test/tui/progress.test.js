import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineDir } from '../support/engine-walk.js';
import { progressBar, stateColor } from '../../src/tui/progress.js';
import { visible } from '../../src/tui/text.js';

// An engine of colorless steps at sequences 0 to 29: black at 0, Done at 29.
const steps = Array.from({ length: 30 }, (_, sequence) => ({ sequence }));
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'))).steps;
const DONE = '\x1b[38;2;58;112;58m';
const rgb = code => code.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/).slice(1).map(Number);
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
// The [width, green] of each colored run in the bar's middle line.
const runs = line => [...line.matchAll(/\x1b\[38;2;\d+;(\d+);\d+m(█+)/g)].map(([, g, bar]) => [bar.length, Number(g)]);

test('a full-width box, three lines tall, over a line of state names', () => {
  const bar = progressBar([{ sequence: 29, count: 1 }], { steps, columns: 12 }).map(strip);
  assert.deepEqual(bar, ['┌──────────┐', '│██████████│', '└──────────┘', '']);
});

test('under the bar, each state\'s name starts where its run starts, cut a column short of the next one\'s', () => {
  const segments = [{ sequence: 0, count: 1, name: 'Plan' }, { sequence: 10, count: 2, name: 'Generate Solution' }, { sequence: 29, count: 1, name: 'Done' }];
  // inner width 16: runs of 4, 8 and 4, starting at columns 1, 5 and 13 (after the border)
  assert.equal(progressBar(segments, { steps, columns: 18 })[3], ' Pla Generat Done');
});

test('on the bar\'s bottom border, a robot per agent, starting where its state\'s run starts', () => {
  const segments = [{ sequence: 0, count: 1, agents: 1 }, { sequence: 10, count: 2, agents: 0 }, { sequence: 29, count: 1, agents: 2 }];
  // inner width 16: runs of 4, 8 and 4, starting at columns 0, 4 and 12
  assert.equal(progressBar(segments, { steps, columns: 18 })[2], '└🤖──────────🤖🤖┘');
});

test('robots that would overlap the next state\'s robots push them right, and the border keeps its width', () => {
  const segments = [{ sequence: 0, count: 1, agents: 3 }, { sequence: 29, count: 1, agents: 5 }];
  const line = progressBar(segments, { steps, columns: 10 })[2];   // runs of 4 and 4
  assert.equal(line, '└🤖🤖🤖🤖┘');                                    // 3 robots, then the next group from column 6, cut at 8
  assert.equal(visible(line), 10);
  assert.equal(progressBar([{ sequence: 0, count: 1, agents: 1 }], { steps, columns: 5 })[2], '└🤖─┘');   // an odd width leaves a dash
});

test('after its robots, a computer per variation at a script step, on the same border; groups that would overlap push right (ASS-237)', () => {
  const segments = [{ sequence: 0, count: 1, scripts: 1 }, { sequence: 10, count: 2, agents: 1, scripts: 2 }, { sequence: 29, count: 1, agents: 1 }];
  // inner width 16: runs of 4, 8 and 4, starting at columns 0, 4 and 12
  assert.equal(progressBar(segments, { steps, columns: 18 })[2], '└💻──🤖💻💻──🤖──┘');
  const pushed = progressBar([{ sequence: 0, count: 1, agents: 1, scripts: 2 }, { sequence: 29, count: 1, scripts: 1 }], { steps, columns: 12 })[2];   // runs of 5 and 5
  assert.equal(pushed, '└🤖💻💻💻──┘');
  assert.equal(visible(pushed), 12);
});

test('each state gets width in proportion to its tickets, Done last', () => {
  const segments = [{ sequence: 0, count: 1 }, { sequence: 29, count: 3 }];
  assert.deepEqual([...progressBar(segments, { steps, columns: 10 })[1].matchAll(/m(█+)/g)].map(([, run]) => run.length), [2, 6]);
});

test('rounding still fills the bar exactly', () => {
  const segments = [1, 2, 3].map(sequence => ({ sequence, count: 1 }));
  const widths = runs(progressBar(segments, { steps, columns: 12 })[1]).map(([w]) => w);
  assert.equal(widths.reduce((a, b) => a + b), 10);
});

test('Done is #3A703A; the further a state is from Done, the darker, black at the furthest', () => {
  const segments = [0, 10, 20, 29].map(sequence => ({ sequence, count: 1 }));
  const line = progressBar(segments, { steps, columns: 42 })[1];
  assert.match(line, /\x1b\[38;2;58;112;58m█+\x1b\[0m/);                // Done, last
  const greens = runs(line).map(([, g]) => g);
  assert.deepEqual(greens, [0, 39, 77, 112]);                           // 112 × 0, 10/29, 20/29, 1
  assert.equal(stateColor({ sequence: 29 }, steps), DONE);
  assert.equal(stateColor({ sequence: 0 }, steps), '\x1b[38;2;0;0;0m');
});

test('the ramp runs from the furthest colorless step to Done, whatever their sequences: steps with their own color are not on it', () => {
  const engine = [{ sequence: 0, color: '#ff0000' }, { sequence: 3 }, { sequence: 4 }, { sequence: 5 }];
  assert.deepEqual([3, 4, 5].map(sequence => stateColor({ sequence }, engine)), ['\x1b[38;2;0;0;0m', '\x1b[38;2;29;56;29m', DONE]);
  assert.equal(stateColor({ sequence: 1 }, engine), '\x1b[38;2;0;0;0m');   // below the furthest: black
  assert.equal(stateColor({ sequence: 5 }, [{ sequence: 5 }]), DONE);      // Done alone
});

for (const name of ['harness-development-v2', 'example-development']) {
  test(`${name}: every colorless top-level state is Done's green scaled down, each channel strictly brighter step by step toward Done; colored states keep their own`, () => {
    const all = engine(name);
    const colorless = all.filter(s => !s.color).toSorted((a, b) => a.sequence - b.sequence);
    const shades = colorless.map(s => rgb(stateColor(s, all)));
    assert.deepEqual(shades[0], [0, 0, 0]);                              // the furthest from Done: black
    assert.deepEqual(shades.at(-1), [58, 112, 58]);                      // Done
    shades.slice(1).forEach((shade, i) => shade.forEach((c, k) => assert.ok(c > shades[i][k], `${colorless[i + 1].id} ${shade} after ${shades[i]}`)));
    for (const s of all.filter(s => s.color)) assert.deepEqual(rgb(stateColor(s, all)), [1, 3, 5].map(i => parseInt(s.color.slice(i, i + 2), 16)));
  });
}

test('a state\'s own color wins, even at Done', () => {
  assert.equal(stateColor({ sequence: 29, color: '#ff0000' }, steps), '\x1b[38;2;255;0;0m');
});

test('a state with a color uses it; states sharing a sequence keep separate runs', () => {
  const segments = [{ sequence: 0, count: 1, color: '#ff0000' }, { sequence: 0, count: 1, color: '#ffd700' }, { sequence: 29, count: 1 }];
  const line = progressBar(segments, { steps, columns: 8 })[1];
  assert.deepEqual([...line.matchAll(/\x1b\[38;2;([\d;]+)m(█+)/g)].map(([, rgb, run]) => [rgb, run.length]), [['255;0;0', 2], ['255;215;0', 2], ['58;112;58', 2]]);
});

test('states with no tickets take no space; no tickets at all is an empty box', () => {
  assert.deepEqual(runs(progressBar([{ sequence: 1, count: 0 }, { sequence: 2, count: 2 }], { steps, columns: 6 })[1]).map(([w]) => w), [4]);
  assert.equal(strip(progressBar([], { steps, columns: 6 })[1]), '│    │');
});

// ASS-260: each run's name carries its change since the snapshot before the day on show.
test('a state\'s name carries its change since the earlier snapshot: "Done +2", "Setup Review -1"; no change, the name alone (ASS-260)', () => {
  const segments = [{ sequence: 0, count: 2, name: 'Setup Review', change: -1 }, { sequence: 10, count: 2, name: 'Plan', change: 0 }, { sequence: 29, count: 2, name: 'Done', change: 2 }];
  // inner width 48: runs of 16 each
  assert.equal(progressBar(segments, { steps, columns: 50 })[3], ` ${'Setup Review -1'.padEnd(16)}${'Plan'.padEnd(16)}Done +2`);
});

test('no change given (no earlier snapshot), or none, shows the name alone, never "+0" (ASS-260)', () => {
  const at = change => progressBar([{ sequence: 29, count: 1, name: 'Done', change }], { steps, columns: 12 })[3];
  assert.equal(at(undefined), ' Done');
  assert.equal(at(null), ' Done');
  assert.equal(at(0), ' Done');
  assert.equal(at(3), ' Done +3');
});

test('a run too narrow for its label keeps the change and shortens the name; the names stay uncolored (ASS-260)', () => {
  const segments = [{ sequence: 0, count: 1, name: 'Setup Review', change: -1 }, { sequence: 29, count: 1, name: 'Done', change: 12 }];
  // inner width 16: runs of 8 and 8; the first label has 7 columns, the last 8
  const line = progressBar(segments, { steps, columns: 18 })[3];
  assert.equal(line, ' Setu -1 Done +12');
  assert.doesNotMatch(line, /\x1b/);
  // room for the change alone: the name goes (runs of 4 and 16, the first label 3 columns)
  assert.equal(progressBar([{ sequence: 0, count: 1, name: 'Setup Review', change: -10 }, { sequence: 29, count: 4, name: 'Done' }], { steps, columns: 22 })[3], ' -10 Done');
  // a name cut at a space drops it: "Setup -1", not "Setup  -1"
  assert.equal(progressBar([{ sequence: 0, count: 1, name: 'Setup Review', change: -1 }, { sequence: 29, count: 1, name: 'Done' }], { steps, columns: 22 })[3], ' Setup -1  Done');
});

// ASS-405
test('ASS-405: the top border carries the total in its right corner, two dashes before it', () => {
  const top = progressBar([{ sequence: 0, count: 20 }, { sequence: 29, count: 2 }], { steps, columns: 26 })[0];
  assert.equal(top, '┌──── 22 total tickets ──┐');
  assert.equal(top.length, 26);
});

test('ASS-405: one ticket reads "1 total ticket"; zero shows no label', () => {
  assert.equal(progressBar([{ sequence: 29, count: 1 }], { steps, columns: 24 })[0], '┌──── 1 total ticket ──┐');
  assert.equal(progressBar([{ sequence: 29, count: 0 }], { steps, columns: 24 })[0], `┌${'─'.repeat(22)}┐`);
  assert.equal(progressBar([], { steps, columns: 24 })[0], `┌${'─'.repeat(22)}┐`);
});

test('ASS-405: a box too narrow for the label draws the plain border', () => {
  assert.equal(progressBar([{ sequence: 29, count: 22 }], { steps, columns: 23 })[0], '┌─ 22 total tickets ──┐');
  assert.equal(progressBar([{ sequence: 29, count: 22 }], { steps, columns: 22 })[0], `┌${'─'.repeat(20)}┐`);
  assert.equal(progressBar([{ sequence: 29, count: 22 }], { steps, columns: 8 })[0], '┌──────┐');
});
