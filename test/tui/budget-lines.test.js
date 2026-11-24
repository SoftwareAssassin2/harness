// ASS-530: memory and CPU against limits, and each project's share, instead of seat counts — on the compute network
// screen (n) since ASS-566, which moved them there from the footer's local virtual machines, gcp workstations and cloud
// virtual machines boxes, keeping each figure once:
// - AC1: the Mac's memory and CPU in use against the harness's budget (its row), then the project's share, its
//   allotment (after reallocation) and its use, from control's seat-budget.json (project.seatBudget) — "lends" /
//   "borrows" when its share is reallocated — on its Mac card's Share line (ASS-572; its Mac shares line before); red
//   "over" past a limit; its seat holders' VMs in the card's On it.
// - AC2: each workstation and cloud VM's tickets, memory and CPU against its own limits, from control's
//   remote-seats.json (project.remoteBudget): its card's Seats line and gauges, "full", "not measured" and "not read"
//   in its verdict (ASS-572; its table row and ↳ line before).
// - AC3: no "vm seats" or "free build/planning seat" line; the footer and the n screen fit 120 columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { platform } from '../../src/tui/screens/frame.js';
import { view } from '../../src/tui/screens/network.js';
import { visible } from '../../src/tui/text.js';
import { cardOf, onIt } from '../support/network-fixture.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const screen = { columns: 120, rows: 50, now: new Date('2026-11-22T06:04:00Z') };
const at = '2026-11-22T06:00:00Z';
const G = 2 ** 30;
const RED = '\x1b[31m', GRAY = '\x1b[90m';
const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
const cloud = id => ({ kind: 'cloud-vm', id, 'gcp-project': 'example-gcp-project', zone: 'us-central1-a' });
const running = holder => ({ state: 'running', connected: true, 'connected-at': at, setup: { ok: true, 'checked-at': at }, ...(holder ? { holder } : {}) });

// budget(extra) — a seat-budget.json as seat-budget.js budgetSeats writes it: a 64 GiB, 12-core Mac at 90%/90%,
// a split share of 50%, allotted 3 tickets, using 2.
const budget = (extra = {}) => ({
  seats: 3, share: 50, 'share-source': 'split',
  allotment: { seats: 3, 'memory-bytes': 28.8 * G, 'cpu-percent': 540 },
  used: { seats: 2, starting: 0, 'memory-bytes': 8.2 * G, 'cpu-percent': 180.4 },
  lends: { 'memory-bytes': 0, 'cpu-percent': 0 }, borrows: { 'memory-bytes': 0, 'cpu-percent': 0 },
  want: 2, 'per-ticket': { 'memory-bytes': 6 * G, 'cpu-percent': 100 },
  mac: { 'memory-used-bytes': 41.2 * G, 'memory-budget-bytes': 57.6 * G, 'cpu-percent': 310, 'cpu-budget-percent': 1080, over: [] },
  ...extra,
});
const vmRows = { 'b-1-a': { ticket: 'B-1', variation: 'A', state: 'Running' }, 'b-2-a': { ticket: 'B-2', variation: 'A', state: 'Running' } };
const project = (extra = {}) => ({
  id: 'p', name: 'P', sprint: null, environments: [], devEnvironments: { mode: 'vm', workstations: [] },
  workstations: {}, seats: [{ key: 'B-1', variation: 'A', kind: 'vm' }, { key: 'B-2', variation: 'A', kind: 'vm' }], vms: vmRows,
  seatBudget: budget(), limits: { project: {}, harness: {} }, ...extra,
});
const stateOf = p => ({ ...initialState({ projects: [p], assignments: [], controls: { p: { pid: 1, startTime: '2026-11-22T05:51:00Z' } } }), screen: 'n' });
const rows = s => view(s, screen);
// ASS-572: the n screen's cards — the Mac's (its gauges, its Seats and Share lines) and each remote machine's.
const card = (s, id) => cardOf(rows(s), id);
const line = (s, id, label) => card(s, id).lines.filter((l, n, all) => l.startsWith(label) || (n > 0 && all.slice(0, n).findLast(x => !x.startsWith(' '))?.startsWith(label) && l.startsWith(' '))).map(l => l.trim()).join(' ');
const rawCard = (s, id) => { const out = rows(s); const i = out.findIndex(l => strip(l).includes(`┌─ ${id}`)); return out.slice(i, i + 14).join('\n'); };
const shares = s => line(s, 'mac', 'Share');

