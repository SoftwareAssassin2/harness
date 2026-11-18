// ASS-439: a Blocked tab on the ticket screen, second, while the variation is
// at Blocked or Blocked for Human (any engine's: its quarantine steps by id and
// area, blockedSteps) — why it is blocked and, at Blocked for Human, the ways
// out, recorded as the Actions tab records them; Actions keeps the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState as flagged, handleKey, render } from '../../src/tui/app.js';
import { tabsOf, tabNumber, needsYou, defaultTab, quickLines, ticketLines, blockedSteps, blockedOf, blockedLines, gateTab, TABS } from '../../src/tui/ticket.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 60, now: new Date('2026-11-14T22:00:00Z') };
const key = (name, extra = {}) => ({ name, ...extra });
const press = (s, ...names) => names.reduce((st, name) => handleKey(st, key(name, name.length === 1 ? { sequence: name } : {}), wide), s);
const lines = (s, size = wide) => render(s, size).map(strip);

// A grouped-style engine: Build, Human Review and Done in the pipeline; Blocked (a sub-engine), Blocked for Human
// (the blocked state, a human step) and Self Healing (quarantine, but no block) beside it.
const steps = [
  { id: 'build', name: 'Build', sequence: 3, action: { type: 'prompt' } },
  { id: 'human-review', name: 'Human Review', sequence: 5, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'done' }] },
  { id: 'done', name: 'Done', sequence: 9, 'is-done': true, action: { type: 'none' } },
  { id: 'blocked-for-human', name: 'Blocked for Human', sequence: 0, area: 'quarantine', 'follow-return-to-state': true, 'is-blocked-state': true, action: { type: 'human', instructions: 'Resolve the block so work can continue on this ticket.' },
    'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }, { condition: { 'human-review': 'Have AI Try Again to Unblock this Ticket' }, 'move-to-state': 'blocked' }] },
  { id: 'blocked', name: 'Blocked', sequence: 0, area: 'quarantine', 'follow-return-to-state': true, 'append-output-to': 'blocks', action: { type: 'state-engine', engine: 'gb' } },
  { id: 'self-healing', name: 'Self Healing', sequence: 0, area: 'quarantine', 'return-to-state': 'self-healing', action: { type: 'state-engine', engine: 'shf' } },
];
const gb = { name: 'gb', steps: [
  { id: 'count-attempts', name: 'Count the Fix Attempts', sequence: 1, action: { type: 'script' } },
  { id: 'troubleshoot', name: 'Troubleshoot', sequence: 2, action: { type: 'prompt' } },
  { id: 'classify', name: 'Classify', sequence: 3, action: { type: 'prompt' } },
  { id: 'await-fix', name: 'Await the Fix', sequence: 4, action: { type: 'script' } },
  { id: 'repair-vm', name: 'Repair the VM and Its Source', sequence: 5, action: { type: 'prompt' } },
  { id: 'mystery', name: 'A Step of Its Own', sequence: 6, action: { type: 'script' } },
  { id: 'blocked-for-human', name: 'Blocked for Human', sequence: 9, action: { type: 'none' } },
] };
const hs = (state, sub) => ({ state, 'state-engine': 'e', ...(sub ? { 'sub-status': { state: sub, 'state-engine': 'gb' } } : {}) });
const move = (from, to, timestamp, extra = {}) => ({ 'from-state': from, 'to-state': to, timestamp, 'agent-dispatch-log': [], ...extra });
const within = (at, timestamp) => ({ ...move(at, at, timestamp), 'sub-state-change': { 'state-engine': 'gb', 'from-state': null, 'to-state': 'troubleshoot' } });
// Into Build, blocked there at 18:00, Blocked for Human at 19:30.
const history = [move('plan', 'build', '2026-11-14T10:00:00Z'), move('build', 'blocked', '2026-11-14T18:00:00Z'), within('blocked', '2026-11-14T18:00:01Z'), move('blocked', 'blocked-for-human', '2026-11-14T19:30:00Z')];

