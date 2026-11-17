// ASS-436: the footer's "gcp workstations" box, after control and models, in
// vm+workstation and workstation mode: one line per workstation in the
// project's list, its id, the agents on the variation it holds (as the models
// box counts a model's) and its state from workstations.json (ASS-433/434/435).
// ASS-485 AC6: "<id> <activity> <state>" — 🤖x<n> only with agents, 💻 while
// the variation holding it runs a script step, no seat count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { platform, machineLine } from '../../src/tui/screens/frame.js';
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
// The box's lines, each "│ text │" as its text: the box beginning at the title's column (ASS-486: in vm+workstation
// mode the local virtual machines box follows it).
const box = (s, columns) => {
  const out = rows(s, columns);
  const from = out[1].indexOf('│ gcp workstations');
  if (from < 0) return null;
  return out.slice(1, -2).map(l => l.slice(from).replace(/^│ (.*?) *│.*$/, '$1'));
};

test('ASS-436 AC1/AC2: in vm+workstation and workstation mode, a gcp workstations box after control and models, a line per workstation: its id, its agents and its state', () => {
  for (const mode of ['vm+workstation', 'workstation']) {
    const s = stateOf(project(mode));
    assert.match(rows(s)[1], mode === 'workstation' ? /│ control +│ {4}│ models +│ {4}│ gcp workstations +│$/ : /│ control +│ {4}│ models +│ {4}│ gcp workstations +│ {4}│ local virtual machines +│$/, mode);   // ASS-486: then the local VMs
    assert.deepEqual(box(s).slice(0, 7), [
      'gcp workstations',
      'ws-1 🤖x2 running',                // the holder's ticket matched whatever its case; not variation B, not another project's
      'ws-2 running',                     // no holder, no agents
      'ws-3 stopped',                     // ASS-469: stopped, its seat kept (started for a ticket taking it)
      'ws-4 connecting',                  // connected, not set up yet
      'ws-5 sign in needed seat lost',    // ASS-469 AC5: can't be used, its seat lost
      'ws-6 setup failed seat lost',
    ], mode);
  }
});

test('ASS-436 AC2: running in green, sign in needed and setup failed in red; a workstation with no live data yet is stopped', () => {
  const raw = platform(stateOf(project('workstation')), screen.columns, screen.now).join('\n');
  assert.ok(raw.includes('\x1b[32mrunning'), raw);
  assert.ok(raw.includes('\x1b[31msign in needed') && raw.includes('\x1b[31msetup failed'), raw);
  assert.deepEqual(box(stateOf(project('workstation', [ws('new')], {}))).slice(0, 2), ['gcp workstations', 'new stopped']);
  assert.deepEqual(box(stateOf(project('workstation', [ws('new')], undefined))).slice(0, 2), ['gcp workstations', 'new stopped']);
  assert.ok(raw.includes('\x1b[31mseat lost'), raw);
});

test('ASS-436 AC1: the lines follow the project\'s list, only its workstations', () => {
  assert.deepEqual(box(stateOf(project('vm+workstation', [ws('ws-3'), ws('ws-1')]))).slice(0, 3), ['gcp workstations', 'ws-3 stopped', 'ws-1 🤖x2 running']);
});

test('ASS-436 AC3: in vm mode, with no workstations listed, or with dev-environments wrong, no box and the footer as before', () => {
  // ASS-486: as before in vm mode is with the local virtual machines box; in workstation mode, or wrong, without it.
  // ASS-489: that box shows the VM seats, so the footer before has the same seats and limits.
  const before = devEnvironments => rows(initialState({ projects: [{ id: 'p', name: 'P', sprint: null, environments: [], devEnvironments, seats, limits: { project: { 'max-tickets-in-progress': 3 }, harness: {} } }], assignments: team, controls: { p: { pid: 1, startTime: '2026-10-01T15:51:00Z' } } }));
  const vm = before({ mode: 'vm', workstations: [] }), none = before(null);
  for (const [p, was] of [[project('vm'), vm], [project('workstation', []), none], [project('vm+workstation', []), vm], [{ ...project('workstation'), devEnvironments: null }, none]]) {
    const s = stateOf(p);
    assert.equal(box(s), null);
    assert.deepEqual(rows(s), was);
  }
});

