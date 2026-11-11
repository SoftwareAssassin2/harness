import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMergeRequests, openMergeRequestLines, openMergeRequestText, inPlay } from '../../src/tui/merge-requests-summary.js';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { link } from '../../src/tui/text.js';

// ASS-366: the open MRs screen (U) — the sprint's open merge requests grouped
// by ticket, as paste-ready text, from the recorded merge-request rows alone.
const forge = (repo, n) => `https://forge.example.com/acme/${repo}/-/merge_requests/${n}`;
// ASS-367: ready for approval by default (approval-wait-since set). ASS-372: no line says how long it has waited.
const SINCE = '2026-11-11T14:05:00Z';
const mr = (id, repo, n, fields = {}) => ({ id, repository: `https://forge.example.com/acme/${repo}.git`, key: `!${n}`, url: forge(repo, n), status: 'Open', 'depends-on': [], 'approval-wait-since': SINCE, ...fields });
const NOW = new Date('2026-11-11T15:00:00Z');

test('each ticket\'s open merge requests in depends-on order, the ones it waits for after each; the rest left out (ASS-366 AC2, AC3)', () => {
  const groups = openMergeRequests([
    { key: 'EX-12', title: 'Capture parent lineage from source', url: 'https://tickets.example.com/EX-12', variation: { 'merge-request': [
      mr(2, 'ingest', 577, { 'depends-on': [1] }),
      mr(1, 'api', 1005),
      mr(3, 'web', 88, { status: 'Merged' }),
      mr(4, 'web', 89, { status: 'Closed' }),
      { id: 5, repository: 'https://forge.example.com/acme/web', status: 'Not Created', key: null, url: null, 'depends-on': [] },
    ] } },
    { key: 'EX-30', title: 'Nothing open', variation: { 'merge-request': [mr(1, 'api', 900, { status: 'Merged' })] } },
    { key: 'EX-31', title: 'No variation', variation: undefined },
    { key: 'EX-40', title: 'Measure use of downloads', variation: { 'merge-request': [mr(1, 'api', 1019, { 'depends-on': [9] })] } },
  ]);
  assert.deepEqual(groups.map(g => g.key), ['EX-12', 'EX-40']);
  assert.equal(openMergeRequestText(groups, NOW), [
    'Merge requests ready for approval (3), 2026-11-11',
    '',
    'EX-12: Capture parent lineage from source',
    `  - api !1005  ${forge('api', 1005)}`,
    `  - ingest !577  ${forge('ingest', 577)}  (after api !1005)`,
    '',
    'EX-40: Measure use of downloads',
    `  - api !1019  ${forge('api', 1019)}`,
  ].join('\n'));
});

test('a merge request waiting on several is placed after them all, naming each; a cycle keeps list order (ASS-366)', () => {
  const [{ mrs }] = openMergeRequests([{ key: 'EX-1', title: 'T', variation: { 'merge-request': [
    mr(3, 'web', 7, { 'depends-on': [1, 2] }), mr(2, 'lib', 4, { 'depends-on': [1] }), mr(1, 'api', 12),
  ] } }]);
  assert.deepEqual(mrs.map(m => [m.name, m.after]), [['api !12', []], ['lib !4', ['api !12']], ['web !7', ['api !12', 'lib !4']]]);
  const [{ mrs: cycle }] = openMergeRequests([{ key: 'EX-2', title: 'T', variation: { 'merge-request': [
    mr(1, 'api', 1, { 'depends-on': [2] }), mr(2, 'web', 2, { 'depends-on': [1] }),
  ] } }]);
  assert.deepEqual(cycle.map(m => m.name), ['api !1', 'web !2']);
});

test('with none open the text says so; the key is linked for display only and copies plain (ASS-366 AC3, AC4)', () => {
  assert.deepEqual(openMergeRequestLines([], NOW), ['No merge requests ready for approval.']);
  const groups = openMergeRequests([{ key: 'EX-1', title: 'T', url: 'https://tickets.example.com/EX-1', variation: { 'merge-request': [mr(1, 'api', 1)] } }]);
  assert.equal(openMergeRequestLines(groups, NOW)[2], `${link('EX-1', 'https://tickets.example.com/EX-1')}: T`);
  assert.equal(openMergeRequestText(groups, NOW).split('\n')[2], 'EX-1: T');
});

test('the variation in play is the first not set aside (ASS-366 AC2)', () => {
  assert.equal(inPlay({ variations: [{ name: 'A', 'is-deleted': true }, { name: 'B' }] }).name, 'B');
  assert.equal(inPlay({}), undefined);
});

