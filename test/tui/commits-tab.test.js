// ASS-558: the ticket screen's Commits tab — every commit of the ticket, per variation, across its repositories,
// from the lists ticket:refresh-commits keeps in work/<KEY>/commits-<variation>.json (load.js loadCommits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState as flagged, handleKey, render } from '../../src/tui/app.js';
import { commitLines, tabsOf, TABS } from '../../src/tui/ticket.js';
import { loadCommits } from '../../src/tui/load.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const NOW = new Date('2026-11-23T12:00:00Z');
const key = (name, extra = {}) => ({ name, ...extra });
const commit = (n, state, extra = {}) => ({
  repository: 'app', sha: `${n}`.repeat(40).slice(0, 40), short: `${n}`.repeat(8), date: `2026-11-2${n % 3}T0${n}:00:00Z`, author: 'Ada Lovelace',
  subject: `ABC-5: change number ${n}`, branch: 'change/ABC-5-1', mr: null, 'mr-url': null, state, url: state === 'local' ? null : `https://gitlab.example.com/g/app/-/commit/${n}`, ...extra,
});
const LIST_A = {
  key: 'ABC-5', variation: 'A', 'refreshed-at': '2026-11-23T11:55:00Z', since: '2026-11-01T00:00:00Z',
  sources: [{ source: 'forge', repository: 'app', ok: true }, { source: 'forge', repository: 'web', ok: false, error: 'gh api repos/o/web: HTTP 502' }],
  commits: [
    commit(1, 'local'), commit(2, 'pushed'),
    commit(3, 'open-mr', { mr: '!12', 'mr-url': 'https://gitlab.example.com/g/app/-/merge_requests/12' }),
    commit(4, 'merged', { repository: 'web', branch: 'main', subject: `Close the account page — ${'a long squash subject '.repeat(6).trim()} (#16)` }),
  ],
};
const LIST_B = { key: 'ABC-5', variation: 'B', 'refreshed-at': '2026-11-23T09:00:00Z', sources: [], commits: [] };

test('ASS-558 AC1: commitLines — per variation, the one on show first: when refreshed, any source not read, then each commit\'s short SHA, date, state, repository and branch or MR, its subject and author beneath', () => {
  const lines = commitLines({ A: LIST_A, B: LIST_B }, { order: ['B', 'A', 'C'], width: 77, now: NOW });
  const plain = lines.map(strip);
  assert.equal(plain[0], 'Variation B — 0 commits · refreshed 2026-11-23 09:00 UTC (3h 0m ago)');
  assert.equal(plain[1], '  no commits for this ticket yet');
  const a = plain.indexOf('Variation A — 4 commits · refreshed 2026-11-23 11:55 UTC (5m 0s ago)');
  assert.ok(a > 1, plain.join('\n'));
  assert.equal(plain[a + 1], '  could not read forge web: gh api repos/o/web: HTTP 502');
  assert.match(lines[a + 1], /^\x1b\[31m/);
  assert.equal(plain[a + 2], '  11111111  2026-11-21 01:00  local only  app · change/ABC-5-1');
  assert.equal(plain[a + 3], '            ABC-5: change number 1 — Ada Lovelace');
  assert.equal(plain[a + 4], '  22222222  2026-11-22 02:00  pushed      app · change/ABC-5-1');
  assert.equal(plain[a + 6], '  33333333  2026-11-20 03:00  open MR     app · !12 change/ABC-5-1');
  assert.equal(plain[a + 8], '  44444444  2026-11-21 04:00  merged      web · main');
  assert.ok(plain[a + 9].startsWith('            Close the account page') && plain[a + 10].startsWith('            '), 'a long subject wraps beneath');
  assert.ok(lines.find(l => strip(l).startsWith('  22222222')).includes('\x1b]8;;https://gitlab.example.com/g/app/-/commit/2\x1b\\22222222'), 'a pushed SHA links to its forge page');
  assert.ok(!/\x1b\]8;;[^\x1b]+\x1b\\11111111/.test(lines.find(l => strip(l).startsWith('  11111111'))), 'a local-only one has none');
  assert.ok(lines.find(l => strip(l).startsWith('  33333333')).includes('\x1b]8;;https://gitlab.example.com/g/app/-/merge_requests/12\x1b\\!12'));
  assert.match(lines.find(l => strip(l).startsWith('  44444444')), /\x1b\[32mmerged/);
  assert.ok(plain.includes('Variation C — not gathered yet'), plain.join('\n'));
  assert.ok(lines.every(l => visible(l) <= 77), lines.filter(l => visible(l) > 77).join('\n'));
});

test('ASS-558 AC4: no list at all and an empty list both say so; every line fits however narrow', () => {
  assert.deepEqual(commitLines({}, { order: ['A'], width: 77, now: NOW }).map(strip).slice(0, 1), ['Variation A — not gathered yet']);
  assert.deepEqual(commitLines({}, { order: [], width: 77, now: NOW }), ['  no commits for this ticket yet']);
  assert.deepEqual(commitLines({ A: { ...LIST_A, sources: [], commits: [] } }, { order: ['A'], width: 77, now: NOW }).map(strip), [
    'Variation A — 0 commits · refreshed 2026-11-23 11:55 UTC (5m 0s ago)', '  no commits for this ticket yet',
  ]);
  for (const width of [30, 50]) assert.ok(commitLines({ A: LIST_A }, { order: ['A'], width, now: NOW }).every(l => visible(l) <= width), `${width}`);
});

test('ASS-558: loadCommits reads each work/<KEY>/commits-<variation>.json, skipping what is not one or not JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-commits-'));
  mkdirSync(join(dir, 'work', 'ABC-5'), { recursive: true });
  mkdirSync(join(dir, 'work', 'ABC-6'), { recursive: true });
  writeFileSync(join(dir, 'work', 'ABC-5', 'commits-A.json'), JSON.stringify(LIST_A));
  writeFileSync(join(dir, 'work', 'ABC-5', 'commits-B.json'), '{ half');
  writeFileSync(join(dir, 'work', 'ABC-5', 'commits-A.json.123.tmp'), '{}');
  writeFileSync(join(dir, 'work', 'ABC-6', 'change-log-A.md'), '#');
  assert.deepEqual(loadCommits(dir), { 'ABC-5': { A: LIST_A } });
  assert.deepEqual(loadCommits(join(dir, 'none')), {});
});

