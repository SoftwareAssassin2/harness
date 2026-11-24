// ASS-559: the sprint screen's Machine and Runs in columns — where each ticket variation's current step runs, from the
// files control writes (seats.json's seats, planning and local lists with their `target` and machine; the variation's
// `sandbox` record; substrate.json's checks) — in place of the Dev and Testing columns (now the ticket screen's
// Acceptance criteria tab) and of the 💺 ⛅ 🌐 📦 seat marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { visible, clip } from '../../src/tui/text.js';
import { placeOf, machineCell, runsCell, sandboxState } from '../../src/tui/places.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const NOW = new Date('2026-10-01T16:04:00Z');
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [
  { id: 'committed', name: 'Committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
  { id: 'gate', name: 'Gate', sequence: 3, action: { type: 'human' }, 'exit-events': [] },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const WS = 'ada-dev-workstation-1', VM = 'harness-cloud-vm-1';
const ticket = (key, rank, state, v = {}) => ({ key, title: 'A fairly long ticket title for width', 'manual-priority': rank,
  variations: [{ name: 'A', 'harness-status': hs(state), ...v }] });
const stopped = machine => ({ sandbox: { name: 'x', project: 'p', machine, state: 'stopped', at: '2026-10-01T10:00:00Z' } });
const features = [
  ticket('S-1', 1, 'build'), ticket('S-2', 2, 'build'), ticket('S-3', 3, 'build'), ticket('S-4', 4, 'build'), ticket('S-5', 5, 'build'),
  ticket('S-6', 6, 'build'), ticket('S-7', 7, 'build'), ticket('S-8', 8, 'build', stopped('mac')),
  ticket('S-9', 9, 'gate', stopped(VM)), ticket('S-10', 10, 'gate'), ticket('S-11', 11, 'build'),
];
const project = {
  id: 'p', name: 'P', stateEngine: 'e', questions: [], seatBudget: { seats: 20 }, limits: { project: {}, harness: {} },
  devEnvironments: { mode: 'vm+workstation', workstations: [{ id: WS, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'x' }, { kind: 'cloud-vm', id: VM, 'gcp-project': 'g', zone: 'z' }] },
  seats: [
    { key: 'S-1', variation: 'A', kind: 'vm', target: 'local-vm' },
    { key: 'S-2', variation: 'A', kind: 'workstation', workstation: WS, target: 'workstation' },
    { key: 'S-3', variation: 'A', kind: 'cloud-vm', workstation: VM, target: 'cloud-vm' },
    { key: 'S-4', variation: 'A', kind: 'vm', target: 'local-substrate' },
    { key: 'S-5', variation: 'A', kind: 'workstation', workstation: WS, target: 'workstation-substrate' },
    { key: 'S-8', variation: 'A', kind: 'vm', target: 'local-substrate' },
  ],
  planningSeats: [{ key: 'S-11', variation: 'A', target: 'cloud-vm-substrate' }],
  localSeats: [{ key: 'S-6', variation: 'A', target: 'local-worktree' }, { key: 'S-7', variation: 'A', target: 'local-workspace' }],
  sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] },
};
const state = (p = project) => initialState({ projects: [p], workflows: [{ name: 'e', steps }], assignments: [] });

// The grid's cells of row `key` by column header, cut at the header's columns (body rows have no inner borders), and
// the line under it (a cell's second line).
function cells(lines, key, below = 0) {
  const header = lines.find(l => /│ +Ticket +│/.test(l));
  const bars = [...header].reduce((at, c, i, all) => (c === '│' ? [...at, visible(all.slice(0, i).join(''))] : at), []);
  const names = header.split('│').slice(1, -1).map(h => h.trim());
  const row = lines[lines.findIndex(l => new RegExp(`\\s${key}: `).test(l)) + below];
  const cut = (from, to) => clip(row, to).slice(clip(row, from).length).trim();
  return Object.fromEntries(names.map((name, i) => [name, cut(bars[i] + 1, bars[i + 1])]));
}
const where = (lines, key) => [cells(lines, key).Machine, cells(lines, key)['Runs in']];
const wide = { columns: 200, rows: 90, now: NOW };

