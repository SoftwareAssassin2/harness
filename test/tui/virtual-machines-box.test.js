// ASS-481 AC5: the footer's "cloud virtual machines" box (ASS-485 AC7:
// retitled from "virtual machines"), directly after the "gcp workstations"
// box (or after models without one), in vm+workstation and workstation mode
// for a project listing cloud VMs: one line per cloud VM in list order, built
// as the workstations box builds its lines, "seat lost" in red while it can't
// be used; none in vm mode or with no cloud VMs; the footer still fits 120
// columns. ASS-485 AC6: "<id> <activity> <state>" — 🤖x<n> only with agents,
// 💻 while the variation holding the cloud VM runs a script step, no seat
// count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { platform } from '../../src/tui/screens/frame.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const screen = { columns: 120, rows: 40, now: new Date('2026-11-17T16:04:00Z') };
const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
const vm = id => ({ kind: 'cloud-vm', id, 'gcp-project': 'example-gcp-project', zone: 'us-central1-a' });
const at = '2026-11-17T16:00:00Z';
const running = holder => ({ state: 'running', connected: true, 'connected-at': at, setup: { ok: true, 'checked-at': at }, ...(holder ? { holder } : {}) });
const live = {
  'ws-1': running(),
  'vm-1': running({ ticket: 'ASS-1', variation: 'A', folder: '/home/u/harness', since: at }),
  'vm-2': { state: 'terminated', connected: false },
  'vm-3': { state: 'starting', 'state-at': at, connected: false },
  'vm-4': { state: 'running', connected: true, 'connected-at': at },
  'vm-5': { connected: false, 'last-error': { at, kind: 'expired', message: 'login expired' } },
  'vm-6': { connected: true, 'connected-at': at, setup: { ok: false, 'checked-at': at, error: 'no docker' } },
  'vm-7': { state: 'starting', connected: false, 'last-error': { at, kind: 'timeout', message: 'its SSH did not answer' } },
};
const agent = (name, ticket, variation, project = 'p') => ({ project, 'agent-name': name, 'work-item': ticket, variation, model: 'opus-5' });
const team = [agent('X', 'ass-1', 'A'), agent('Y', 'ASS-1', 'A'), agent('Z', 'ASS-1', 'B'), agent('W', 'ASS-1', 'A', 'other')];
const seats = [{ key: 'ASS-1', variation: 'A', kind: 'cloud-vm', workstation: 'vm-1' }, { key: 'ASS-2', variation: 'A', kind: 'vm' }];
const vms = ['vm-1', 'vm-2', 'vm-3', 'vm-4', 'vm-5', 'vm-6', 'vm-7'].map(vm);
const project = (mode, list = [ws('ws-1'), ...vms], workstations = live) =>
  ({ id: 'p', name: 'P', sprint: null, environments: [], devEnvironments: { mode, workstations: list }, workstations, seats, limits: { project: { 'max-tickets-in-progress': 3 }, harness: {} } });
const stateOf = p => initialState({ projects: [p], assignments: team, controls: { p: { pid: 1, startTime: '2026-11-17T15:51:00Z' } } });
const rows = (s, columns = screen.columns) => platform(s, columns, screen.now).map(strip);
// box(s, title) — the box's lines, its title first, wherever its row is; null without it.
const box = (s, title = 'cloud virtual machines') => {
  const out = rows(s), i = out.findIndex(l => l.includes(`│ ${title} `));
  if (i < 0) return null;
  const from = out[i].indexOf(`│ ${title}`), end = out.findIndex((l, n) => n > i && l[from] === '└');
  return out.slice(i, end).map(l => l.slice(from).replace(/^│ (.*?) *│.*$/, '$1')).filter(Boolean);
};
// titles(s) — the footer's box titles in reading order, row by row.
const titles = s => rows(s).flatMap((l, i, all) => (i > 0 && /┌/.test(all[i - 1]) ? [...l.matchAll(/│ (\S[^│]*?) +│/g)].map(m => m[1]) : []));

test('AC5: in vm+workstation and workstation mode, a cloud virtual machines box directly after gcp workstations, a line per cloud VM in list order: its agents and its state', () => {
  for (const mode of ['vm+workstation', 'workstation']) {
    const s = stateOf(project(mode));
    assert.deepEqual(titles(s), ['control', 'models', 'gcp workstations', 'cloud virtual machines', ...(mode === 'vm+workstation' ? ['local virtual machines'] : [])], mode);   // ASS-486: the local VMs rightmost
    assert.deepEqual(box(s), [
      'cloud virtual machines',
      'vm-1 🤖x2 running',   // the holder's ticket matched whatever its case; not variation B, not another project's
      'vm-2 stopped',        // stopped (its own idle stop); idle, so no 🤖x0 (ASS-485 AC6)
      'vm-3 starting',       // control starting it
      'vm-4 connecting',     // connected, not set up yet
      'vm-5 sign in needed seat lost',
      'vm-6 setup failed seat lost',
      'vm-7 start timed out seat lost',
    ], mode);
    assert.deepEqual(box(s, 'gcp workstations'), ['gcp workstations', 'ws-1 running'], 'the workstations box lists workstations alone');
  }
});

