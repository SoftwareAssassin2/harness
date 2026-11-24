// ASS-572: a realistic compute network screen (n) for tests and the change notes' sample render — generic names only
// (the privacy test forbids real ones). Project "orbit" runs on a workstation (ws-east), a cloud VM (vm-west) and the
// Mac (worktrees, a Substrate cluster), beside a second project ("atlas") that shares the Mac.
import { initialState } from '../../src/tui/app.js';
import { visible, clip, from } from '../../src/tui/text.js';

export const G = 2 ** 30;
export const NOW = Date.parse('2026-11-23T12:00:00Z');
export const iso = ms => new Date(ms).toISOString();

// reading(…) — a workstations.json `usage` reading: memory, CPU samples (percent of one core), its work disk.
export const reading = ({ totalGib, usedGib, cores, cpu, disk, at = NOW - 30e3 }) => ({
  at: iso(at), error: null,
  memory: { 'total-bytes': totalGib * G, 'available-bytes': (totalGib - usedGib) * G },
  cpu: { cores, samples: [{ at: iso(at - 60e3), percent: cpu }, { at: iso(at), percent: cpu }] },
  disk: { folder: '/home/u/harness', 'total-bytes': disk.total * G, 'used-bytes': (disk.total - disk.free) * G, 'available-bytes': disk.free * G },
});
// remoteBudget(…) — a remote-seats.json entry, measured.
export const measured = ({ seats, held, why = 'one more ticket fits', admit = true, memUsed, memBudget, cpu, cpuBudget, disk, substrate = null, limits = { memory: 90, cpu: 90 } }) => ({
  seats, held, pending: 0, state: 'measured', why, admit, limits,
  'memory-used-bytes': memUsed * G, 'memory-budget-bytes': memBudget * G, 'cpu-percent': cpu, 'cpu-budget-percent': cpuBudget,
  'per-ticket': { 'memory-bytes': 4 * G, 'cpu-percent': 100 },
  ...(substrate ? { substrate } : {}),
  disk: { folder: '/home/u/harness', 'total-bytes': disk.total * G, 'used-bytes': (disk.total - disk.free) * G, 'free-bytes': disk.free * G, 'hold-bytes': 15e9, 'warn-bytes': 50e9, 'release-bytes': 50e9, held: disk.held ?? false },
});
export const seatBudget = (extra = {}, mac = {}) => ({
  seats: 3, share: 50, 'share-source': 'split',
  allotment: { seats: 3, 'memory-bytes': 20 * G, 'cpu-percent': 540 },
  used: { seats: 1, starting: 0, 'memory-bytes': 4 * G, 'cpu-percent': 120, substrate: { 'memory-bytes': 1.4 * G, 'cpu-percent': 10, running: true } },
  lends: { 'memory-bytes': 0, 'cpu-percent': 0 }, borrows: { 'memory-bytes': 0, 'cpu-percent': 0 },
  'per-ticket': { 'memory-bytes': 1.5 * G, 'cpu-percent': 100 },
  mac: { 'memory-used-bytes': 30.2 * G, 'memory-budget-bytes': 43.2 * G, 'memory-total-bytes': 48 * G, 'cpu-percent': 168, 'cpu-budget-percent': 1260, 'cpu-capacity-percent': 1400, over: [], ...mac },
  ...extra,
});
export const diskSpace = (extra = {}) => ({ level: 'ok', 'free-bytes': 240 * G, 'total-bytes': 931 * G, 'warn-bytes': 50e9, 'hold-bytes': 15e9, ...extra });

const ws = id => ({ id, 'gcp-project': 'example-gcp', region: 'r', cluster: 'c', config: 'cfg' });
const cvm = id => ({ kind: 'cloud-vm', id, 'gcp-project': 'example-gcp', zone: 'z' });
const at = state => ({ 'harness-status': { state, 'state-engine': 'e' } });