test('ASS-559 AC2: each machine kind and way of running — Mac, GCP workstation <id>, Cloud VM <id>; Lima VM, slot, Substrate sandbox, worktree, workspace — from seats.json', () => {
  const lines = render(state(), wide).map(strip);
  assert.deepEqual(where(lines, 'S-1'), ['Mac', 'Lima VM']);
  assert.deepEqual(where(lines, 'S-2'), [`GCP workstation ${WS}`, 'slot']);
  assert.deepEqual(where(lines, 'S-3'), [`Cloud VM ${VM}`, 'slot']);
  assert.deepEqual(where(lines, 'S-4'), ['Mac', 'Substrate sandbox']);
  assert.deepEqual(where(lines, 'S-5'), [`GCP workstation ${WS}`, 'Substrate sandbox']);
  assert.deepEqual(where(lines, 'S-6'), ['Mac', 'worktree']);    // seats.json's local list (ASS-540): no seat, on the Mac
  assert.deepEqual(where(lines, 'S-7'), ['Mac', 'workspace']);
  assert.deepEqual(where(lines, 'S-11'), ['Cloud VM', 'Substrate sandbox']);   // a planning record names no machine id
});

test('ASS-559 AC2: a ticket on no machine — at a gate, or seated nowhere — has both cells blank; a past day shows none', () => {
  const lines = render(state(), wide).map(strip);
  assert.deepEqual(where(lines, 'S-10'), ['', '']);
  const past = { ...state(), day: '2026-09-30', projects: [{ ...project, days: { '2026-09-30': project.sprint } }] };
  const old = render(past, wide).map(strip);
  for (const key of ['S-1', 'S-2', 'S-9']) assert.deepEqual(where(old, key), ['', ''], key);
});

test('ASS-559 AC2: a hibernated sandbox says so — under "Substrate sandbox" while seated, and, gray, where a ticket at a gate parked it', () => {
  const raw = render(state(), wide);
  const lines = raw.map(strip);
  assert.deepEqual(where(lines, 'S-8'), ['Mac', 'Substrate sandbox']);
  assert.equal(cells(lines, 'S-8', 1)['Runs in'], 'hibernated');
  // S-9 at a gate holds no seat, but its sandbox on the cloud VM is hibernated there.
  assert.deepEqual(where(lines, 'S-9'), [`Cloud VM ${VM}`, 'Substrate sandbox']);
  assert.equal(cells(lines, 'S-9', 1)['Runs in'], 'hibernated');
  assert.ok(raw.find(l => strip(l).includes('S-9: ')).includes(`\x1b[90mCloud VM ${VM}\x1b[0m`), 'parked: gray');
  // A check newer than the record wins (the footer's rule): resumed, it is no longer shown as hibernated.
  const live = { ...project, substrate: { mac: { 'checked-at': '2026-10-01T12:00:00Z', usage: { 'sandbox-use': { x: { state: 'running' } } } } } };
  const now = render(state(live), wide).map(strip);
  assert.notEqual(cells(now, 'S-8', 1)['Runs in'], 'hibernated');
});

test('ASS-559 AC4: the grid fits 120 columns with every kind shown — the id under its label, labels shortened, cut with an ellipsis', () => {
  for (const columns of [120, 140]) {
    const out = render(state(), { columns, rows: 90, now: NOW });
    const top = out.findIndex(l => /^┌.*┬/.test(strip(l))), bottom = out.findLastIndex(l => /^└/.test(strip(l)));
    for (const l of out.slice(top, bottom + 1)) assert.equal(visible(l), columns, `${columns}: ${strip(l)}`);
    const lines = out.map(strip);
    assert.equal(cells(lines, 'S-2').Machine, 'GCP workstation', `${columns}`);
    assert.match(cells(lines, 'S-2', 1).Machine, /^ada-dev-work(station-1|\S*…)$/, `${columns}`);   // the id beneath, whole or cut with …
    assert.equal(cells(lines, 'S-1').Machine, 'Mac');
    assert.equal(cells(lines, 'S-8', 1)['Runs in'], 'hibernated');                    // never cut
  }
});