test('AC5: running in green; sign in needed, setup failed, start timed out and seat lost in red', () => {
  const raw = platform(stateOf(project('workstation')), screen.columns, screen.now).join('\n');
  for (const word of ['sign in needed', 'setup failed', 'start timed out', 'seat lost']) assert.ok(raw.includes(`\x1b[31m${word}`), word);
  assert.ok(raw.includes('\x1b[32mrunning'));
});

test('AC5: with cloud VMs alone, the box comes directly after models; in vm mode, with no cloud VMs, or with dev-environments wrong, none', () => {
  const alone = stateOf(project('workstation', [vm('vm-2'), vm('vm-1')]));
  assert.deepEqual(titles(alone), ['control', 'models', 'cloud virtual machines']);
  assert.deepEqual(box(alone), ['cloud virtual machines', 'vm-2 stopped', 'vm-1 🤖x2 running']);
  for (const p of [project('vm'), project('workstation', [ws('ws-1')]), { ...project('workstation'), devEnvironments: null }]) assert.equal(box(stateOf(p)), null);
});

test('AC5: a long id is cut to the workstations box\'s width with an ellipsis, and the footer fits 120 columns with control, models, gcp workstations and cloud virtual machines — the last on a row of its own under the others when one row would not fit', () => {
  const long = 'harness-cloud-vm-with-a-very-long-name';
  const s = stateOf(project('workstation', [ws('workstation-with-a-very-long-name-indeed'), vm(long), vm('vm-7')], { [long]: live['vm-1'], 'vm-7': live['vm-7'], 'workstation-with-a-very-long-name-indeed': live['vm-5'] }));
  const out = render(s, screen).map(strip);
  const tops = out.map((l, i) => (/┌/.test(l) ? i : -1)).filter(i => i >= 0).slice(-2);
  assert.match(out[tops[0] + 1], /│ control +│ {4}│ models +│ {4}│ gcp workstations +│$/);
  assert.match(out[tops[1] + 1], /^ *│ cloud virtual machines +│$/, 'wrapped under the others, directly after them');
  const vmLines = out.slice(tops[1] + 1, out.findLastIndex(l => /└/.test(l))).map(l => l.trim().replace(/^│ (.*?) *│$/, '$1'));
  assert.deepEqual(vmLines, ['cloud virtual machines', 'harness-cloud-vm-wi… 🤖x2 running', 'vm-7 start timed out seat lost']);
  const boxes = out.slice(tops[0], out.findLastIndex(l => /└/.test(l)) + 1);
  assert.ok(boxes.every(l => visible(l) <= screen.columns), boxes.join('\n'));   // whole: none cut at the right
  assert.match(out.at(-1), /press \? for menu/);
  // Short ids: all four on one row, within the 120 columns.
  const short = stateOf(project('workstation', [ws('ws-1'), vm('vm-1')]));
  const row = render(short, screen).map(strip).filter(l => /┌/.test(l)).at(-1);
  assert.ok(visible(row) <= screen.columns, row);
  assert.equal((row.match(/┌/g) ?? []).length, 4, row);
});