test('AC1: the Mac\'s memory and CPU against the budget (its gauges), the project\'s share, allotment and use (its Share line), then its tickets', () => {
  const s = stateOf(project());
  assert.match(line(s, 'mac', 'RAM'), /41\.2 GiB · limit 57\.6$/);   // no total known: the bar is the limit's
  assert.equal(shares(s), 'Share   50% (split) · allotment 3 tickets · uses 2 lends 0 · borrows 0 allotted 28.8 GiB · used 8.2 GiB');
  assert.deepEqual(onIt(card(s, 'mac')), ['💺 B-1 Lima VM · running', '💺 B-2 Lima VM · running']);
  // A share set in project.json: no "split"; nothing in red.
  const set = stateOf(project({ seatBudget: budget({ share: 70, 'share-source': 'set', used: { seats: 1, starting: 0, 'memory-bytes': 4 * G, 'cpu-percent': 90 } }) }));
  assert.match(shares(set), /^Share {3}70% · allotment 3 tickets · uses 1 /);
  assert.ok(!rows(set).join('\n').includes(RED), 'nothing over a limit, nothing red');
});

test('AC1, AC5: a project lending its share says how much it lends; the borrower how much it borrows; its part of the Mac\'s cluster on its Cluster line', () => {
  const lender = stateOf(project({ seatBudget: budget({ want: 1, allotment: { seats: 4, 'memory-bytes': 28.8 * G, 'cpu-percent': 540 }, used: { seats: 1, starting: 0, 'memory-bytes': 5 * G, 'cpu-percent': 95 }, lends: { 'memory-bytes': 18.4 * G, 'cpu-percent': 340 } }) }));
  assert.match(shares(lender), /lends 18\.4 GiB · borrows 0/);
  const borrower = stateOf(project({ seatBudget: budget({ allotment: { seats: 7, 'memory-bytes': 47.2 * G, 'cpu-percent': 880 }, used: { seats: 6, starting: 0, 'memory-bytes': 36 * G, 'cpu-percent': 600 }, borrows: { 'memory-bytes': 18.4 * G, 'cpu-percent': 340 } }) }));
  assert.match(shares(borrower), /allotment 7 tickets · uses 6 .*lends 0 · borrows 18\.4 GiB/);
  // Nothing lent or borrowed (zeros, or a rounding crumb): 0.
  const even = stateOf(project({ seatBudget: budget({ lends: { 'memory-bytes': 12, 'cpu-percent': 0 } }) }));
  assert.match(shares(even), /lends 0 · borrows 0/);
  // ASS-539 AC3: its part of the Mac's Substrate cluster, "not up" while it was not up.
  const cluster = stateOf(project({ seatBudget: budget({ used: { ...budget().used, substrate: { 'memory-bytes': 2.5 * G, 'cpu-percent': 30, running: false } } }) }));
  assert.equal(line(cluster, 'mac', 'Cluster'), 'Cluster ○ not up · 2.5 GiB');
});

test('AC1, AC5: over a limit — the Mac over its memory or CPU limit, and a project holding more than its allotment — in red with "over"', () => {
  const mac = stateOf(project({ seatBudget: budget({ mac: { 'memory-used-bytes': 60.1 * G, 'memory-budget-bytes': 57.6 * G, 'memory-total-bytes': 64 * G, 'cpu-percent': 1100, 'cpu-budget-percent': 1080, 'cpu-capacity-percent': 1200, over: ['memory', 'cpu'] } }) }));
  const raw = rawCard(mac, 'mac');
  assert.ok(raw.includes(`${RED}92% · limit 90%`) && raw.includes(`${RED}60.1 of 64.0 GiB · limit 57.6`), raw);
  assert.ok(raw.includes(`${RED}full: the Mac is over its memory`), raw);
  assert.match(line(mac, 'mac', 'Seats'), /full: the Mac is over its memory and cpu limit$/);
  const proj = stateOf(project({ seatBudget: budget({ seats: 4, allotment: { seats: 3, 'memory-bytes': 28.8 * G, 'cpu-percent': 540 }, used: { seats: 4, starting: 0, 'memory-bytes': 30 * G, 'cpu-percent': 400 } }) }));
  assert.match(shares(proj), /uses 4 over/);
  assert.ok(rawCard(proj, 'mac').includes(`${RED}uses 4 over`));
});