test('ASS-559 AC2: placeOf — every run target, ASS-553\'s remote worktrees too; records written before run targets by their kind; the planner\'s target until control records one', () => {
  const t = { key: 'K-1', variation: { name: 'A' } };
  const at = (target, extra = {}) => placeOf(t, { held: true, records: [{ key: 'K-1', variation: 'A', target, ...extra }] });
  assert.deepEqual(at('local-vm'), { kind: 'mac', id: null, runs: 'vm', state: null, parked: false });
  assert.deepEqual(at('workstation', { workstation: 'w' }), { kind: 'workstation', id: 'w', runs: 'slot', state: null, parked: false });
  assert.deepEqual(at('cloud-vm', { workstation: 'v' }), { kind: 'cloud-vm', id: 'v', runs: 'slot', state: null, parked: false });
  assert.deepEqual(at('workstation-worktree', { workstation: 'w' }), { kind: 'workstation', id: 'w', runs: 'worktree', state: null, parked: false });
  assert.deepEqual(at('cloud-vm-worktree', { workstation: 'v' }), { kind: 'cloud-vm', id: 'v', runs: 'worktree', state: null, parked: false });
  assert.deepEqual(at('cloud-vm-substrate', { workstation: 'v' }), { kind: 'cloud-vm', id: 'v', runs: 'sandbox', state: null, parked: false });
  assert.deepEqual(at('local-worktree'), { kind: 'mac', id: null, runs: 'worktree', state: null, parked: false });
  assert.deepEqual(at('local-workspace'), { kind: 'mac', id: null, runs: 'workspace', state: null, parked: false });
  assert.equal(placeOf(t, { held: true, records: [{ key: 'k-1', variation: 'A', kind: 'workstation', workstation: 'w' }] }).runs, 'slot');   // before ASS-540
  assert.deepEqual(placeOf(t, { held: true, planned: 'local-substrate' }), { kind: 'mac', id: null, runs: 'sandbox', state: null, parked: false });
  assert.equal(placeOf(t, { held: false, records: [{ key: 'K-1', variation: 'A', target: 'local-vm' }] }), null);   // not seated now: nowhere
  assert.equal(placeOf(t, { held: true }), null);   // seated, but no target known
});

test('ASS-559: machineCell and runsCell — one line while it fits, the id beneath and the short label when narrow; blank for none', () => {
  const ws = { kind: 'workstation', id: 'ada-dev-ws1', runs: 'sandbox', state: 'hibernated', parked: false };
  assert.equal(machineCell(ws)(40), 'GCP workstation ada-dev-ws1');
  assert.deepEqual(machineCell(ws)(15), ['GCP workstation', 'ada-dev-ws1']);
  assert.deepEqual(machineCell(ws)(11), ['Workstation', 'ada-dev-ws1']);
  assert.deepEqual(machineCell(ws)(8), ['Workstation', 'ada-dev…']);   // the label then cut by the table
  assert.deepEqual(runsCell(ws)(20).map(strip), ['Substrate sandbox', 'hibernated']);
  assert.deepEqual(runsCell(ws)(10).map(strip), ['sandbox', 'hibernated']);
  assert.equal(machineCell(null)(20), '');
  assert.equal(runsCell(null)(20), '');
  assert.equal(sandboxState({ state: 'stopped', at: '2026-10-01T10:00:00Z' }, {}), 'hibernated');
  assert.equal(sandboxState({ state: 'running', at: '2026-10-01T10:00:00Z' }, { use: { state: 'suspending' }, at: '2026-10-01T11:00:00Z' }), 'hibernating');
  assert.equal(sandboxState(null, {}), null);
});
