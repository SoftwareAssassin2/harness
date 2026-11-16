// ASS-436: the footer's "gcp workstations" box, after control and models, in
// vm+workstation and workstation mode: one line per workstation in the
// project's list, its id, the agents on the variation it holds (as the models
// box counts a model's) and its state from workstations.json (ASS-433/434/435).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { platform } from '../../src/tui/screens/frame.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const screen = { columns: 120, rows: 40, now: new Date('2026-10-01T16:04:00Z') };
const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
const at = '2026-10-01T16:00:00Z';
const running = holder => ({ state: 'running', connected: true, 'connected-at': at, setup: { ok: true, 'checked-at': at }, ...(holder ? { holder } : {}) });
const live = {
  'ws-1': running({ ticket: 'ASS-1', variation: 'A', folder: '/w/ASS-1-A', since: at }),
  'ws-2': running(),
  'ws-3': { state: 'stopped', connected: false },
  'ws-4': { state: 'starting', connected: true, 'connected-at': at },
  'ws-5': { state: 'stopped', connected: false, 'last-error': { kind: 'expired', message: 'login expired' } },
  'ws-6': { state: 'running', connected: true, 'connected-at': at, setup: { ok: false, 'checked-at': at, error: 'no docker' } },
};
const agent = (name, ticket, variation, project = 'p') => ({ project, 'agent-name': name, 'work-item': ticket, variation, model: 'opus-5' });
const team = [agent('X', 'ass-1', 'A'), agent('Y', 'ASS-1', 'A'), agent('Z', 'ASS-1', 'B'), agent('W', 'ASS-1', 'A', 'other')];
// ASS-469: ASS-1 A holds ws-1's one seat (control's seats.json), ASS-2 A a VM seat; project.json's 3 VM seats.
const seats = [{ key: 'ASS-1', variation: 'A', kind: 'workstation', workstation: 'ws-1' }, { key: 'ASS-2', variation: 'A', kind: 'vm' }];
const project = (mode, list = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'].map(ws), workstations = live) =>
  ({ id: 'p', name: 'P', sprint: null, environments: [], devEnvironments: { mode, workstations: list }, workstations, seats, limits: { project: { 'max-tickets-in-progress': 3 }, harness: {} } });
const stateOf = p => initialState({ projects: [p], assignments: team, controls: { p: { pid: 1, startTime: '2026-10-01T15:51:00Z' } } });
const rows = (s, columns = screen.columns) => platform(s, columns, screen.now).map(strip);
// The box's lines, each "│ text │" as its text: the box beginning at the title's column.
const box = (s, columns) => {
  const out = rows(s, columns);
  const from = out[1].indexOf('│ gcp workstations');
  if (from < 0) return null;
  return out.slice(1, -2).map(l => l.slice(from).replace(/^│ (.*?) *│$/, '$1'));
};

test('ASS-436 AC1/AC2: in vm+workstation and workstation mode, a gcp workstations box after control and models, a line per workstation: its id, its agents and its state', () => {
  for (const mode of ['vm+workstation', 'workstation']) {
    const s = stateOf(project(mode));
    assert.match(rows(s)[1], /│ control +│ {4}│ models +│ {4}│ gcp workstations +│$/, mode);
    assert.deepEqual(box(s).slice(0, 7), [
      'gcp workstations',
      'ws-1 🤖x2 running 1/1 seats',          // the holder's ticket matched whatever its case; not variation B, not another project's
      'ws-2 🤖x0 running 0/1 seats',          // no holder, no agents
      'ws-3 🤖x0 stopped 0/1 seats',          // ASS-469: stopped, its seat kept (started for a ticket taking it)
      'ws-4 🤖x0 connecting 0/1 seats',       // connected, not set up yet
      'ws-5 🤖x0 sign in needed seat lost',   // ASS-469 AC5: can't be used, its seat lost
      'ws-6 🤖x0 setup failed seat lost',
    ], mode);
  }
});

test('ASS-436 AC2: running in green, sign in needed and setup failed in red; a workstation with no live data yet is stopped', () => {
  const raw = platform(stateOf(project('workstation')), screen.columns, screen.now).join('\n');
  assert.ok(raw.includes('\x1b[32mrunning'), raw);
  assert.ok(raw.includes('\x1b[31msign in needed') && raw.includes('\x1b[31msetup failed'), raw);
  assert.deepEqual(box(stateOf(project('workstation', [ws('new')], {}))).slice(0, 2), ['gcp workstations', 'new 🤖x0 stopped 0/1 seats']);
  assert.deepEqual(box(stateOf(project('workstation', [ws('new')], undefined))).slice(0, 2), ['gcp workstations', 'new 🤖x0 stopped 0/1 seats']);
  assert.ok(raw.includes('\x1b[31mseat lost'), raw);
});

test('ASS-436 AC1: the lines follow the project\'s list, only its workstations', () => {
  assert.deepEqual(box(stateOf(project('vm+workstation', [ws('ws-3'), ws('ws-1')]))).slice(0, 3), ['gcp workstations', 'ws-3 🤖x0 stopped 0/1 seats', 'ws-1 🤖x2 running 1/1 seats']);
});

test('ASS-436 AC3: in vm mode, with no workstations listed, or with dev-environments wrong, no box and the footer as before', () => {
  const before = rows(initialState({ projects: [{ id: 'p', name: 'P', sprint: null, environments: [] }], assignments: team, controls: { p: { pid: 1, startTime: '2026-10-01T15:51:00Z' } } }));
  for (const p of [project('vm'), project('workstation', []), project('vm+workstation', []), { ...project('workstation'), devEnvironments: null }]) {
    const s = stateOf(p);
    assert.equal(box(s), null);
    assert.deepEqual(rows(s), before);
  }
});

test('ASS-436 AC4: a long id is shortened with an ellipsis, and the footer fits 120 columns with all three boxes', () => {
  const long = 'workstation-with-a-very-long-name-indeed';
  const s = stateOf(project('workstation', [ws(long), ws('ws-5')], { [long]: live['ws-1'], 'ws-5': live['ws-5'] }));
  assert.deepEqual(box(s).slice(0, 3), ['gcp workstations', 'workstation-with-a-… 🤖x2 running 0/1 seats', 'ws-5 🤖x0 sign in needed seat lost']);
  const out = render(s, screen).map(strip);
  const top = out.findLastIndex(l => /┌/.test(l));
  assert.match(out[top + 1], /│ control +│ {4}│ models +│ {4}│ gcp workstations +│/);
  const boxes = out.slice(top, out.findLastIndex(l => /└/.test(l)) + 1);
  assert.ok(boxes.every(l => visible(l) <= screen.columns && /[┐│┘]$/.test(l)), boxes.join('\n'));   // whole: none cut at the right
  assert.match(out.at(-1), /press \? for menu/);
});

test('ASS-469 AC7: in vm+workstation mode the models box shows the VM seats used of project.json\'s max-tickets-in-progress (∞ with none); not in workstation mode, which has none', () => {
  const models = s => rows(s).find(l => /vm seats/.test(l));
  assert.match(models(stateOf(project('vm+workstation'))), /│ vm seats: 1\/3 +│/);
  const p = project('vm+workstation');
  assert.match(models(stateOf({ ...p, limits: { project: {}, harness: {} } })), /│ vm seats: 1\/∞ +│/);
  assert.equal(models(stateOf(project('workstation'))), undefined);
  assert.equal(models(stateOf(project('vm'))), undefined);
});