test('AC1: the Mac not read (no new seats) in red, and no seat-budget.json yet said', () => {
  const unread = stateOf(project({ seatBudget: budget({ allotment: { seats: 2, 'memory-bytes': null, 'cpu-percent': null }, used: { seats: 2, starting: 0, 'memory-bytes': null, 'cpu-percent': null }, lends: { 'memory-bytes': null, 'cpu-percent': null }, borrows: { 'memory-bytes': null, 'cpu-percent': null }, mac: { 'memory-used-bytes': null, 'memory-budget-bytes': null, 'cpu-percent': null, 'cpu-budget-percent': null, over: ['unread'] } }) }));
  assert.match(card(unread, 'mac').title, /● not read ─┐$/);
  assert.ok(rawCard(unread, 'mac').includes(`${RED}● not read`));
  assert.match(line(unread, 'mac', 'RAM'), /not measured yet/);
  assert.match(shares(unread), /^Share {3}50% \(split\) · allotment 2 tickets · uses 2 /);
  const open = stateOf(project({ seatBudget: budget({ seats: null, allotment: { seats: null, 'memory-bytes': null, 'cpu-percent': null } }) }));
  assert.match(shares(open), /allotment: not limited/);
  const none = stateOf(project({ seatBudget: null }));
  assert.match(shares(none), /no seat budget yet/);
  assert.deepEqual(onIt(card(none, 'mac')), ['💺 B-1 Lima VM · running', '💺 B-2 Lima VM · running']);
});

// The remote machines: ws-1 measured and holding 2 tickets, ws-2 over its memory limit and full, cvm-1 not measured,
// cvm-2 whose reading failed, cvm-3 with no remote-seats.json entry (counted from seats.json).
const remoteSeat = (key, id, kind = 'workstation') => ({ key, variation: 'A', kind, workstation: id });
const measured = (extra = {}) => ({ seats: 3, held: 2, pending: 0, state: 'measured', why: 'one more ticket fits', admit: true, limits: { memory: 90, cpu: 90 }, 'memory-used-bytes': 12.1 * G, 'memory-budget-bytes': 28.8 * G, 'cpu-percent': 150.2, 'cpu-budget-percent': 720, ...extra });
const remote = (extra = {}) => project({
  devEnvironments: { mode: 'vm+workstation', workstations: [ws('ws-1'), ws('ws-2'), cloud('cvm-1'), cloud('cvm-2'), cloud('cvm-3')] },
  workstations: { 'ws-1': running({ ticket: 'R-1', variation: 'A', since: at }), 'ws-2': running(), 'cvm-1': { state: 'stopped', connected: false }, 'cvm-2': running(), 'cvm-3': running() },
  seats: [remoteSeat('R-1', 'ws-1'), remoteSeat('R-2', 'ws-1'), ...['R-3', 'R-4', 'R-5'].map(k => remoteSeat(k, 'ws-2')), remoteSeat('R-6', 'cvm-3', 'cloud-vm'), { key: 'B-1', variation: 'A', kind: 'vm' }],
  remoteBudget: {
    'ws-1': measured(),
    'ws-2': measured({ seats: 3, held: 3, admit: false, why: 'one more ticket would pass its memory limit', 'memory-used-bytes': 30.5 * G }),
    'cvm-1': { seats: 1, held: 0, pending: 0, state: 'unmeasured', why: 'not connected', admit: true, limits: { memory: 90, cpu: 90 } },
    'cvm-2': { seats: 1, held: 1, pending: 0, state: 'unread', why: 'ssh failed', admit: false, limits: { memory: 80, cpu: 70 } },
  },
  ...extra,
});

test('AC2, AC5: each workstation and cloud VM card has the tickets it holds and its memory and CPU against its limits; over one in red, full, not measured and not read said', () => {
  const s = stateOf(remote());
  assert.equal(line(s, 'ws-1', 'Seats'), 'Seats   ■■□  2 of 3 · can take 1 more');
  assert.match(line(s, 'ws-1', 'RAM'), /12\.1 GiB · limit 28\.8$/);
  assert.equal(line(s, 'ws-2', 'Seats'), 'Seats   ■■■  3 of 3 · full: one more would pass its memory limit');
  assert.ok(rawCard(s, 'ws-2').includes(`${RED}30.5 GiB · limit 28.8`), rawCard(s, 'ws-2'));
  assert.equal(line(s, 'cvm-1', 'Seats'), 'Seats   □  0 of 1 · stopped: starts on demand (up to 15 min) · can take 1');
  assert.equal(line(s, 'cvm-2', 'Seats'), 'Seats   ■  1 of 1 · no new work: its reading failed (ssh failed)');
  assert.equal(line(s, 'cvm-3', 'Seats'), 'Seats   ■  1 of 1 · not measured yet: holds 1, takes no more until it is', 'no remote-seats.json entry yet: counted from seats.json');
  assert.match(card(s, 'ws-1').title, /ws-1 · workstation .*● running ─┐$/);
  assert.match(card(s, 'cvm-1').title, /cvm-1 · cloud VM .*○ stopped ─┐$/);
  // CPU over its limit: red, as a share of the whole machine (8 cores: 800 of one core is 100%).
  const cpu = stateOf(remote({ remoteBudget: { 'ws-1': measured({ 'cpu-percent': 800 }) } }));
  assert.ok(rawCard(cpu, 'ws-1').includes(`${RED}100% · limit 90%`), rawCard(cpu, 'ws-1'));
});