// ASS-485: the sprint the holders run, on engine e: plan an agent step, lint a script step. S-1 A at lint, its B at
// plan; S-2 A at plan; S-3 A at lint but at its gate; S-4 A at lint but paused; S-5 A at lint. Agents on S-1 A and S-2 A.
const steps = [
  { id: 'plan', name: 'Plan', sequence: 1, action: { type: 'prompt' } },
  { id: 'lint', name: 'Lint', sequence: 2, action: { type: 'script' } },
  { id: 'done', name: 'Done', sequence: 3, 'is-done': true },
];
const status = (state, extra = {}) => ({ 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const gated = { 'gate-when-leaving-state': ['e/lint'], 'state-changes': [{ 'to-state': 'lint', 'work-is-done': true, 'pending-move': { from: 'lint', to: 'done', reason: 'exit' } }] };
const item = (key, variations) => ({ key, title: 'T', priority: 1, variations });
const scriptSprint = {
  number: 1, start: '2026-11-04', end: '2026-11-17', bugs: [], spikes: [],
  features: [
    item('s-1', [{ name: 'A', ...status('lint') }, { name: 'B', ...status('plan') }]),
    item('S-2', [{ name: 'A', ...status('plan') }]),
    item('S-3', [{ name: 'A', ...status('lint', gated) }]),
    item('S-4', [{ name: 'A', ...status('lint', { 'is-paused': true }) }]),
    item('S-5', [{ name: 'A', ...status('lint') }]),
  ],
};
const holding = (ticket, variation) => running({ ticket, variation, folder: '/home/u/harness', since: at });
const scriptLive = { 'vm-a': holding('S-1', 'A'), 'vm-b': holding('S-1', 'B'), 'vm-c': holding('S-2', 'A'), 'vm-d': holding('S-3', 'A'), 'vm-e': holding('S-4', 'A'), 'vm-f': running(), 'vm-g': holding('S-5', 'A') };
const scripted = (mode = 'workstation', list = Object.keys(scriptLive).map(vm), workstations = scriptLive) => initialState({
  projects: [{ ...project(mode, list, workstations), stateEngine: 'e', sprint: scriptSprint }],
  workflows: [{ name: 'e', steps }], assignments: [agent('X', 'S-1', 'A'), agent('Y', 'S-2', 'A')], controls: { p: { pid: 1, startTime: '2026-11-17T15:51:00Z' } },
});

test('ASS-485 AC1/AC2/AC3: 💻 right after the agent count while the variation holding the cloud VM runs a script step, by the sprint screen\'s rule; none on an agent step, at a gate, paused or with no holder', () => {
  for (const mode of ['vm+workstation', 'workstation']) {
    assert.deepEqual(box(scripted(mode)), [
      'cloud virtual machines',
      'vm-a 🤖x1 💻 running',   // S-1 A at lint with an agent, its key matched whatever its case
      'vm-b running',           // S-1 B, the other variation, on its agent step: idle, nothing
      'vm-c 🤖x1 running',      // S-2 A's agent on its agent step: no 💻
      'vm-d running',           // S-3 A at its gate
      'vm-e running',           // S-4 A paused
      'vm-f running',           // no holder
      'vm-g 💻 running',        // S-5 A at lint, no agent: 💻 alone (ASS-485 AC6)
    ], mode);
  }
});

test('ASS-485 AC2: on a past day no cloud VM\'s line shows 💻', () => {
  const s = scripted();
  const p = s.projects[0];
  const past = { ...s, day: '2026-11-16', projects: [{ ...p, days: { '2026-11-16': p.sprint } }] };
  assert.ok(!box(past).some(l => l.includes('💻')), box(past).join('\n'));
});

test('ASS-485 AC4: with 💻 on the longest line — a long id, the agent count, start timed out and seat lost — the footer still fits 120 columns, the cloud virtual machines box wrapping under the others as before', () => {
  const long = 'harness-cloud-vm-with-a-very-long-name';
  const wsLong = 'workstation-with-a-very-long-name-indeed';
  const s = scripted('workstation', [ws(wsLong), vm(long), vm('vm-7')], { [wsLong]: { ...live['vm-5'], holder: scriptLive['vm-a'].holder }, [long]: { ...live['vm-7'], holder: scriptLive['vm-a'].holder }, 'vm-7': live['vm-7'] });
  assert.deepEqual(box(s), ['cloud virtual machines', 'harness-cloud-vm-wi… 🤖x1 💻 start timed out seat lost', 'vm-7 start timed out seat lost']);
  assert.deepEqual(box(s, 'gcp workstations'), ['gcp workstations', 'workstation-with-a-… 🤖x1 💻 sign in needed seat lost']);
  const out = render(s, screen).map(strip);
  const tops = out.map((l, i) => (/┌/.test(l) ? i : -1)).filter(i => i >= 0).slice(-2);
  assert.match(out[tops[0] + 1], /│ control +│ {4}│ models +│ {4}│ gcp workstations +│$/);
  assert.match(out[tops[1] + 1], /^ *│ cloud virtual machines +│$/);
  const boxes = out.slice(tops[0], out.findLastIndex(l => /└/.test(l)) + 1);
  assert.ok(boxes.every(l => visible(l) <= screen.columns), boxes.join('\n'));
  assert.match(out.at(-1), /press \? for menu/);
  // Short ids with 💻 (ASS-485 AC6: no seat count): all four boxes on one row within the 120 columns.
  const short = scripted('workstation', [ws('ws-1'), vm('vm-a')], { 'ws-1': scriptLive['vm-a'], 'vm-a': scriptLive['vm-a'] });
  const lines = render(short, screen).map(strip);
  const row = lines.filter(l => /┌/.test(l)).at(-1);
  assert.ok(visible(row) <= screen.columns, row);
  assert.equal((row.match(/┌/g) ?? []).length, 4, row);
  assert.ok(lines.some(l => l.includes('│ ws-1 🤖x1 💻 running')) && lines.some(l => l.includes('│ vm-a 🤖x1 💻 running')), lines.join('\n'));
});
