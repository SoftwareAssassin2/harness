// ASS-559: the ticket screen's Acceptance criteria tab — each criterion of the variation on show with its dev and
// testing status (green Passed, red Failed, gray otherwise, as the sprint screen's Dev and Testing dots were) and where
// the evidence is (test-results-<var>.md, code-review-<var>.md, change-log-<var>.md in the work folder); the sprint
// screen lost its Dev and Testing columns for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { criteriaLines, tabsOf, TABS, tabBar } from '../../src/tui/ticket.js';
import { loadReviews } from '../../src/tui/review.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const NOW = new Date('2026-11-23T12:00:00Z');
const key = (name, extra = {}) => ({ name, ...extra });
const CRITERIA = [
  { 'criteria-number': 1, description: 'The sprint screen has no Dev or Testing column.', 'dev-status': 'Passed', 'testing-status': 'Failed' },
  { 'criteria-number': 2, description: `A long criterion: ${'it wraps beneath its statuses '.repeat(5).trim()}.`, 'dev-status': 'Failed', 'testing-status': 'Incomplete' },
  { 'criteria-number': 3, description: 'Not looked at yet.' },
];
const TESTS = { 'number-of-relevant-automated-tests': 83, 'number-of-passing-relevant-automated-tests': 37 };
const variation = (name, extra = {}) => ({ name, 'harness-status': { state: 'build', 'state-engine': 'e' }, 'acceptance-criteria': CRITERIA, 'local-testing': TESTS, ...extra });

