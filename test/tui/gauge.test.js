// ASS-572: gauge() — a machine's use as a bar of its whole, the │ at the harness's limit, colored by headroom (green
// well under, amber within 10 points, red over), gray when stale; tone() the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gauge, tone, AMBER_POINTS } from '../../src/tui/gauge.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const GREEN = '\x1b[32m', RED = '\x1b[31m', GRAY = '\x1b[90m', AMBER = '\x1b[38;2;255;176;0m';

test('ASS-572: a gauge is exactly its width: the use filled, the rest empty, the limit marked', () => {
  assert.equal(strip(gauge({ used: 25, total: 100, limit: 80, width: 20 })), '█████░░░░░░░░░░░│░░░');
  assert.equal(strip(gauge({ used: 0, total: 100, limit: 50, width: 10 })), '░░░░░│░░░░');
  assert.equal(strip(gauge({ used: 1, total: 100, width: 10 })), '█░░░░░░░░░', 'any use at all shows a cell; no limit, no │');
  assert.equal(strip(gauge({ used: 150, total: 100, limit: 90, width: 10 })), '█████████│', 'over the whole: full, the │ still drawn');
  assert.equal(strip(gauge({ used: 50, total: 100, limit: 100, width: 10 })), '█████░░░░│', 'a limit at the whole: the last cell');
  assert.equal(strip(gauge({ used: null, total: 100, width: 8 })), '░░░░░░░░', 'nothing known: empty');
  for (const width of [1, 8, 17, 40]) assert.equal(visible(gauge({ used: 33, total: 100, limit: 90, width })), width);
});

test('ASS-572: colored by headroom — green well under the limit, amber within 10 points, red over; gray when stale', () => {
  assert.equal(AMBER_POINTS, 10);
  assert.equal(tone(50, 90, 100), 'green');
  assert.equal(tone(81, 90, 100), 'amber');
  assert.equal(tone(90, 90, 100), 'amber', 'at the limit: not over');
  assert.equal(tone(91, 90, 100), 'red');
  assert.equal(tone(12.9, 14.0, 15.6), 'amber', 'points of the total: 1.1 of 15.6 GiB is 7');
  assert.equal(tone(50, null, 100), 'green', 'no limit known');
  assert.ok(gauge({ used: 50, total: 100, limit: 90, width: 10 }).startsWith(`${GREEN}█████`));
  assert.ok(gauge({ used: 85, total: 100, limit: 90, width: 10 }).startsWith(`${AMBER}█`));
  assert.ok(gauge({ used: 95, total: 100, limit: 90, width: 10 }).startsWith(`${RED}█`));
  assert.ok(gauge({ used: 50, total: 100, limit: 90, width: 10, tone: 'red' }).startsWith(`${RED}█`), 'a tone given wins');
  const stale = gauge({ used: 95, total: 100, limit: 90, width: 10, stale: true });
  assert.ok(!stale.includes(RED) && !stale.includes(GREEN) && stale.includes(GRAY), stale);
  // The empty part is gray, the │ plain.
  const g = gauge({ used: 20, total: 100, limit: 50, width: 10 });
  assert.ok(g.includes(`${GRAY}░`) && g.includes('\x1b[0m│'), JSON.stringify(g));
});