export const orbit = (extra = {}) => ({
  id: 'orbit', name: 'Orbit', stateEngine: 'e', environments: [],
  sprint: { number: 4, start: '2026-11-17', end: '2026-11-30', bugs: [], spikes: [], features: [
    { key: 'ORB-101', title: 'T', variations: [{ name: 'A', ...at('build'), sandbox: { name: 'orb-101-a', machine: 'vm-west', state: 'running', at: iso(NOW - 600e3) } }] },
    { key: 'ORB-102', title: 'T', variations: [{ name: 'A', ...at('plan') }] },
    { key: 'ORB-103', title: 'T', variations: [{ name: 'A', ...at('review'), sandbox: { name: 'orb-103-a', machine: 'ws-east', state: 'stopped', at: iso(NOW - 3600e3) } }] },
    { key: 'ORB-104', title: 'T', variations: [{ name: 'A', ...at('build'), sandbox: { name: 'orb-104-a', machine: 'ws-east', state: 'running', at: iso(NOW - 7200e3) } }] },
    { key: 'ORB-105', title: 'T', variations: [{ name: 'A', ...at('review'), build: { 'worktree-folder': '/w/ORB-105' } }] },
  ] },
  devEnvironments: { mode: 'vm+workstation', workstations: [ws('ws-east'), cvm('vm-west')] },
  runTargets: ['cloud-vm-substrate', 'workstation-substrate', 'workstation-worktree', 'cloud-vm-worktree', 'local-worktree'],
  runTargetPlan: { targets: ['cloud-vm-substrate', 'workstation-substrate', 'workstation-worktree', 'cloud-vm-worktree', 'local-worktree'], derived: false, mode: 'vm+workstation', docker: new Set(), poolChoice: null },
  substrateMachines: ['ws-east', 'vm-west'],
  workstations: {
    'ws-east': { state: 'running', connected: true, setup: { ok: true }, usage: reading({ totalGib: 31.3, usedGib: 9.6, cores: 8, cpu: 140, disk: { total: 196, free: 116 } }),
      holder: { ticket: 'ORB-102', variation: 'A', worktree: true, since: iso(NOW - 300e3) } },
    'vm-west': { state: 'running', connected: true, setup: { ok: true }, usage: reading({ totalGib: 15.6, usedGib: 12.9, cores: 4, cpu: 210, disk: { total: 96, free: 31 } }) },
  },
  remoteBudget: {
    'ws-east': measured({ seats: 3, held: 2, memUsed: 9.6, memBudget: 28.2, cpu: 140, cpuBudget: 720, disk: { total: 196, free: 116 }, substrate: { 'memory-bytes': 2.75 * G, 'cpu-percent': 30, running: true } }),
    'vm-west': measured({ seats: 1, held: 1, why: 'one more ticket would pass its memory limit', admit: false, memUsed: 12.9, memBudget: 14.0, cpu: 210, cpuBudget: 360, disk: { total: 96, free: 31 }, substrate: { 'memory-bytes': 2.75 * G, 'cpu-percent': 30, running: true } }),
  },
  seats: [
    { key: 'ORB-101', variation: 'A', kind: 'cloud-vm', workstation: 'vm-west', target: 'cloud-vm-substrate', since: iso(NOW - 600e3) },
    { key: 'ORB-102', variation: 'A', kind: 'workstation', workstation: 'ws-east', target: 'workstation-worktree', since: iso(NOW - 300e3) },
    { key: 'ORB-104', variation: 'A', kind: 'workstation', workstation: 'ws-east', target: 'workstation-substrate', since: iso(NOW - 7200e3) },
  ],
  localSeats: [],
  substrate: {
    'ws-east': { state: 'healthy', 'checked-at': iso(NOW - 60e3), usage: { 'sandbox-use': {
      'orb-103-a': { state: 'suspended', 'snapshot-bytes': 0.4 * G },
      'orb-104-a': { state: 'crashed' },
    } } },
    'vm-west': { state: 'healthy', 'checked-at': iso(NOW - 60e3), usage: { 'sandbox-use': { 'orb-101-a': { state: 'running', 'memory-bytes': 6.1 * G, 'cpu-percent': 150 } } } },
  },
  seatBudget: seatBudget(),
  golden: { name: 'golden-orbit', 'built-at': '2026-11-18T09:00:00Z' },
  sandboxImages: { amd64: { label: { hash: 'h1', 'built-at': '2026-11-23T10:21:46Z' }, run: { hash: 'h1', 'started-at': '2026-11-23T09:51:38Z', 'ended-at': '2026-11-23T10:21:46Z', 'exit-code': 0 } } },
  ...extra,
});
export const atlas = (extra = {}) => ({
  id: 'atlas', name: 'Atlas', sprint: null, devEnvironments: { mode: 'vm', workstations: [] }, workstations: {}, seats: [], runTargets: ['local-vm'],
  seatBudget: seatBudget({ share: 50 }), ...extra,
});
// A worktree step (ASS-554: worktree targets only) where ORB-102 is, a build step, a human gate.
export const workflows = [{ name: 'e', steps: [
  { id: 'plan', name: 'Write Plan', sequence: 1, worktree: true, action: { type: 'prompt' } },
  { id: 'build', name: 'Build', sequence: 2, action: { type: 'prompt' } },
  { id: 'review', name: 'Code Review', sequence: 3, action: { type: 'human' } },
] }];
export const team = [
  { project: 'orbit', 'agent-name': 'X', 'work-item': 'ORB-101', variation: 'A', model: 'opus-5' },
  { project: 'orbit', 'agent-name': 'Y', 'work-item': 'ORB-102', variation: 'A', model: 'opus-5' },
  { project: 'orbit', 'agent-name': 'Z', 'work-item': 'ORB-102', variation: 'A', model: 'haiku-5' },
];
// onN(projects, { project, disk, assignments }) — the dashboard on the n screen.
export const onN = (projects, { project = 0, disk = diskSpace(), assignments = team, workflows: engines = workflows, ...rest } = {}) =>
  ({ ...initialState({ projects, workflows: engines, assignments, disk }), screen: 'n', project, ...rest });