// Two earlier blocks, from other stays, and the one that sent it to the operator (an own-branch, project classify).
const EARLIER = [
  { timestamp: '2026-11-11T16:36:37Z', 'came-from': 'build/blocked', summary: 'A stale docker volume and a renamed test file', issue: 'harness', key: 'ASS-353', 'waits-on': { project: 'harness', ticket: 'ASS-353' }, landed: true, 'ended-at': 'done', run: 'r1' },
  { timestamp: '2026-11-12T09:00:00Z', 'came-from': 'build/ci-checks', summary: 'bats missing on the golden image', issue: 'image', 'ended-at': 'done', run: 'r2' },
];
const OWN = {
  timestamp: '2026-11-14T19:29:59Z', 'came-from': 'build/automated-testing', run: 'r3', 'ended-at': 'blocked-for-human', 'fix-attempts': 2,
  summary: 'The billing reconciler integration test records no subscription invoice',
  'root-cause': 'The test Worker leaves Subscription nil, so worker.go skips RecordSubscriptionInvoice.',
  issue: 'project', 'own-branch': true, 'own-branch-why': 'the branch adds postgres_integration_test.go', 'own-branch-source': 'branch',
  'merge-request-planned': { id: 3, repository: 'https://gitlab.example.com/group/example-project.git', branch: 'change/ABC-1770-5', base: 'master' },
  'failing-repository': 'https://gitlab.example.com/group/example-project', 'failing-file': 'apps/billing-reconciler/postgres_integration_test.go',
  'failing-assertion': 'no row in billing.stripe_subscription_invoice', 'on-master': false, 'master-evidence': 'master pipeline 4410 passed the job',
  'human-action': 'Give the test Worker a Subscription, then choose Resolved.',
  'sandbox-refused': ['work:append'],
};
const variation = fields => ({ name: 'A', 'state-changes': history, ...fields });
const ticket = fields => ({ key: 'ABC-1770', title: 'Reconcile Stripe invoices', priority: 1, variations: [variation(fields)] });
const HOLD = { since: '2026-11-14T15:00:00Z', problems: [{ credential: 'the glab login (gitlab.example.com)', problem: 'glab is not authenticated', fix: 'glab auth login --hostname gitlab.example.com' }] };

function opened(fields, { chat = false, runs = [], hold = null, extra = {} } = {}) {
  const project = { id: 'example', name: 'Example', stateEngine: 'e', sprint: { number: 14, start: '2026-11-04', end: '2026-11-17', features: [ticket(fields)], bugs: [], spikes: [] }, backlog: [], questions: [], days: {}, credentialsHold: hold, ...extra };
  const s = { ...flagged({ projects: [project], workflows: [{ name: 'e', steps }, gb], transientEngines: runs, features: { 'ticket-chat-tab': chat } }), focus: 'tickets' };
  return press(s, 'return');
}
const atHuman = (fields = {}, options) => opened({ 'harness-status': hs('blocked-for-human'), blocks: [...EARLIER, OWN], ...fields }, options);
const atBlocked = (sub, output, fields = {}, options = {}) => opened({ 'harness-status': hs('blocked', sub), blocks: EARLIER, 'state-changes': history.slice(0, 3), ...fields },
  { ...options, runs: [{ id: 'run-9', project: 'example', 'state-engine': 'gb', state: sub, parent: { 'work-item': 'ABC-1770', variation: 'A', 'state-engine': 'e', state: 'blocked' }, 'structured-output': output }] });
const atBuild = options => opened({ 'harness-status': hs('build'), blocks: EARLIER }, options);
const bar = out => out.find(l => /^┌ 1 Actions/.test(l));
const tabText = out => { const top = out.findIndex(l => /^┌ 1 Actions/.test(l)); const end = out.findIndex((l, i) => i > top && l.startsWith('└')); return out.slice(top + 1, end).map(l => l.slice(2, 200 - 40 - 1).trimEnd()); };

// The same ticket on an engine whose blocked steps are not quarantine: no Blocked tab, the choices on Actions as before ASS-439.
const unquarantined = () => steps.map(s => (s.area === 'quarantine' && s.id !== 'self-healing' ? { ...s, area: undefined } : s));
function openedOn(engineSteps, fields) {
  const project = { id: 'example', name: 'Example', stateEngine: 'e', sprint: { number: 14, start: '2026-11-04', end: '2026-11-17', features: [ticket(fields)], bugs: [], spikes: [] }, backlog: [], questions: [], days: {} };
  return press({ ...flagged({ projects: [project], workflows: [{ name: 'e', steps: engineSteps }, gb], features: { 'ticket-chat-tab': false } }), focus: 'tickets' }, 'return');
}
const NO_BLOCK = '┌ 1 Actions( ●)? │ 2 Details │ 3 Merge requests │ 4 History │ 5 Questions';