test('ASS-436 AC4: a long id is shortened with an ellipsis, and the footer fits 120 columns with all three boxes', () => {
  const long = 'workstation-with-a-very-long-name-indeed';
  const s = stateOf(project('workstation', [ws(long), ws('ws-5')], { [long]: live['ws-1'], 'ws-5': live['ws-5'] }));
  assert.deepEqual(box(s).slice(0, 3), ['gcp workstations', 'workstation-with-a-… 🤖x2 running', 'ws-5 sign in needed seat lost']);
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

// ASS-485: the sprint the holders run, on engine e: plan an agent step, lint a script step. S-1 A at lint, its B at
// plan; S-2 A at plan; S-3 A at lint but at its gate; S-4 A at lint but paused; S-5 A at lint, worked by hand;
// S-6 A at lint. Agents on S-1 A and S-2 A.
const steps = [
  { id: 'plan', name: 'Plan', sequence: 1, action: { type: 'prompt' } },
  { id: 'lint', name: 'Lint', sequence: 2, action: { type: 'script' } },
  { id: 'done', name: 'Done', sequence: 3, 'is-done': true },
];
const status = (state, extra = {}) => ({ 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const gated = { 'gate-when-leaving-state': ['e/lint'], 'state-changes': [{ 'to-state': 'lint', 'work-is-done': true, 'pending-move': { from: 'lint', to: 'done', reason: 'exit' } }] };
const item = (key, variations, extra = {}) => ({ key, title: 'T', priority: 1, variations, ...extra });
const scriptSprint = {
  number: 1, start: '2026-09-18', end: '2026-10-01', bugs: [], spikes: [],
  features: [
    item('s-1', [{ name: 'A', ...status('lint') }, { name: 'B', ...status('plan') }]),
    item('S-2', [{ name: 'A', ...status('plan') }]),
    item('S-3', [{ name: 'A', ...status('lint', gated) }]),
    item('S-4', [{ name: 'A', ...status('lint', { 'is-paused': true }) }]),
    item('S-5', [{ name: 'A', ...status('lint') }], { 'worked-manually': { by: 'Alice', since: at } }),
    item('S-6', [{ name: 'A', ...status('lint') }]),
  ],
};
const holding = (ticket, variation) => running({ ticket, variation, folder: `/w/${ticket}-${variation}`, since: at });
const scriptLive = { 'ws-a': holding('S-1', 'A'), 'ws-b': holding('S-1', 'B'), 'ws-c': holding('S-2', 'A'), 'ws-d': holding('S-3', 'A'), 'ws-e': holding('S-4', 'A'), 'ws-f': holding('S-5', 'A'), 'ws-g': running(), 'ws-h': holding('S-6', 'A') };
const scripted = (mode = 'workstation', list = Object.keys(scriptLive).map(ws), workstations = scriptLive) => initialState({
  projects: [{ ...project(mode, list, workstations), stateEngine: 'e', sprint: scriptSprint }],
  workflows: [{ name: 'e', steps }], assignments: [agent('X', 'S-1', 'A'), agent('Y', 'S-2', 'A')], controls: { p: { pid: 1, startTime: '2026-10-01T15:51:00Z' } },
});

test('ASS-485 AC1/AC2/AC3: 💻 right after the agent count while the holding variation runs a script step, by the sprint screen\'s rule; none on an agent step, at a gate, paused, worked by hand or with no holder', () => {
  for (const mode of ['vm+workstation', 'workstation']) {
    assert.deepEqual(box(scripted(mode)), [
      'gcp workstations',
      'ws-a 🤖x1 💻 running',   // S-1 A at lint with an agent, its key matched whatever its case
      'ws-b running',           // S-1 B, the other variation, on its agent step: idle, nothing
      'ws-c 🤖x1 running',      // S-2 A's agent on its agent step: no 💻
      'ws-d running',           // S-3 A at its gate
      'ws-e running',           // S-4 A paused
      'ws-f running',           // S-5 worked by hand
      'ws-g running',           // no holder
      'ws-h 💻 running',        // S-6 A at lint, no agent: 💻 alone (ASS-485 AC6)
    ], mode);
  }
});

test('ASS-485 AC2: on a past day no line shows 💻, as the sprint screen shows none', () => {
  const s = scripted();
  const p = s.projects[0];
  const past = { ...s, day: '2026-09-30', projects: [{ ...p, days: { '2026-09-30': p.sprint } }] };
  assert.ok(!box(past).some(l => l.includes('💻')), box(past).join('\n'));
});

test('ASS-485 AC4: with 💻 on a long id\'s line, the footer still fits 120 columns with all three boxes', () => {
  const long = 'workstation-with-a-very-long-name-indeed';
  const s = scripted('workstation', [ws(long), ws('ws-5')], { [long]: { ...live['ws-5'], holder: scriptLive['ws-a'].holder }, 'ws-5': live['ws-5'] });
  assert.deepEqual(box(s).slice(0, 3), ['gcp workstations', 'workstation-with-a-… 🤖x1 💻 sign in needed seat lost', 'ws-5 sign in needed seat lost']);
  const out = render(s, screen).map(strip);
  const top = out.findLastIndex(l => /┌/.test(l));
  assert.match(out[top + 1], /│ control +│ {4}│ models +│ {4}│ gcp workstations +│/);
  const boxes = out.slice(top, out.findLastIndex(l => /└/.test(l)) + 1);
  assert.ok(boxes.every(l => visible(l) <= screen.columns && /[┐│┘]$/.test(l)), boxes.join('\n'));
  assert.match(out.at(-1), /press \? for menu/);
});

test('ASS-485 AC6: machineLine, the machine boxes\' one line builder, is "<id> <activity> <state>", then seat lost', () => {
  const line = facts => strip(machineLine(facts));
  assert.equal(line({ id: 'ws-1', script: true, state: 'running' }), 'ws-1 💻 running');
  assert.equal(line({ id: 'harness-vm-1', agents: 1, state: 'running' }), 'harness-vm-1 🤖x1 running');
  assert.equal(line({ id: 'ws-1', agents: 2, script: true, state: 'running' }), 'ws-1 🤖x2 💻 running');
  assert.equal(line({ id: 'ws-1', agents: 0, script: false, state: 'running' }), 'ws-1 running');
  assert.equal(line({ id: 'ws-1', state: 'sign in needed', lost: true }), 'ws-1 sign in needed seat lost');
  assert.equal(machineLine({ id: 'ws-1', state: 'sign in needed', lost: true }), `ws-1 \x1b[31msign in needed\x1b[0m \x1b[31mseat lost\x1b[0m`);
});