test('ASS-559 AC1: criteriaLines — every criterion with its dev and testing status, green, red or gray, its description beneath', () => {
  const lines = criteriaLines(variation('A'), { width: 77 });
  const plain = lines.map(strip);
  assert.equal(plain[0], '  1   dev ● Passed      testing ● Failed');
  assert.equal(plain[1], '      The sprint screen has no Dev or Testing column.');
  assert.match(lines[0], /\x1b\[32m● Passed\x1b\[0m/);
  assert.match(lines[0], /\x1b\[31m● Failed\x1b\[0m/);
  const two = plain.findIndex(l => l.startsWith('  2 '));
  assert.equal(plain[two], '  2   dev ● Failed      testing ● Incomplete');
  assert.match(lines[two], /\x1b\[90m● Incomplete\x1b\[0m/);
  assert.ok(plain[two + 2].startsWith('      '), 'a long description wraps beneath, indented');
  const three = plain.findIndex(l => l.startsWith('  3 '));
  assert.equal(plain[three], '  3   dev ● Not started testing ● Not started');
  assert.match(lines[three], /\x1b\[90m● Not started\x1b\[0m/);
  assert.ok(plain.includes('Automated tests: 37/83 passing'), 'the tally the sprint screen\'s Dev column carried');
  for (const width of [40, 77]) assert.ok(criteriaLines(variation('A'), { width }).every(l => visible(l) <= width), `${width}`);
  assert.deepEqual(criteriaLines({ name: 'A' }, { width: 77 }).map(strip).slice(0, 3), ['  no acceptance criteria', '', 'Automated tests: —']);
});

test('ASS-559 AC1: where the evidence is — test results for testing, code review and change log for dev — linked when written, else named "not written yet"', () => {
  const evidence = { 'test-results-B.md': '/w/ABC-5/test-results-B.md', 'change-log-B.md': '/w/ABC-5/change-log-B.md' };
  const lines = criteriaLines(variation('B'), { width: 77, evidence });
  const plain = lines.map(strip);
  const at = plain.indexOf('Evidence');
  assert.deepEqual(plain.slice(at + 1, at + 4), [
    '  testing status  test-results-B.md',
    '  dev status      code-review-B.md (not written yet)',
    '  dev status      change-log-B.md',
  ]);
  assert.ok(lines[at + 1].includes(`\x1b]8;;${pathToFileURL('/w/ABC-5/test-results-B.md').href}\x1b\\test-results-B.md`), 'linked to its file');
  assert.match(lines[at + 2], /\x1b\[90mcode-review-B\.md \(not written yet\)/);
});

test('ASS-559: loadReviews lists the evidence files of each work folder, only when there is one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ass559-'));
  mkdirSync(join(dir, 'work', 'ABC-5'), { recursive: true });
  mkdirSync(join(dir, 'work', 'ABC-6'), { recursive: true });
  for (const f of ['test-results-A.md', 'code-review-A.md', 'change-log-A.md', 'code-review-review-A.md']) writeFileSync(join(dir, 'work', 'ABC-5', f), 'x');
  writeFileSync(join(dir, 'work', 'ABC-6', 'explanation-A.md'), 'Why');
  const reviews = loadReviews(dir);
  assert.deepEqual(Object.keys(reviews['ABC-5'].evidence).toSorted(), ['change-log-A.md', 'code-review-A.md', 'test-results-A.md']);
  assert.equal(reviews['ABC-5'].evidence['test-results-A.md'], join(dir, 'work', 'ABC-5', 'test-results-A.md'));
  assert.equal(reviews['ABC-6'].evidence, undefined);
});

// The ticket screen, opened on ABC-5 (two variations) with the project's reviews' evidence.
function opened({ chat = false, evidence = {}, size } = {}) {
  const steps = [{ id: 'build', name: 'Build', sequence: 3, action: { type: 'prompt' } }, { id: 'done', name: 'Done', sequence: 9, 'is-done': true, action: { type: 'none' } }];
  const project = { id: 'example', name: 'Example', stateEngine: 'e', backlog: [], questions: [], days: {}, reviews: { 'ABC-5': { evidence } },
    sprint: { number: 14, start: '2026-11-17', end: '2026-11-30', features: [{ key: 'ABC-5', title: 'Close the account', variations: [variation('A'), variation('B', { 'acceptance-criteria': [CRITERIA[2]] })] }], bugs: [], spikes: [] } };
  const s = { ...initialState({ projects: [project], workflows: [{ name: 'e', steps }], features: { 'ticket-chat-tab': chat } }), focus: 'tickets' };
  return handleKey(s, key('return'), size);
}
const sized = columns => ({ columns, rows: 60, now: NOW });
const press = (s, size, ...names) => names.reduce((st, name) => handleKey(st, key(name, name.length === 1 ? { sequence: name } : {}), size), s);
const lines = (s, size) => render(s, size).map(strip);

test('ASS-559 AC1: the Acceptance criteria tab — last, 7 without Chat and 8 with it — shows the variation on show\'s criteria and evidence; listed in the screen\'s help', () => {
  assert.deepEqual(TABS.at(-1), ['criteria', 'Acceptance criteria']);
  assert.equal(tabsOf(false).findIndex(([id]) => id === 'criteria') + 1, 7);
  assert.equal(tabsOf(true).findIndex(([id]) => id === 'criteria') + 1, 8);
  const size = sized(120);
  const open = press(opened({ size, evidence: { 'test-results-A.md': '/w/test-results-A.md' } }), size, '7');
  assert.equal(open.ticketTab, 'criteria');
  assert.equal(press(opened({ chat: true, size }), size, 'tab', '8').ticketTab, 'criteria');   // off Chat first: there a digit is text
  const out = lines(open, size);
  assert.match(out.find(l => /^┌ ?1 Actions/.test(l)), /7 Criteria/);   // 120 columns: its short label
  assert.ok(out.some(l => l.startsWith('esc returns to the sprint   tab or 1-7 switch tabs   ↑/↓ scroll the acceptance criteria   PgUp/PgDn page')), out.join('\n'));
  assert.ok(out.some(l => l.includes('1   dev ● Passed      testing ● Failed')), out.join('\n'));
  assert.ok(out.some(l => l.includes('testing status  test-results-A.md')));
  assert.ok(render(open, size).every(l => visible(l) <= 120), 'nothing wider than 120 columns');
  // Variation B on show: its own criteria.
  const b = press(handleKey(press(opened({ size }), size, 'escape'), key('down'), size), size, 'return', '7');
  assert.ok(lines(b, size).some(l => l.includes('3   dev ● Not started')), lines(b, size).join('\n'));
  assert.match(strip(tabBar('criteria', 200)), /8 Acceptance criteria/);
});

test('ASS-559 AC1: the Details tab no longer lists the criteria — it says how many and where; ↑/↓ and PgUp/PgDn scroll the tab', () => {
  const size = sized(120);
  const details = lines(press(opened({ size }), size, '2'), size).join('\n');
  assert.match(details, /Acceptance criteria +3 — see the Acceptance criteria tab/);
  assert.ok(!details.includes('The sprint screen has no Dev or Testing column.'));
  const many = Array.from({ length: 40 }, (_, i) => ({ 'criteria-number': i + 1, description: `Criterion ${i + 1}`, 'dev-status': 'Passed' }));
  const s = opened({ size });
  s.projects[0].sprint.features[0].variations[0]['acceptance-criteria'] = many;
  const tab = press(s, size, '7');
  const down = press(tab, size, 'down', 'down');
  assert.equal(down.ticketCriteriaScroll, 2);
  assert.ok(press(tab, size, 'pagedown').ticketCriteriaScroll > 2);
  const end = press(tab, size, ...Array(200).fill('down'));
  assert.equal(press(end, size, 'down').ticketCriteriaScroll, end.ticketCriteriaScroll);   // no further than its end
  assert.ok(lines(end, size).some(l => l.includes('change-log-A.md')), 'its last lines in view');
});