test('ASS-439 AC1: a Blocked tab second, right after Actions, at Blocked and at Blocked for Human; every later tab one number on, with and without Chat', () => {
  assert.match(bar(lines(atHuman())), /^┌ 1 Actions │ 2 Blocked ● │ 3 Details │ 4 Merge requests │ 5 History │ 6 Questions ─/);
  assert.match(bar(lines(atHuman({}, { chat: true }))), /^┌ 1 Actions │ 2 Blocked ● │ 3 Details │ 4 Merge requests │ 5 History │ 6 Questions │ 7 Chat ─/);
  assert.match(bar(lines(atBlocked('troubleshoot', null))), /^┌ 1 Actions │ 2 Blocked │ 3 Details │ 4 Merge requests │ 5 History │ 6 Questions ─/);
  assert.match(bar(lines(atBlocked('troubleshoot', null, {}, { chat: true }))), /^┌ 1 Actions │ 2 Blocked │ 3 Details │ 4 Merge requests │ 5 History │ 6 Questions │ 7 Chat ─/);
  assert.deepEqual(tabsOf(true, true).map(([, label]) => label), ['Actions', 'Blocked', 'Details', 'Merge requests', 'History', 'Questions', 'Chat']);
  assert.deepEqual(tabsOf(false, true).map(([, label]) => label), ['Actions', 'Blocked', 'Details', 'Merge requests', 'History', 'Questions']);
});

test('ASS-439 AC1: at any other step — the pipeline, Self Healing (quarantine, but no block) — no Blocked tab and the numbering as without it', () => {
  assert.match(bar(lines(atBuild())), new RegExp(`^${NO_BLOCK} ─`));
  assert.match(bar(lines(atBuild({ chat: true }))), /^┌ 1 Actions │ 2 Details │ 3 Merge requests │ 4 History │ 5 Questions │ 6 Chat ─/);
  assert.match(bar(lines(opened({ 'harness-status': hs('self-healing') }))), new RegExp(`^${NO_BLOCK} ─`));
  assert.deepEqual(tabsOf(true), TABS);
  assert.deepEqual(tabsOf(false).map(([id]) => id), ['actions', 'details', 'merges', 'history', 'questions']);
  assert.match(bar(lines(openedOn(unquarantined(), { 'harness-status': hs('blocked-for-human'), blocks: [OWN] }))), new RegExp(`^${NO_BLOCK} ─`));
});