test('AC3: no line shows a seat count from the removed settings, and the footer and the n screen fit 120 columns', () => {
  const long = 'machine-with-a-very-long-name';
  const s = stateOf(remote({
    devEnvironments: { mode: 'vm+workstation', workstations: [ws(`ws-${long}`), cloud(`cvm-${long}`)] },
    workstations: { [`ws-${long}`]: running({ ticket: 'R-1', variation: 'A', since: at }), [`cvm-${long}`]: { connected: false, 'last-error': { at, kind: 'timeout', message: 'no SSH' }, state: 'starting' } },
    seats: [...Array.from({ length: 12 }, (_, i) => remoteSeat(`R-${i}`, `ws-${long}`)), { key: 'B-1', variation: 'A', kind: 'vm' }],
    remoteBudget: { [`ws-${long}`]: measured({ held: 12, admit: false, 'memory-used-bytes': 130.4 * G, 'memory-budget-bytes': 115.2 * G, 'cpu-percent': 1250, 'cpu-budget-percent': 1440 }) },
    seatBudget: budget({ share: 33.3, allotment: { seats: 12, 'memory-bytes': 121.5 * G, 'cpu-percent': 1533.3 }, used: { seats: 13, starting: 0, 'memory-bytes': 124.1 * G, 'cpu-percent': 1412 }, borrows: { 'memory-bytes': 102.3 * G, 'cpu-percent': 1120 }, lends: { 'memory-bytes': 0, 'cpu-percent': 0 }, mac: { 'memory-used-bytes': 160.2 * G, 'memory-budget-bytes': 157.6 * G, 'cpu-percent': 2012.5, 'cpu-budget-percent': 2080, over: ['memory'] } }),
  }));
  for (const st of [s, { ...s, screen: 's' }]) {
    const out = render(st, screen).map(strip);
    assert.ok(out.every(l => visible(l) <= screen.columns), out.join('\n'));
    const text = out.join('\n');
    for (const gone of ['vm seats', 'free build seat', 'free planning seat', 'max-tickets']) assert.ok(!text.includes(gone), gone);
    assert.match(out.at(-1), /press \? for menu/);
  }
  assert.match(shares(s), /allotment 12 tickets/);
  assert.ok(platform({ ...s, screen: 's' }, screen.columns, screen.now).every(l => visible(l) <= screen.columns));
});

test('AC4: CLAUDE.md, README and agent.sh\'s harness: help describe budgets and shares instead of seat counts, including how to set share', async () => {
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const root = new URL('../../', import.meta.url).pathname;
  const claude = readFileSync(`${root}CLAUDE.md`, 'utf8'), readme = readFileSync(`${root}README.md`, 'utf8');
  for (const [name, doc] of [['CLAUDE.md', claude], ['README.md', readme]]) {
    assert.match(doc, /project:set-share <project>/, `${name}: how to set a share (ASS-546: a command, not a hand edit)`);
    assert.match(doc, /max-memory-percent/, name);
    assert.match(doc, /ticket-isolation/, name);
    for (const gone of ['vm seats: <used>', 'free build seat` line per', '(free seats included)']) assert.ok(!doc.includes(gone), `${name}: ${gone}`);
  }
  // The read-only looks read the budget files, not the removed settings.
  assert.match(claude, /seat-budget\.json/);
  assert.match(claude, /remote-seats\.json/);
  assert.ok(!/jq [^\n]*max-tickets-in-(progress|planning)/.test(claude), 'no jq snippet reads the removed settings');
  const help = execFileSync(`${root}agent.sh`, ['--help'], { encoding: 'utf8' }).split('\n').filter(l => l.includes('harness:')).join('\n');
  assert.match(help, /memory and CPU budget/);
  assert.match(help, /`share`, a percentage of the budget set with project:set-share/);   // ASS-546
});