export const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
// cardOf(lines, id) — the card of machine `id` ('mac' for the Mac) in the n screen's lines, colors stripped:
// { title (its top border), lines (its inside, trailing spaces trimmed) }, or null. Cards may stand side by side.
export function cardOf(lines, id) {
  const plain = lines.map(strip);
  const head = new RegExp(`┌─ ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( ·| )`);
  const i = plain.findIndex(l => head.test(l));
  if (i < 0) return null;
  const start = visible(plain[i].slice(0, plain[i].search(head)));
  const width = visible(plain[i].slice(plain[i].search(head)).replace(/┐.*$/, '┐'));
  const cut = l => clip(from(l, start), width);
  const out = [];
  for (let n = i + 1; n < plain.length; n++) {
    const row = cut(plain[n]);
    if (row.startsWith('└') || !row.startsWith('│')) break;
    out.push(row.slice(2).replace(/│$/, '').trimEnd());
  }
  return { title: cut(plain[i]), lines: out.filter((l, k, a) => l || a.slice(k).some(Boolean)) };
}
// onIt(card) — the card's "On it" entries, each whole (the label and hang taken off, a wrapped entry joined).
export function onIt(c) {
  const i = c.lines.findIndex(l => l.startsWith('On it'));
  if (i < 0) return [];
  const out = [c.lines[i].slice(8)];
  for (const l of c.lines.slice(i + 1)) {
    if (l.startsWith(' '.repeat(11))) out[out.length - 1] += ` ${l.trim()}`;
    else if (l.startsWith(' '.repeat(8)) && !/^ +(lends|allotted|used)/.test(l)) out.push(l.slice(8));
    else break;
  }
  return out;
}
// crowd(p, n, { machine, from }) — ASS-590: n more tickets on one machine, each a worktree kept there between steps
// (idle), keys ORB-<from>… in order; returns their keys. For cards with more than four tickets.
export function crowd(p, n, { machine = 'ws-east', from = 201 } = {}) {
  const keys = Array.from({ length: n }, (_, i) => `ORB-${from + i}`);
  for (const key of keys) p.sprint.features.push({ key, title: 'T', variations: [{ name: 'A', ...at('review'), 'remote-worktrees': [{ name: machine }] }] });
  return keys;
}