test('ASS-439 AC1: the blocked steps are told by id and area, never by name — another engine\'s, renamed, are found; a pipeline step named Blocked is not', () => {
  const renamed = [
    { id: 'build', name: 'Blocked', sequence: 3, action: { type: 'prompt' } },
    { id: 'held', name: 'Needs a Person', sequence: 0, area: 'quarantine', 'is-blocked-state': true, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Retry' }, 'move-to-state': 'unsticking' }] },
    { id: 'unsticking', name: 'Unsticking', sequence: 0, area: 'quarantine', action: { type: 'state-engine', engine: 'gb' } },
    { id: 'self-healing', name: 'Self Healing', sequence: 0, area: 'quarantine', action: { type: 'state-engine', engine: 'shf' } },
  ];
  assert.deepEqual(blockedSteps(renamed).map(s => s.id), ['held', 'unsticking']);
  assert.deepEqual(blockedSteps(steps).map(s => s.id), ['blocked-for-human', 'blocked']);
  const on = id => openedOn(renamed, { 'harness-status': hs(id) });
  assert.match(bar(lines(on('held'))), /^┌ 1 Actions │ 2 Blocked ● │ 3 Details/);
  assert.match(bar(lines(on('unsticking'))), /^┌ 1 Actions │ 2 Blocked │ 3 Details/);
  assert.match(bar(lines(on('build'))), new RegExp(`^${NO_BLOCK} ─`));
});

test('ASS-439 AC1: the number keys open the tabs by the numbers shown — 2 Blocked, 3 Details while blocked; 2 Details otherwise — and tab steps through Blocked', () => {
  const s = atHuman();
  assert.deepEqual(['1', '2', '3', '4', '5', '6'].map(n => press(s, n).ticketTab), ['actions', 'blocked', 'details', 'merges', 'history', 'questions']);
  assert.equal(press(s, '7').ticketTab, s.ticketTab);   // no 7th tab without Chat
  assert.equal(press(atHuman({}, { chat: true }), '7').ticketTab, 'chat');
  assert.equal(press(press(s, '1'), 'tab').ticketTab, 'blocked');
  assert.deepEqual(['1', '2', '3'].map(n => press(atBuild(), n).ticketTab), ['actions', 'details', 'merges']);
});

test('ASS-439 AC1: every tab number in text follows the tabs shown — Needs you, open questions, the panel\'s "+n more"', () => {
  const blocked = tabsOf(false, true), plain = tabsOf(false);
  const gate = { step: steps[3], choices: [{ decision: 'Resolved' }] };
  assert.equal(needsYou(gate, 0, blocked), 'Blocked for Human — tab 2');
  assert.equal(needsYou(gate, 0, plain), 'Blocked for Human — tab 1');
  assert.equal(needsYou({ ...gate, title: 'Pending requirements change' }, 0, blocked), 'Requirements changed — tab 1');   // not the block's: on Actions
  assert.equal(needsYou({ ...gate, held: true }, 0, blocked), 'Blocked for Human — tab 1');   // a move held at a leaving-gate: Approve, on Actions
  assert.equal(needsYou(null, 2, blocked), '2 open questions — tab 6');
  assert.equal(needsYou(null, 2, plain), '2 open questions — tab 5');
  assert.equal(gateTab(gate, blocked), 'blocked');
  assert.equal(gateTab(gate, plain), 'actions');
  assert.equal(tabNumber(tabsOf(true, true), 'chat'), 7);
  const mrs = Array.from({ length: 5 }, (_, i) => ({ key: `!${i}`, url: `http://mr/${i}`, status: 'Open', 'build-status': 'Running' }));
  const more = tabs => quickLines({ key: 'K-1', title: 'T', variation: { 'merge-request': mrs } }, { tabs, now: wide.now }).map(strip).find(l => l.includes('more'));
  assert.equal(more(blocked), '     +2 more — tab 4');
  assert.equal(more(plain), '     +2 more — tab 3');
  // On the screen: Needs you names tab 2 at Blocked for Human; the open questions tab 6 at Blocked.
  assert.ok(lines(atHuman()).some(l => l.includes('Needs you: Blocked for Human — tab 2')));
  const asked = atBlocked('troubleshoot', null, {}, { extra: { questions: [{ 'asked-on-ticket': 'ABC-1770', question: 'Which?', 'answer-status': 'Unanswered' }] } });
  assert.ok(lines(asked).some(l => l.includes('Needs you: 1 open question — tab 6')), lines(asked).join('\n'));
});

test('ASS-439 AC2: the ticket screen opens on the Blocked tab when the variation is blocked, its key hint naming it; elsewhere as before', () => {
  assert.equal(atHuman().ticketTab, 'blocked');
  assert.equal(atBlocked('classify', null).ticketTab, 'blocked');
  assert.equal(atHuman({}, { chat: true }).ticketTab, 'blocked');
  assert.notEqual(atBuild().ticketTab, 'blocked');
  assert.equal(defaultTab(null, 0, false, true), 'blocked');
  assert.equal(defaultTab({ choices: [{}] }, 3, true, true), 'blocked');
  assert.equal(defaultTab(null, 0, false), 'details');
  const hint = s => lines(s).find(l => l.startsWith('esc returns to the sprint'));
  assert.match(hint(atHuman()), /tab or 1-6 switch tabs {3}↑\/↓ choose how to resolve the block {3}enter records the choice {3}PgUp\/PgDn scroll/);
  assert.match(hint(atBlocked('classify', null)), /tab or 1-6 switch tabs {3}↑\/↓ scroll why it is blocked/);
  assert.match(hint(atHuman({}, { chat: true })), /tab or 1-7 switch tabs/);
});

test('ASS-439 AC3: at Blocked for Human, top to bottom — where and since when, summary and root cause, what Classify found (own branch), attempts, the human action in red, the earlier blocks newest first', () => {
  const out = tabText(lines(atHuman()));
  const order = ['Blocked for you   at Build: it goes back there once resolved', 'Since             2026-11-14 18:00 UTC (4h 0m)',
    'Summary           The billing reconciler integration test records no subscription invoice',
    'Root cause        The test Worker leaves Subscription nil, so worker.go skips RecordSubscriptionInvoice.',
    'Issue             project', 'Repository        https://gitlab.example.com/group/example-project', 'File              apps/billing-reconciler/postgres_integration_test.go',
    'Assertion         no row in billing.stripe_subscription_invoice',
    'Own code          yes: the ticket\'s own branch — the branch adds postgres_integration_test.go',
    'Own-branch fix    planned MR 3 in example-project from change/ABC-1770-5 into master',
    'Master            on master: no — master pipeline 4410 passed the job',
    'Fix attempts      2 of 3', 'Human action      Give the test Worker a Subscription, then choose Resolved.',
    'Sandbox refused   work:append: its agent.sh write was refused',
    'Earlier blocks (newest first)',
    '  2026-11-12 09:00  build/ci-checks  image: bats missing on the golden image — resumed',
    '  2026-11-11 16:36  build/blocked  harness: A stale docker volume and a renamed test file — resumed'];
  const at = order.map(l => out.indexOf(l));
  assert.ok(at.every(i => i >= 0), `${order.filter((l, k) => at[k] < 0).join('\n')}\n---\n${out.join('\n')}`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.ok(!out.some(l => /^(Now|Waiting on|Credentials|Job) /.test(l)), 'no field without a value');
  assert.match(render(atHuman(), wide).find(l => strip(l).includes('Human action')), /\x1b\[31mGive the test Worker/);
});

test('ASS-439 AC3: a fix ticket waited on, landed and not; a credentials hold\'s problems with each fix command', () => {
  const block = extra => ({ ...OWN, 'own-branch': undefined, 'merge-request-planned': undefined, 'human-action': undefined, 'sandbox-refused': undefined, issue: 'harness', key: 'ASS-500', 'waits-on': { project: 'harness', ticket: 'ASS-500' }, ...extra });
  const waits = s => tabText(lines(s)).find(l => l.startsWith('Waiting on'));
  assert.equal(waits(atHuman({ blocks: [block({ landed: false, status: 'Closed' })] })), 'Waiting on        fix ASS-500 (harness) — its fix has not landed (Closed)');
  assert.equal(waits(atHuman({ blocks: [block({ landed: true, status: 'Done' })] })), 'Waiting on        fix ASS-500 (harness) — its fix has landed');
  // At Blocked, waiting on it: the run's output, or the variation's waits-on before the output names it.
  assert.equal(waits(atBlocked('await-fix', { 'fix-attempts': 1, summary: 'S', key: 'ASS-501' })), 'Waiting on        fix ASS-501 — its fix has not landed');
  const live = atBlocked('await-fix', { 'fix-attempts': 1, summary: 'S' }, { 'waits-on': { project: 'harness', ticket: 'ASS-502' } });
  assert.equal(waits(live), 'Waiting on        fix ASS-502 (harness) — its fix has not landed');
  assert.ok(tabText(lines(live)).includes('Now               Waiting on fix ASS-502'));
  // Credentials: the project's hold, each problem with its fix; else the block's own problems.
  const held = tabText(lines(atBlocked('credentials-status', { summary: 'glab logged out', issue: 'credentials', held: true }, {}, { hold: HOLD })));
  const at = held.indexOf('Credentials       the glab login (gitlab.example.com): glab is not authenticated');
  assert.ok(at >= 0, held.join('\n'));
  assert.equal(held[at + 1], '                  fix: glab auth login --hostname gitlab.example.com');
  const own = tabText(lines(atHuman({ blocks: [block({ issue: 'credentials', key: undefined, 'waits-on': undefined, problems: [{ credential: 'keychain item "K"', problem: 'missing', fix: 'security add-generic-password -s K' }] })] })));
  assert.ok(own.includes('Credentials       keychain item "K": missing') && own.includes('                  fix: security add-generic-password -s K'), own.join('\n'));
  assert.ok(!tabText(lines(atHuman())).some(l => l.startsWith('Credentials')), 'no hold, no credentials');
});

test('ASS-439 AC3: at Blocked, the blocked flow\'s current step in words — troubleshooting, classifying, waiting on a fix, repairing the VM — or its step\'s name; no human action', () => {
  const now = (sub, output = { summary: 'S' }) => tabText(lines(atBlocked(sub, output))).find(l => l.startsWith('Now'));
  assert.equal(now('troubleshoot'), 'Now               Troubleshooting');
  assert.equal(now('classify'), 'Now               Classifying');
  assert.equal(now('await-fix', { key: 'ASS-9' }), 'Now               Waiting on fix ASS-9');
  assert.equal(now('repair-vm'), 'Now               Repairing the VM and its source');
  assert.equal(now('mystery'), 'Now               A Step of Its Own');
  const out = tabText(lines(atBlocked('classify', { summary: 'S', 'human-action': 'Do it by hand' })));
  assert.ok(!out.some(l => l.startsWith('Human action')), out.join('\n'));
  // Nothing found yet: where and since, the current step, the earlier blocks — no summary.
  const fresh = tabText(lines(atBlocked('troubleshoot', null)));
  assert.ok(fresh.includes('Blocked           at Build: it goes back there once resolved') && !fresh.some(l => l.startsWith('Summary')), fresh.join('\n'));
  assert.ok(fresh.includes('  2026-11-12 09:00  build/ci-checks  image: bats missing on the golden image — resumed'));
});

test('ASS-439 AC3: at Blocked for Human by hand (no Blocked run this stay) no earlier run is taken for the current block', () => {
  const byHand = atHuman({ 'state-changes': [move('plan', 'build', '2026-11-14T10:00:00Z'), move('build', 'blocked-for-human', '2026-11-14T21:00:00Z')] });
  const out = tabText(lines(byHand));
  assert.ok(!out.some(l => l.startsWith('Summary')), out.join('\n'));
  assert.ok(out.some(l => l.includes('billing reconciler')), 'the last run listed among the earlier blocks');
});

test('ASS-439 AC3: long text wraps to the tab\'s width, and the tab scrolls as the others do', () => {
  const long = Array.from({ length: 30 }, (_, i) => `cause${i}`).join(' ');
  const narrow = { ...wide, columns: 110, rows: 70 };
  const s = atHuman({ blocks: [...EARLIER, { ...OWN, 'root-cause': long }] });
  const out = lines(s, narrow);
  const body = out.slice(out.findIndex(l => l.startsWith('┌ 1 Actions')) + 1);
  const words = body.join(' ').match(/cause\d+/g);
  assert.equal(words.length, 30, 'every word shown, none cut');
  const blocked = blockedLines(blockedOf({ key: 'K', variation: { name: 'A', 'harness-status': hs('blocked-for-human'), 'state-changes': history, blocks: [{ ...OWN, 'root-cause': long }] } }, steps), { width: 60, now: wide.now, steps });
  assert.ok(blocked.every(l => strip(l).length <= 60), blocked.join('\n'));
  // ↓ at Blocked scrolls it; PgDn pages it.
  const ai = atBlocked('troubleshoot', { summary: long, 'root-cause': long }, {}, {});
  const small = { ...wide, rows: 28 };
  const down = handleKey(ai, key('down'), small);
  assert.equal(down.ticketBlockedScroll, 1);
  assert.ok(handleKey(ai, key('pagedown'), small).ticketBlockedScroll > 1);
});

test('ASS-439 AC4: at Blocked for Human the Blocked tab lists the step\'s choices, each with what it does', () => {
  const out = tabText(lines(atHuman()));
  const at = out.indexOf('Resolve it — choose one:');
  assert.deepEqual(out.slice(at + 1, at + 3), [
    '  ▸ Resolved — you have fixed it: the ticket goes back to Build',
    '    Have AI Try Again to Unblock this Ticket — Blocked runs again from Troubleshoot with what you changed',
  ]);
  const more = steps.map(s => (s.id === 'blocked-for-human' ? { ...s, 'exit-events': [...s['exit-events'], { condition: { 'human-review': 'Give Up' }, 'move-to-state': 'done' }] } : s));
  const third = tabText(lines(openedOn(more, { 'harness-status': hs('blocked-for-human'), 'state-changes': history, blocks: [OWN] })));
  assert.ok(third.includes('    Give Up — the ticket goes to Done'), third.join('\n'));
});

test('ASS-439 AC4: Resolved and Have AI Try Again are recorded from the Blocked tab as the Actions tab records them — the same keys and the same record', () => {
  // Today's record: the same ticket with its choices on Actions (an engine without quarantine).
  const before = openedOn(unquarantined(), { 'harness-status': hs('blocked-for-human'), 'state-changes': history, blocks: [OWN] });
  const onActions = { ...before, ticketTab: 'actions' };
  const resolvedThen = press(onActions, 'return').decide;
  const againThen = press(onActions, 'down', 'return').decide;
  assert.deepEqual(resolvedThen, ['ticket:human-review', 'example', 'ABC-1770', 'A', 'blocked-for-human', 'Resolved', 'build']);
  assert.deepEqual(againThen, ['ticket:human-review', 'example', 'ABC-1770', 'A', 'blocked-for-human', 'Have AI Try Again to Unblock this Ticket', 'blocked']);
  const s = atHuman();
  const resolved = press(s, 'return');
  assert.deepEqual(resolved.decide, resolvedThen);
  assert.equal(resolved.ticketBlockedChoice, -1);   // nothing left selected (ASS-131)
  assert.deepEqual(press(s, 'down', 'return').decide, againThen);
  assert.equal(press(s, 'down').ticketBlockedChoice, 1);
  assert.equal(press(s, 'down', 'down').ticketBlockedChoice, 1);   // no further than the last
  // A recorded choice shows there, as on Actions.
  const recorded = atHuman({ 'human-review': { state: 'blocked-for-human', decision: 'Resolved', timestamp: '2026-11-14T21:00:00Z' } });
  assert.ok(tabText(lines(recorded)).some(l => l.startsWith('Recorded: Resolved at 2026-11-14 21:00 UTC')));
  // A past day records nothing.
  assert.equal(press({ ...s, day: '2026-11-13' }, 'return').decide ?? null, null);
});

test('ASS-439 AC4: at Blocked the tab says the AI is working on it and lists no choices; enter records nothing', () => {
  const s = atBlocked('troubleshoot', { summary: 'S' });
  const out = tabText(lines(s));
  assert.ok(out.includes('The AI is working on it: nothing to choose here. It comes to you, at Blocked for Human, should it need you.'), out.join('\n'));
  assert.ok(!out.some(l => l.includes('choose one') || l.includes('▸')));
  assert.equal(press(s, 'return').decide ?? null, null);
});

test('ASS-439 AC5: the Actions tab drops the blocked choices while the Blocked tab shows them, says "Blocked: see tab 2" at its top and keeps every other action', () => {
  const s = atHuman();
  s.projects[0].sprint.features[0]['worked-manually'] = { by: 'alice', since: '2026-11-14T10:05:00Z' };
  const acting = press(s, '1');
  const out = tabText(lines(acting));
  assert.equal(out[0], 'Blocked: see tab 2');
  assert.ok(!out.some(l => l.includes('Resolved') || l.includes('Have AI Try Again')), out.join('\n'));
  const kept = ['Set manual priority', 'Gate when leaving states', 'Hand back to control', 'Pause this ticket', 'Delete ticket'];
  for (const c of kept) assert.ok(out.some(l => l.includes(c)), c);
  // Each still recorded from Actions: the first of them opens the priority form, Pause records its command.
  assert.equal(press(acting, 'return').priorityDraft, '');
  assert.deepEqual(press(acting, 'down', 'down', 'down', 'return').decide, ['ticket:set-paused', 'example', 'ABC-1770', 'A', 'true']);
  // At Blocked the Actions tab says so too, and still offers to send it to Blocked for Human.
  const ai = tabText(lines(press(atBlocked('troubleshoot', null), '1')));
  assert.equal(ai[0], 'Blocked: see tab 2');
  assert.ok(ai.some(l => /Block this ticket\s+→ Blocked for Human/.test(l)), ai.join('\n'));
  // Not blocked: no such line.
  assert.notEqual(tabText(lines(press(atBuild(), '1')))[0], 'Blocked: see tab 2');
});

test('ASS-439: a screen left on the Blocked tab once the ticket moves on shows Actions', () => {
  const s = atHuman();
  const moved = { ...s, projects: [{ ...s.projects[0], sprint: { ...s.projects[0].sprint, features: [ticket({ 'harness-status': hs('build') })] } }] };
  assert.equal(moved.ticketTab, 'blocked');
  const out = lines(moved);
  assert.match(bar(out), new RegExp(`^${NO_BLOCK} ─`));
  assert.ok(tabText(out).some(l => l.includes('Set manual priority')));
  assert.equal(press(moved, 'tab').ticketTab, 'details');
});

// ASS-510 AC2: a notice from outside the variation's flow (ai-notices, e.g. the stray-branch set-aside) is shown after the block's own
// feedback, marked "Notice (<time> UTC, <source>)" — on the Blocked tab, the Details tab's Health and the quick panel's Health.
const NOTICE = { timestamp: '2026-11-18T08:42:00Z', source: 'ABC-9 A\'s step end', short: 'Stray commits set aside: example-corpus change/ABC-1770-1', long: 'Commits of a stray local branch were set aside: example-corpus change/ABC-1770-1 (2 commit(s), kept under refs/harness/stray/x)' };
const NOTICE2 = { timestamp: '2026-11-18T09:10:00Z', source: 'ABC-7 A\'s step start', short: 'Second notice', long: 'The second notice, recorded later' };
const FEEDBACK = { 'ai-feedback-short': 'Reviewer thread open on example-api !12', 'ai-feedback-long': 'Operator: post the timings on example-api !12 so the reviewer resolves the thread, then resume' };
const MARK = 'Notice (2026-11-18 08:42 UTC, ABC-9 A\'s step end): ';
const details = fields => ticketLines({ key: 'ABC-1770', title: 'T', variation: variation({ 'harness-status': hs('blocked-for-human'), ...fields }) },
  { status: 'Blocked for Human', stepName: id => id, prompted: () => false, agents: [], columns: 200, steps }).details.map(strip);
const quick = fields => quickLines({ key: 'ABC-1770', title: 'T', variation: variation({ 'harness-status': hs('blocked-for-human'), ...fields }) }, { status: 'Blocked for Human', now: wide.now, width: 200 }).map(strip);

test('ASS-510 AC2: noticeText marks a notice with its time and source, its short or long text after', async () => {
  const { noticeText } = await import('../../src/tui/ticket.js');
  assert.equal(typeof noticeText, 'function', 'noticeText is exported');
  assert.equal(noticeText(NOTICE), MARK + NOTICE.long);
  assert.equal(noticeText(NOTICE, 'short'), MARK + NOTICE.short);
});

test('ASS-510 AC2: blockedOf gives the block\'s feedback and its notices', () => {
  const info = blockedOf({ key: 'ABC-1770', variation: variation({ 'harness-status': hs('blocked-for-human'), blocks: [...EARLIER, OWN], ...FEEDBACK, 'ai-notices': [NOTICE] }) }, steps);
  assert.equal(info.feedback, FEEDBACK['ai-feedback-long']);
  assert.deepEqual(info.notices, [NOTICE]);
});

test('ASS-510 AC2: at Blocked for Human the Blocked tab shows the block\'s Health, then its notices, each marked, in the order recorded', () => {
  const out = tabText(lines(atHuman({ ...FEEDBACK, 'ai-notices': [NOTICE, NOTICE2] })));
  const health = out.findIndex(l => l.startsWith('Health') && l.includes(FEEDBACK['ai-feedback-long'].slice(0, 40)));
  const first = out.findIndex(l => l.includes('Notice (2026-11-18 08:42 UTC, ABC-9 A\'s step end)'));
  const second = out.findIndex(l => l.includes('Notice (2026-11-18 09:10 UTC, ABC-7 A\'s step start)'));
  assert.ok(health >= 0 && first > health && second > first, out.join('\n'));
  assert.ok(out.some(l => l.startsWith('Notices')), out.join('\n'));
});

test('ASS-510 AC2: the Details tab\'s Health lists the block\'s feedback first, then the notice, marked; a notice without feedback is shown alone, still marked', () => {
  const out = details({ ...FEEDBACK, 'ai-notices': [NOTICE] }).join('\n');
  const feedback = out.indexOf(FEEDBACK['ai-feedback-long'].slice(0, 40)), notice = out.indexOf(MARK.trimEnd());
  assert.ok(feedback >= 0 && notice > feedback, out);
  const alone = details({ 'ai-notices': [NOTICE] });
  assert.ok(alone.some(l => l.startsWith('Health') && l.includes('Notice (')), alone.join('\n'));
});

test('ASS-510 AC2: the quick panel shows Health: <feedback>, then the notice\'s short text, marked, on the next line', () => {
  const out = quick({ ...FEEDBACK, 'ai-notices': [NOTICE] });
  const at = out.findIndex(l => l.startsWith('Health: '));
  assert.ok(at >= 0 && out[at].includes(FEEDBACK['ai-feedback-long'].slice(0, 30)), out.join('\n'));
  assert.equal(out[at + 1], `  ${MARK}${NOTICE.short}`);
});

test('ASS-510 AC2: without notices the Blocked tab, Health and quick panel are as before', () => {
  for (const notices of [undefined, []]) {
    const fields = { ...FEEDBACK, ...(notices ? { 'ai-notices': notices } : {}) };
    assert.deepEqual(details(fields), details(FEEDBACK));
    assert.deepEqual(quick(fields), quick(FEEDBACK));
    assert.ok(!tabText(lines(atHuman(fields))).some(l => l.includes('Notice')));
  }
});