// The screen, through the app.
const strip = s => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const wide = { columns: 200, rows: 44, now: NOW };
const key = name => ({ name, sequence: name.length === 1 ? name : undefined });
const press = (s, ...names) => names.reduce((at, name) => handleKey(at, key(name), wide), s);
const engine = { name: 'example-development', steps: [{ id: 'backlog', name: 'Backlog', sequence: 1 }, { id: 'code-review', name: 'Code Review', sequence: 13 }] };
const ticket = (key, title, priority, mrs, extra = {}) => ({ key, title, priority, url: `https://tickets.example.com/${key}`, variations: [
  ...(extra.setAside ? [{ name: 'A', 'is-deleted': true, 'harness-status': { state: 'code-review', 'state-engine': 'example-development' }, 'merge-request': [mr(1, 'old', 1)] }] : []),
  { name: extra.setAside ? 'B' : 'A', 'harness-status': { state: 'code-review', 'state-engine': 'example-development' }, 'merge-request': mrs },
] });
const sprint = (features, bugs = []) => ({ number: 1, start: '2026-11-01', end: '2026-11-14', features, bugs, spikes: [] });
const stateOf = s => initialState({ projects: [{ id: 'example', name: 'Example', stateEngine: 'example-development', sprint: s, highlights: [{ ticket: 'EX-12', color: '#ffff00' }] }], workflows: [engine] });
const lines = (s, size = wide) => render(s, size).map(strip);

test('U opens the open MRs screen, listed in the menu as your open MRs; the screen keys leave it as they leave updates (ASS-366 AC1)', () => {
  const s = stateOf(sprint([ticket('EX-12', 'Capture parent lineage from source', 2, [mr(1, 'api', 1005)], { setAside: true })], [ticket('EX-40', 'Measure use of downloads', 1, [mr(1, 'api', 1019)])]));
  const open = press(s, 'U');
  assert.deepEqual([open.screen, open.focus], ['U', 'openmrs']);
  const menu = lines(press(s, '?'));
  assert.ok(menu.some(l => /│ U +MRs ready for approval +│/.test(l)));   // ASS-367
  const out = lines(open);
  const at = text => out.findIndex(l => l === text);
  assert.ok(at('Merge requests ready for approval (2), 2026-11-11') > 0);
  assert.ok(out.includes(`  - api !1005  ${forge('api', 1005)}`));
  assert.ok(!out.some(l => l.includes('old !1')));                                 // the set-aside variation's
  assert.ok(at('EX-40: Measure use of downloads') < at('EX-12: Capture parent lineage from source'));   // the sprint's order: by priority here
  assert.equal(press(open, 's').screen, 's');
  assert.equal(press(open, 'u').screen, 'u');
  assert.equal(press(press(s, 'u'), 'U').screen, 'U');
  // A highlighted ticket key is marked on screen, as on the updates screen.
  assert.ok(render(open, wide).some(l => l.includes('\x1b[48;2;255;255;0m\x1b[30mEX-12')));
});

test('with no open merge requests the screen says so (ASS-366 AC3)', () => {
  assert.ok(lines(press(stateOf(sprint([ticket('EX-1', 'T', 1, [mr(1, 'api', 1, { status: 'Merged' })])])), 'U')).includes('No merge requests ready for approval.'));
});

test('up and down scroll text taller than the window, no further than its end (ASS-366 AC5)', () => {
  const many = stateOf(sprint(Array.from({ length: 40 }, (_, i) => ticket(`EX-${i}`, 'T', i, [mr(1, 'api', i)]))));
  const open = press(many, 'U');
  const shown = s => lines(s).filter(l => /^EX-\d+: T$/.test(l)).map(l => l.split(':')[0]);
  assert.equal(shown(open)[0], 'EX-0');
  assert.ok(!shown(open).includes('EX-39'));
  const end = press(open, ...Array(300).fill('down'));
  assert.equal(shown(end).at(-1), 'EX-39');
  assert.equal(press(end, 'down').openMrsScroll, end.openMrsScroll);
  assert.equal(press(end, ...Array(300).fill('up')).openMrsScroll, 0);
});

test('only merge requests ready for approval are listed; a dependency not ready is left unnamed (ASS-367 AC1, AC3)', () => {
  const groups = openMergeRequests([{ key: 'EX-12', title: 'T', variation: { 'merge-request': [
    mr(1, 'api', 10, { 'approval-wait-since': null }),                       // a draft, or feedback being acted on
    mr(2, 'web', 20, { 'depends-on': [1] }),
    mr(3, 'lib', 30, { 'depends-on': [2] }),
    mr(4, 'cli', 40, { 'approval-wait-since': undefined }),                  // not yet set to auto-merge
  ] } }, { key: 'EX-13', title: 'None ready', variation: { 'merge-request': [mr(1, 'api', 11, { 'approval-wait-since': null })] } }]);
  assert.deepEqual(groups.map(g => g.key), ['EX-12']);
  assert.deepEqual(groups[0].mrs.map(m => [m.name, m.after, m.since]), [['web !20', [], SINCE], ['lib !30', ['web !20'], SINCE]]);
  assert.deepEqual(openMergeRequestLines(openMergeRequests([{ key: 'EX-13', title: 'T', variation: { 'merge-request': [mr(1, 'api', 11, { 'approval-wait-since': null })] } }]), NOW),
    ['No merge requests ready for approval.']);
});

test('no merge request line says how long it has waited (ASS-372)', () => {
  const groups = openMergeRequests([{ key: 'EX-12', title: 'T', variation: { 'merge-request': [mr(1, 'api', 10), mr(2, 'web', 20, { 'depends-on': [1] })] } }]);
  const out = openMergeRequestLines(groups, NOW);
  assert.equal(out.filter(l => l.startsWith('  - ')).length, 2);
  assert.ok(!out.some(l => l.includes('waiting since')));
});
