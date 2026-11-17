// ASS-486, ASS-489, ASS-491: the footer's "local virtual machines" box, its rightmost,
// in vm and vm+workstation mode (never workstation mode): one line per VM seat.
// First the VM seat-holders (seats.json kind 'vm'), in seats.json order, each
// its Lima VM's line from vms.json (matched by ticket, case-insensitive, and
// variation) built by ASS-485's machineLine as "<vm> <activity> <state>", or
// "<key-variation> creating" in gray with no vms.json row yet; then a gray
// "free build seat" per VM seat left; with no limit (∞) the holders alone, or a gray
// "none". A VM whose ticket holds no VM seat is left out, whatever its step.
// The footer still fits 120 columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { platform } from '../../src/tui/screens/frame.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const screen = { columns: 120, rows: 40, now: new Date('2026-11-17T16:04:00Z') };
const at = '2026-11-17T16:00:00Z';
const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
const cloud = id => ({ kind: 'cloud-vm', id, 'gcp-project': 'example-gcp-project', zone: 'us-central1-a' });
const running = holder => ({ state: 'running', connected: true, 'connected-at': at, setup: { ok: true, 'checked-at': at }, ...(holder ? { holder } : {}) });

// The sprint, on engine e: plan an agent step, lint a script step.
const steps = [
  { id: 'refine', name: 'Refine', sequence: 0, 'is-planning-stage': true, action: { type: 'prompt' } },   // ASS-491: a planning step
  { id: 'plan', name: 'Plan', sequence: 1, action: { type: 'prompt' } },
  { id: 'lint', name: 'Lint', sequence: 2, action: { type: 'script' } },
  { id: 'done', name: 'Done', sequence: 3, 'is-done': true },
];
const status = (state, extra = {}) => ({ 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const item = (key, variations) => ({ key, title: 'T', priority: 1, variations });
const sprint = {
  number: 1, start: '2026-11-04', end: '2026-11-17', bugs: [], spikes: [],
  features: [
    item('VM-1', [{ name: 'A', ...status('plan') }, { name: 'B', ...status('plan') }]),   // agents on A; B idle
    item('vm-2', [{ name: 'A', ...status('lint') }]),                                      // a script step, its key's case aside
    item('VM-3', [{ name: 'A', ...status('lint') }]),                                      // a script step and an agent
    item('VM-4', [{ name: 'A', ...status('lint', { 'is-paused': true }) }]),               // paused at lint: no script
    item('VM-5', [{ name: 'A', ...status('lint') }]),                                      // in a workstation seat
    item('VM-6', [{ name: 'A', ...status('plan') }]),                                      // in a cloud VM seat
    item('VM-7', [{ name: 'A', ...status('plan') }]),                                      // agents, its VM stopped
    item('VM-8', [{ name: 'A', ...status('plan') }]),                                      // its VM not made yet
  ],
};
const row = (ticket, variation, state = 'Running') => ({ ticket, variation, state, 'disk-bytes': 1, 'credential-kind': 'claude' });
const lima = {
  'vm-1-a': row('VM-1', 'A'),
  'vm-1-b': row('VM-1', 'B'),                // idle, running
  'vm-2-a': row('VM-2', 'A'),
  'vm-3-a': row('VM-3', 'A'),
  'vm-4-a': row('VM-4', 'A', 'Stopped'),    // idle, stopped
  'vm-5-a': row('VM-5', 'A'),
  'vm-6-a': row('VM-6', 'A'),
  'vm-7-a': row('VM-7', 'A', 'Stopped'),
};
const agent = (name, ticket, variation, project = 'p') => ({ project, 'agent-name': name, 'work-item': ticket, variation, model: 'opus-5' });
const team = [
  agent('X', 'vm-1', 'A'), agent('Y', 'VM-1', 'A'), agent('W', 'VM-1', 'A', 'other'),   // two here, one another project's
  agent('Z', 'VM-3', 'A'), agent('V', 'VM-5', 'A'), agent('U', 'VM-6', 'A'), agent('T', 'VM-7', 'A'),
];
const vmSeat = (key, variation = 'A') => ({ key, variation, kind: 'vm', since: at });
const remoteSeats = [
  { key: 'VM-5', variation: 'A', kind: 'workstation', workstation: 'ws-1' },
  { key: 'vm-6', variation: 'A', kind: 'cloud-vm', workstation: 'cvm-1' },
];
const live = { 'ws-1': running({ ticket: 'VM-5', variation: 'A', since: at }), 'cvm-1': running({ ticket: 'VM-6', variation: 'A', since: at }) };
const remotes = mode => (mode === 'vm' ? [] : [ws('ws-1'), cloud('cvm-1')]);
// project(mode, held, limit, extra) — `held` its VM seats in seats.json order, after the remote seats; `limit` its
// max-tickets-in-progress (null: none).
const project = (mode, held = [], limit = 2, extra = {}) => ({
  id: 'p', name: 'P', environments: [], stateEngine: 'e', sprint, devEnvironments: { mode, workstations: remotes(mode) },
  workstations: live, seats: [...remoteSeats, ...held], vms: lima,
  limits: { project: limit == null ? {} : { 'max-tickets-in-progress': limit }, harness: {} }, ...extra,
});
const stateOf = (p, assignments = team) => initialState({ projects: [p], workflows: [{ name: 'e', steps }], assignments, controls: { p: { pid: 1, startTime: '2026-11-17T15:51:00Z' } } });
const rows = (s, columns = screen.columns) => platform(s, columns, screen.now).map(strip);
const raw = s => platform(s, screen.columns, screen.now).join('\n');
// box(s, title) — the box's lines, its title first, wherever its row is; null without it.
const box = (s, title = 'local virtual machines') => {
  const out = rows(s), i = out.findIndex(l => l.includes(`│ ${title} `));
  if (i < 0) return null;
  const from = out[i].indexOf(`│ ${title}`), end = out.findIndex((l, n) => n > i && l[from] === '└');
  return out.slice(i, end).map(l => l.slice(from).replace(/^│ (.*?) *│.*$/, '$1')).filter(Boolean);
};
// titles(s) — the footer's box titles in reading order, row by row.
const titles = s => rows(s).flatMap((l, i, all) => (i > 0 && /┌/.test(all[i - 1]) ? [...l.matchAll(/│ (\S[^│]*?) +│/g)].map(m => m[1]) : []));
const MODES = ['vm', 'vm+workstation'];

test('AC1/AC3: 2 VM seats, 2 holders — rightmost, a line each in seats.json order; VMs of tickets holding no VM seat left out', () => {
  for (const mode of MODES) {
    const s = stateOf(project(mode, [vmSeat('vm-2'), vmSeat('VM-1')]));
    assert.equal(titles(s).at(-1), 'local virtual machines', mode);
    assert.deepEqual(box(s), [
      'local virtual machines',
      'vm-2-a 💻 running',     // the oldest seat first; its key matched whatever its case
      'vm-1-a 🤖x2 running',   // not another project's agent
    ], mode);   // not vm-3-a or vm-7-a (script steps, no seat), vm-1-b, vm-4-a, vm-5-a (workstation seat), vm-6-a (cloud VM seat)
  }
});

test('AC2: 2 VM seats, 1 holder — its line, then a gray "free build seat"', () => {
  for (const mode of MODES) {
    const s = stateOf(project(mode, [vmSeat('VM-3')]));
    assert.deepEqual(box(s), ['local virtual machines', 'vm-3-a 🤖x1 💻 running', 'free build seat'], mode);
    assert.ok(raw(s).includes('\x1b[90mfree build seat\x1b[0m'), mode);
  }
});

test('AC2/AC3: 2 VM seats, no holders — 2 gray "free build seat" lines, though VMs run script steps and agents', () => {
  for (const mode of MODES) {
    assert.deepEqual(box(stateOf(project(mode))), ['local virtual machines', 'free build seat', 'free build seat'], mode);
    assert.deepEqual(box(stateOf(project(mode, [], 2, { vms: undefined, seats: undefined }))), ['local virtual machines', 'free build seat', 'free build seat'], mode);
  }
});

test('AC2: with no VM seat limit (∞), the holders alone, or one gray "none"', () => {
  for (const mode of MODES) {
    assert.deepEqual(box(stateOf(project(mode, [vmSeat('VM-1'), vmSeat('VM-7')], null))), ['local virtual machines', 'vm-1-a 🤖x2 running', 'vm-7-a 🤖x1 stopped'], mode);
    const none = stateOf(project(mode, [], null));
    assert.deepEqual(box(none), ['local virtual machines', 'none'], mode);
    assert.ok(raw(none).includes('\x1b[90mnone\x1b[0m'), mode);
  }
});

test('AC1: never more lines than VM seats, even with more holders recorded', () => {
  assert.deepEqual(box(stateOf(project('vm', [vmSeat('VM-1'), vmSeat('vm-2'), vmSeat('VM-3')]))), ['local virtual machines', 'vm-1-a 🤖x2 running', 'vm-2-a 💻 running']);
});

test('AC4: a holder whose VM has no vms.json row yet shows its expected name, "creating" in gray', () => {
  const s = stateOf(project('vm', [vmSeat('VM-8'), vmSeat('VM-1')]));
  assert.deepEqual(box(s), ['local virtual machines', 'vm-8-a creating', 'vm-1-a 🤖x2 running']);
  assert.ok(raw(s).includes('vm-8-a \x1b[90mcreating\x1b[0m'), raw(s));
});

test('AC1: the state is the VM\'s own word lowercased, running in green', () => {
  const r = raw(stateOf(project('vm', [vmSeat('VM-1'), vmSeat('VM-7')])));
  assert.ok(r.includes('vm-1-a 🤖x2 \x1b[32mrunning\x1b[0m'), r);
  assert.ok(r.includes('vm-7-a 🤖x1 stopped'), r);
});

test('in workstation mode, or with dev-environments wrong, no local virtual machines box', () => {
  for (const p of [project('workstation', [vmSeat('VM-1')]), project('vm', [vmSeat('VM-1')], 2, { devEnvironments: null })]) {
    assert.equal(box(stateOf(p)), null);
    assert.ok(!titles(stateOf(p)).includes('local virtual machines'));
  }
});

test('on a past day no line shows 💻, as the sprint screen shows none', () => {
  const s = stateOf(project('vm', [vmSeat('VM-3'), vmSeat('vm-2')]));
  const p = s.projects[0];
  const past = { ...s, day: '2026-11-16', projects: [{ ...p, days: { '2026-11-16': p.sprint } }] };
  assert.deepEqual(box(past), ['local virtual machines', 'vm-3-a 🤖x1 running', 'vm-2-a running']);
});

test('AC5: a long VM name is cut to WS_ID, the models box keeps "vm seats", and the footer fits 120 columns with all five boxes — local virtual machines rightmost on its row', () => {
  const long = 'vm-with-a-very-long-name-for-its-ticket-a';
  const s = stateOf(project('vm+workstation', [vmSeat('VM-1'), vmSeat('VM-3')], 2, { vms: { [long]: lima['vm-3-a'], 'vm-1-a': lima['vm-1-a'] } }));
  assert.deepEqual(box(s), ['local virtual machines', 'vm-1-a 🤖x2 running', 'vm-with-a-very-long… 🤖x1 💻 running']);
  assert.ok(box(s, 'models').includes('vm seats: 2/2'), box(s, 'models').join('\n'));
  const out = render(s, screen).map(strip);
  assert.ok(out.every(l => visible(l) <= screen.columns), out.join('\n'));   // whole: none cut at the right
  const tops = out.map((l, i) => (/┌/.test(l) ? i : -1)).filter(i => i >= 0);
  assert.match(out[tops.at(-1) + 1], /│ local virtual machines +│$/, 'rightmost on its row');
  assert.match(out.at(-1), /press \? for menu/);
  // Long remote ids too: cloud virtual machines wraps under the others, local virtual machines after it on that row.
  const wide = stateOf(project('vm+workstation', [vmSeat('VM-3')], 2, {
    vms: { [long]: lima['vm-3-a'] },
    devEnvironments: { mode: 'vm+workstation', workstations: [ws('workstation-with-a-very-long-name'), cloud('cloud-vm-with-a-very-long-name')] },
    workstations: { 'workstation-with-a-very-long-name': { connected: false, 'last-error': { at, kind: 'expired', message: 'login expired' } }, 'cloud-vm-with-a-very-long-name': { state: 'starting', connected: false, 'last-error': { at, kind: 'timeout', message: 'no SSH' } } },
  }));
  const rowsOf = render(wide, screen).map(strip);
  const heads = rowsOf.map((l, i) => (/┌/.test(l) ? rowsOf[i + 1] : null)).filter(Boolean).slice(-2);
  assert.match(heads[0], /│ control +│ {4}│ models +│ {4}│ gcp workstations +│$/);
  assert.match(heads[1], /^ *│ cloud virtual machines +│ {4}│ local virtual machines +│$/);
  assert.ok(rowsOf.every(l => visible(l) <= screen.columns), rowsOf.join('\n'));
});

// ASS-491: the planning seats. planned(mode, held, planningLimit, keys, extra) — the sprint with tickets at Refine (a
// planning step) added, `keys` those tickets in rank order; 2 in-progress seats and max-tickets-in-planning
// `planningLimit` (null: none); vms.json with rows for PL-1 (running) and PL-3 (stopped) besides the others.
const planned = (mode, held, planningLimit, keys = ['PL-1', 'pl-2', 'PL-3'], extra = {}) => project(mode, held, 2, {
  sprint: { ...sprint, features: [...sprint.features, ...keys.map((key, i) => ({ ...item(key, [{ name: 'A', ...status('refine') }]), priority: 10 + i }))] },
  vms: { ...lima, 'pl-1-a': row('PL-1', 'A'), 'pl-3-a': row('PL-3', 'A', 'Stopped') },
  limits: { project: { 'max-tickets-in-progress': 2, ...(planningLimit == null ? {} : { 'max-tickets-in-planning': planningLimit }) }, harness: {} },
  ...extra,
});
const planners = [...team, agent('P', 'PL-1', 'A')];

test('ASS-491 AC1/AC2/AC4: 2 build seats and 3 planning seats — build holders and free build seat, then planning holders in seatPlan order and a free planning seat', () => {
  for (const mode of MODES) {
    const s = stateOf(planned(mode, [vmSeat('VM-1')], 3, ['PL-1', 'PL-3']), planners);
    assert.deepEqual(box(s), [
      'local virtual machines',
      'vm-1-a 🤖x2 running',
      'free build seat',
      'pl-1-a 🤖x1 running',
      'pl-3-a stopped',
      'free planning seat',
    ], mode);
    assert.ok(raw(s).includes('\x1b[90mfree build seat\x1b[0m'), mode);
    assert.ok(raw(s).includes('\x1b[90mfree planning seat\x1b[0m'), mode);
    assert.equal(titles(s).at(-1), 'local virtual machines', mode);
  }
  // All five full: 2 build holders, 3 planning holders, no free lines.
  const full = stateOf(planned('vm', [vmSeat('vm-2'), vmSeat('VM-1')], 3), planners);
  assert.deepEqual(box(full), ['local virtual machines', 'vm-2-a 💻 running', 'vm-1-a 🤖x2 running', 'pl-1-a 🤖x1 running', 'pl-2-a creating', 'pl-3-a stopped']);
  // None held: 2 free build seats, 3 free planning seats.
  assert.deepEqual(box(stateOf(planned('vm', [], 3, []))), ['local virtual machines', 'free build seat', 'free build seat', 'free planning seat', 'free planning seat', 'free planning seat']);
});

test('ASS-491 AC1: the planning lines agree with seatPlan — a ticket over the planning limit holds no seat and is not listed', () => {
  const s = stateOf(planned('vm', [], 2), planners);
  assert.deepEqual(box(s), ['local virtual machines', 'free build seat', 'free build seat', 'pl-1-a 🤖x1 running', 'pl-2-a creating']);
});

test('ASS-491 AC2: a planning holder with no vms.json row shows its expected name, "creating" in gray', () => {
  const s = stateOf(planned('vm', [], 3, ['PL-9']));
  assert.deepEqual(box(s), ['local virtual machines', 'free build seat', 'free build seat', 'pl-9-a creating', 'free planning seat', 'free planning seat']);
  assert.ok(raw(s).includes('pl-9-a \x1b[90mcreating\x1b[0m'), raw(s));
});

test('ASS-491 AC4: with no planning limit, only the planning holders; none at all and no build limit, a gray "none"', () => {
  for (const mode of MODES) {
    assert.deepEqual(box(stateOf(planned(mode, [vmSeat('VM-1')], null, ['PL-1', 'PL-3']), planners)), ['local virtual machines', 'vm-1-a 🤖x2 running', 'free build seat', 'pl-1-a 🤖x1 running', 'pl-3-a stopped'], mode);
    assert.deepEqual(box(stateOf(planned(mode, [], null, [], { limits: { project: {}, harness: {} } }))), ['local virtual machines', 'none'], mode);
  }
});

test('ASS-491 AC4: in workstation mode no box, planning seats or not', () => {
  const s = stateOf(planned('workstation', [vmSeat('VM-1')], 3), planners);
  assert.equal(box(s), null);
  assert.ok(!titles(s).includes('local virtual machines'));
});

test('ASS-491 AC5: with build and planning seats the footer fits 120 columns, the box rightmost and its names cut to WS_ID', () => {
  const long = 'pl-with-a-very-long-name-for-its-ticket-a';
  const s = stateOf(planned('vm+workstation', [vmSeat('VM-1'), vmSeat('VM-3')], 3, ['PL-1', 'pl-2', 'PL-3'], {
    vms: { ...lima, [long]: row('PL-1', 'A'), 'pl-3-a': row('PL-3', 'A', 'Stopped') },
  }), planners);
  assert.deepEqual(box(s), ['local virtual machines', 'vm-1-a 🤖x2 running', 'vm-3-a 🤖x1 💻 running', 'pl-with-a-very-long… 🤖x1 running', 'pl-2-a creating', 'pl-3-a stopped']);
  const out = render(s, screen).map(strip);
  assert.ok(out.every(l => visible(l) <= screen.columns), out.join('\n'));
  const tops = out.map((l, i) => (/┌/.test(l) ? i : -1)).filter(i => i >= 0);
  assert.match(out[tops.at(-1) + 1], /│ local virtual machines +│$/, 'rightmost on its row');
  assert.match(out.at(-1), /press \? for menu/);
});