// ── On the screen ──
const steps = [
  { id: 'build', name: 'Build', sequence: 3, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 9, 'is-done': true, action: { type: 'none' } },
];
const variation = name => ({ name, 'harness-status': { state: 'build', 'state-engine': 'e' }, 'state-changes': [], 'merge-request': [] });
function opened({ chat = false, commits = { 'ABC-5': { A: LIST_A, B: LIST_B } }, size } = {}) {
  const project = { id: 'example', name: 'Example', stateEngine: 'e', commits, backlog: [], questions: [], days: {},
    sprint: { number: 14, start: '2026-11-17', end: '2026-11-30', features: [{ key: 'ABC-5', title: 'Close the account', variations: [variation('A'), variation('B')] }], bugs: [], spikes: [] } };
  const s = { ...flagged({ projects: [project], workflows: [{ name: 'e', steps }], features: { 'ticket-chat-tab': chat } }), focus: 'tickets' };
  return handleKey(s, key('return'), size);
}
const sized = columns => ({ columns, rows: 60, now: NOW });
const press = (s, size, ...names) => names.reduce((st, name) => handleKey(st, key(name, name.length === 1 ? { sequence: name } : {}), size), s);
const lines = (s, size) => render(s, size).map(strip);
const tabText = (out, columns) => { const top = out.findIndex(l => /^┌ ?1 Actions/.test(l)); const end = out.findIndex((l, i) => i > top && l.startsWith('└')); return out.slice(top + 1, end).map(l => l.slice(2, columns - 40 - 1).trimEnd()); };

test('ASS-558 AC1/AC4: the Commits tab — last, 6 without Chat and 7 with it — shows the variation on show first, then the others; its key line says how it scrolls', () => {
  const size = sized(120);
  assert.deepEqual(TABS.at(-2), ['commits', 'Commits']);   // ASS-559: Acceptance criteria after it
  assert.equal(tabsOf(false).findIndex(([id]) => id === 'commits') + 1, 6);
  assert.equal(tabsOf(true).findIndex(([id]) => id === 'commits') + 1, 7);
  const open = press(opened({ size }), size, '6');
  assert.equal(open.ticketTab, 'commits');
  assert.equal(press(opened({ chat: true, size }), size, 'tab', '7').ticketTab, 'commits');
  const out = lines(open, size);
  assert.match(out.find(l => /^┌ ?1 Actions/.test(l)), /6 Commits/);
  assert.ok(out.some(l => l.startsWith('esc returns to the sprint   tab or 1-7 switch tabs   ↑/↓ scroll the commits   PgUp/PgDn page')), out.join('\n'));
  const text = tabText(out, 120);
  assert.match(text[0], /^Variation A — 4 commits · refreshed 2026-11-23 11:55 UTC \(5m 0s ago\)/);
  assert.ok(text.some(l => /^Variation B — 0 commits/.test(l)), text.join('\n'));
  assert.ok(render(open, size).every(l => visible(l) <= 120), 'nothing wider than 120 columns');
  for (const columns of [100, 96]) assert.ok(render(press(opened({ size: sized(columns) }), sized(columns), '6'), sized(columns)).every(l => visible(l) <= columns), `${columns}`);
});

test('ASS-558 AC4: ↑/↓ scroll the Commits tab, no further than its end, and PgUp/PgDn page it; it keeps its place across tabs', () => {
  const size = { columns: 120, rows: 40, now: NOW };
  const many = { ...LIST_A, commits: Array.from({ length: 30 }, (_, i) => commit((i % 9) + 1, 'pushed', { sha: `${i}`.padStart(40, '0'), short: `c${String(i).padStart(7, '0')}` })) };
  const open = press(opened({ commits: { 'ABC-5': { A: many } }, size }), size, '6');
  const down = press(open, size, 'down', 'down');
  assert.equal(down.ticketCommitsScroll, 2);
  assert.equal(press(down, size, 'up', 'up', 'up').ticketCommitsScroll, 0);
  const paged = press(open, size, 'pagedown');
  assert.ok(paged.ticketCommitsScroll > 2, `${paged.ticketCommitsScroll}`);
  const end = press(open, size, ...Array(200).fill('down'));
  assert.equal(press(end, size, 'down').ticketCommitsScroll, end.ticketCommitsScroll);   // no further than its end
  assert.ok(tabText(lines(end, size), 120).some(l => l.startsWith('Variation B — not gathered yet')));
  const back = press(press(down, size, '2'), size, '6');
  assert.equal(back.ticketCommitsScroll, 2);
});

test('ASS-558 AC4: a ticket with no commits says so on the tab', () => {
  const size = sized(120);
  const s = press(opened({ commits: { 'ABC-5': { A: { ...LIST_A, sources: [], commits: [] } } }, size }), size, '6');
  const text = tabText(lines(s, size), 120);
  assert.deepEqual(text.slice(0, 2), ['Variation A — 0 commits · refreshed 2026-11-23 11:55 UTC (5m 0s ago)', '  no commits for this ticket yet']);
});
