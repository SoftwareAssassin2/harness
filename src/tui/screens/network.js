// The compute network screen (n, ASS-557; per project since ASS-569; redesigned by ASS-572): for the project on screen
// (the one the left and right arrows pick), where its next ticket goes, which of its machines have room, and why a
// machine isn't taking work — the operator's three questions, in that order:
// 1. The headline: "<project> · N machines · N can take work · N of M seats in use · next ticket → <machine> (<why>)".
//    The next ticket's place is the planner's own answer (plan.js nextPlacement: planDispatch's `next`, placed by the
//    same choose() and pool choice — remote-first, most-room, first, ASS-553 — as every holder), never worked out here.
//    When nothing has room it says why instead, in red: each machine's short verdict.
// 2. One card per machine (boxes.js card), in placement order: the next ticket's machine first, then the others that can
//    take work in the order the project's pool choice would try them (pool-choice.js macRoom / machineRoom: most room
//    first for remote-first and most-room — remote machines before the Mac for remote-first — run-target order for
//    first), then those that can't, the Mac last when the project can't run work on it (ASS-580: its card is always
//    shown, with its gray "no work" verdict, counted in the headline but never its next machine). Two cards a row from 120 columns, one a row narrower. Each card:
//    - its title: the machine and its kind ("mac · shared by N projects" for the Mac, while other projects use it too),
//      and its status: ● running (green), ● starting / connecting (amber), ○ stopped (gray: started on demand),
//      ● unreachable / setup failed / sign-in needed / start timed out (red); a stopped or not freshly measured
//      machine's last figures are gray, their age after its status;
//    - CPU, RAM and Disk gauges (gauge.js): the bar the machine's whole, the │ the harness's limit (a disk's: where its
//      free space reaches its hold), green well under, amber within 10 points, red over. CPU as a percent of the whole
//      machine (its 5-minute average), never per core. The Mac's are the whole Mac's (seat-budget.json `mac`, every
//      control writes the same; disk-space.json for its disk), a remote machine's its own (remote-seats.json, else its
//      last reading in workstations.json);
//    - Seats: ■ per seat its project's tickets hold there, □ per seat free under the current rule (the Mac: its
//      seat-budget.json `seats`, a remote machine: remote-seats.json's), then a plain verdict — "can take N more",
//      "full: one more would pass its memory limit", "held: disk below its 15 GB hold …", "stopped: starts on demand
//      (up to 15 min)", ASS-575: "starting · waited m of n min" while control waits for it to boot (boot-waits.json),
//      "no work: didn't come up within n min; work goes elsewhere until it's up" once that wait ran out (control then
//      counts it as lost, and so does the dashboard's planner: shared.js planProject's bootWaitOver, so the headline never
//      names it), "no work: <why it can't be used>"…;
//    - Cluster: its Substrate cluster's state and the project's part of it (memory, CPU), red with its troubles;
//    - Image (ASS-580): the sandbox image its cluster runs for the project (the Mac's architecture on the Mac, amd64 on
//      a remote machine): built <day> UTC, building (amber), build failed (red), none (gray);
//    - On it: every one of the project's tickets there (machine-tickets.js ticketsOn), one a line, cut with an ellipsis
//      to the card's width, never wrapped (ASS-590);
//    - the Mac's Share line(s): the project's share of the harness's budget, its allotment, its use, what it lends or
//      borrows (seat-budget.json).
// 3. The project line: its agents per model, its golden image (name, the day it was built), and any sandbox image no
//    card shows (never one twice on the screen).
// 4. The legend, gray.
// On a terminal too short for every card the cards are cut a row at a time from the bottom, and a gray "+N machines
// below" says how many are hidden; the headline and the legend always show. Read-only, no keys of its own; it
// refreshes with the dashboard. The ASS-569 table, ASS-566's machine boxes and the pool summary are gone: the cards
// carry what they showed.
import { visible, wrapParts, wrapLine } from '../text.js';
import { ellipsis, gray, red, green, projectAssignments, nextPlace } from './shared.js';
import { workstationState, cloudVmState } from '../../control/workstation-machines.js';
import { lostWhy } from '../../control/seat-kinds.js';
import { bootWaitOf } from '../../control/boot-waits.js';
import { HOST_OF, BOOT_WAIT_SECONDS } from '../../control/run-targets.js';
import { macRoom, machineRoom, rank } from '../../control/pool-choice.js';
import { imageBuildFailed } from '../../control/substrate-config.js';
import { utcDate } from '../../downloader/cycle.js';
import { clusterTrouble } from '../machine-health.js';
import { usesVms } from '../../control/dev-environments.js';
import { card, cardRow } from '../boxes.js';
import { gauge, tone as toneOf, AMBER } from '../gauge.js';
import { ticketsOn, KIND_WORDS, ICONS } from '../machine-tickets.js';
import { RUNS_IN } from '../places.js';

const GIB = 2 ** 30;
const CPU_WINDOW = 5 * 60e3, FRESH = 5 * 60e3;   // remote-seats.js CPU_WINDOW, READING_STALE
export const TWO_UP = 120, GAP = 2, LABEL = 8;
const MAC_SEAT_TARGETS = new Set(['local-vm', 'local-substrate']), MAC_FREE_TARGETS = new Set(['local-worktree', 'local-workspace']);
const TONES = { green, amber: AMBER, red, gray };

// num(bytes) — GiB, one decimal under 100, whole above: "12.3", "512".
const num = bytes => { const g = bytes / GIB; return g >= 100 ? String(Math.round(g)) : g.toFixed(1); };
const gb = bytes => String(Math.round((bytes ?? 0) / 1e8) / 10);   // a level in harness.json's GB (10^9 bytes)
const has = n => typeof n === 'number' && Number.isFinite(n);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// age(at, now) — how long ago: "40s", "12m", "3h", "2d".
export function age(at, now) {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}
const minutes = seconds => Math.round(seconds / 60);
const bootWords = project => `up to ${minutes(Number(project.bootWaits?.['wait-seconds'] ?? BOOT_WAIT_SECONDS))} min`;

// ===== The machines' facts =====

// usesMac(project) — whether the project can run work on the Mac, so gets a usable Mac card: Lima VMs (its mode), a run target
// on the Mac, or a Substrate cluster declared there — or its dev-environments unread or wrong (the Mac is where work
// then goes). Its own here (ASS-572), not the footer's machine-health groups, which ask another question.
const MAC_TARGETS = new Set(['local-workspace', 'local-worktree', 'local-substrate']);
export function usesMac(project) {
  if (!project) return false;
  const settings = project.devEnvironments;
  const targets = Array.isArray(project.runTargets) ? project.runTargets : [];
  return !settings || usesVms(settings.mode) || targets.some(t => MAC_TARGETS.has(t)) || (project.substrateMachines ?? []).includes('mac');
}

// macMachine(state, project, now) — the Mac's card facts for `project`: the whole Mac's CPU, RAM and disk; the
// project's seats there, its verdict and share.
function macMachine(state, project) {
  const usable = usesMac(project);
  const budget = project.seatBudget ?? null;
  const mac = (budget?.mac ?? (state.projects ?? []).map(p => p.seatBudget?.mac).find(Boolean)) ?? {}, over = mac.over ?? [];
  const disk = state.disk;
  const targets = Array.isArray(project.runTargets) && project.runTargets.length ? project.runTargets : ['local-vm'];
  const seated = targets.some(t => MAC_SEAT_TARGETS.has(t)), free = targets.some(t => MAC_FREE_TARGETS.has(t));
  const capacity = mac['cpu-capacity-percent'];
  const held = budget?.used?.seats ?? 0, possible = budget ? (has(budget.seats) ? budget.seats : Infinity) : Infinity;
  const diskHeld = disk?.level === 'hold';
  const memoryHold = (state.projects ?? []).some(p => p.memoryHold);
  const vmsHeld = memoryHold && targets.includes('local-vm');
  const word = diskHeld ? 'disk held' : over.includes('unread') ? 'not read' : 'running';
  const room = possible - held;
  let verdict;
  if (diskHeld) verdict = { text: `held: disk below its ${gb(disk['hold-bytes'])} GB hold — nothing starts until ${gb(disk['warn-bytes'])} GB is free`, tone: 'red', short: 'disk held' };
  else if (!seated && !free) verdict = { text: 'no work: none of its run targets is on the Mac', tone: 'gray', short: 'no Mac run target' };
  else if (!seated) verdict = { text: 'none needed: worktrees on the Mac take no seat', tone: 'green', short: 'no seat needed' };
  else if (over.includes('unread')) verdict = { text: "no new seats: the Mac's memory and CPU can't be read", tone: 'red', short: 'not read' };
  else if (over.some(o => o === 'memory' || o === 'cpu')) { const why = over.filter(o => o === 'memory' || o === 'cpu'); verdict = { text: `full: the Mac is over its ${why.join(' and ')} limit`, tone: 'red', short: `full (${why.join(', ')})` }; }
  else if (vmsHeld && room > 0) verdict = { text: 'held: out of memory — no VM starts until memory is freed', tone: 'red', short: 'out of memory' };
  else if (room > 0) verdict = { text: room === Infinity ? 'can take more (no seat budget yet)' : `can take ${room} more`, tone: 'green' };
  else {
    const allot = budget?.allotment?.seats;
    verdict = has(allot) && held >= allot ? { text: `full: at its allotment of ${plural(allot, 'ticket')}`, tone: 'amber', short: 'full (allotment)' }
        : { text: "full: one more would pass the Mac's budget", tone: 'amber', short: 'full' };
  }
  if (seated && free && !diskHeld) verdict = { ...verdict, text: `${verdict.text} · worktrees take no seat` };
  const canTake = !diskHeld && (free || (seated && room > 0 && !over.length && !vmsHeld));
  return {
    id: 'mac', kind: 'mac', word, fresh: true, ago: '',
    sharedBy: (state.projects ?? []).filter(usesMac).length,
    cpu: has(mac['cpu-percent']) && has(capacity) && capacity > 0 ? { used: mac['cpu-percent'] / capacity * 100, limit: has(mac['cpu-budget-percent']) ? mac['cpu-budget-percent'] / capacity * 100 : null } : null,
    ram: has(mac['memory-used-bytes']) ? { used: mac['memory-used-bytes'], limit: mac['memory-budget-bytes'] ?? null, total: mac['memory-total-bytes'] ?? null } : null,
    disk: has(disk?.['free-bytes']) ? { free: disk['free-bytes'], total: disk['total-bytes'] ?? null, hold: disk['hold-bytes'] ?? null, warn: disk['warn-bytes'] ?? null, held: diskHeld, low: disk.level === 'warn' } : null,
    seats: seated ? { held, possible } : null, verdict, canTake, room: macRoom(budget),
    cpuCapacity: capacity ?? null,
    // ASS-580: a project that can't run work on the Mac still gets its card (the Mac runs control, the forwarder,
    // Hindsight and the registry for every project), with its gray verdict, the whole Mac's gauges and no Share line.
    noWork: !usable,
    cluster: usable || project.substrate?.mac ? clusterFacts(project.substrate?.mac, usable ? budget?.used?.substrate : null, state.disk, capacity) : null,
    share: !usable ? null : budget ? shareFacts(budget, capacity) : { missing: true },
    images: machineImages(project, 'mac', macArch()),
  };
}

// lastReading(entry) — a remote machine's last figures, whatever their age: { at, cpu, ram, disk } (null parts unread).
function lastReading(entry) {
  const u = entry?.usage;
  if (!u) return null;
  const samples = (u.cpu?.samples ?? []).filter(s => has(s?.percent));
  const last = samples.length ? Date.parse(samples.at(-1).at) : NaN;
  const recent = samples.filter(s => !(last - Date.parse(s.at) > CPU_WINDOW));
  const total = u.memory?.['total-bytes'], avail = u.memory?.['available-bytes'];
  const d = u.disk;
  return {
    at: u.at ?? null,
    cores: u.cpu?.cores ?? null,
    cpu: recent.length ? recent.reduce((a, s) => a + s.percent, 0) / recent.length : null,
    ram: has(total) && has(avail) ? { used: Math.max(0, total - avail), total } : null,
    disk: d && has(d['total-bytes']) ? { free: d['available-bytes'], total: d['total-bytes'] } : null,
  };
}

// remoteMachine(project, w, now) — a workstation's or cloud VM's card facts.
function remoteMachine(project, w, now) {
  const entry = project.workstations?.[w.id], b = project.remoteBudget?.[w.id];
  const cloud = w.kind === 'cloud-vm';
  const raw = (cloud ? cloudVmState : workstationState)(entry);
  const lost = lostWhy(entry);
  const word = lost && raw === 'stopped' ? 'unreachable' : raw;
  const r = lastReading(entry);
  const fresh = b?.state === 'measured' || (word === 'running' && r?.at && now - Date.parse(r.at) <= FRESH);
  const limits = { memory: b?.limits?.memory ?? w['max-memory-percent'] ?? null, cpu: b?.limits?.cpu ?? w['max-cpu-percent'] ?? null };
  const capacity = has(r?.cores) && r.cores > 0 ? r.cores * 100 : has(b?.['cpu-budget-percent']) && has(limits.cpu) && limits.cpu > 0 ? b['cpu-budget-percent'] / limits.cpu * 100 : null;
  const cpuUsed = b?.state === 'measured' ? b['cpu-percent'] : r?.cpu;
  const ramTotal = r?.ram?.total ?? null;
  const ramUsed = b?.state === 'measured' ? b['memory-used-bytes'] : r?.ram?.used;
  const ramLimit = has(b?.['memory-budget-bytes']) ? b['memory-budget-bytes'] : has(ramTotal) && has(limits.memory) ? ramTotal * limits.memory / 100 : null;
  const dk = b?.disk && has(b.disk['total-bytes']) ? { free: b.disk['free-bytes'], total: b.disk['total-bytes'] } : r?.disk;
  const hold = b?.disk?.['hold-bytes'] ?? 15e9, warn = b?.disk?.['warn-bytes'] ?? 50e9;
  const diskHeld = b?.disk?.held === true || Boolean(dk && has(b?.disk?.['hold-bytes']) && dk.free < hold);
  const held = b?.held ?? (project.seats ?? []).filter(s => s?.workstation === w.id && s.kind !== 'vm').length;
  const possible = b?.seats ?? Math.max(held, 1);
  const room = possible - held;
  const label = { 'sign in needed': 'sign-in needed' }[word] ?? word;
  // ASS-575: its boot wait (control's boot-waits.json, boot-waits.js bootWaitOf) — past it the machine is lost to
  // control (seats.js bootWaits), so to the planner here too; within it, how long it has waited.
  const boot = bootWaitOf(project.bootWaits, entry, w.id, now);
  let verdict;
  if (lost || word === 'sign in needed' || word === 'setup failed') verdict = { text: `no work: ${lost ?? (word === 'sign in needed' ? 'its gcloud login needs reauthentication' : 'its setup failed')}`, tone: 'red', short: label };
  else if (b?.state === 'unread') verdict = { text: `no new work: its reading failed (${b.why})`, tone: 'red', short: 'reading failed' };
  else if (diskHeld) verdict = { text: `held: disk below its ${gb(hold)} GB hold (${dk ? num(dk.free) : '?'} GiB free${b?.disk?.folder ? ` at ${b.disk.folder}` : ''}) — no new ticket until ${gb(b?.disk?.['release-bytes'] ?? warn)} GB is free`, tone: 'red', short: 'disk held' };
  else if (boot?.over) verdict = { text: `no work: didn't come up within ${minutes(boot.seconds)} min; work goes elsewhere until it's up`, tone: 'red', short: "didn't come up" };
  else if (boot) verdict = { text: `starting · waited ${Math.floor(boot.waited / 60)} of ${minutes(boot.seconds)} min${room > 0 ? ` · can take ${room}` : ''}`, tone: 'amber', short: 'starting' };
  else if (!fresh && word !== 'running') verdict = room > 0 ? { text: `${label}: starts on demand (${bootWords(project)}) · can take ${room}`, tone: 'gray', short: `${label} (starts on demand)` }
    : { text: `${label}: holds ${held}, takes no more until it is measured`, tone: 'gray', short: label };
  else if (!fresh) verdict = room > 0 ? { text: `can take ${room} more (not measured yet)`, tone: 'green' } : { text: `not measured yet: holds ${held}, takes no more until it is`, tone: 'amber', short: 'not measured' };
  else if (room > 0) verdict = { text: `can take ${room} more`, tone: 'green' };
  else {
    const m = String(b?.why ?? '').match(/pass its (.+?) limit/);
    verdict = { text: `full: ${String(b?.why ?? 'no room for one more').replace('one more ticket would', 'one more would')}`, tone: 'amber', short: m ? `full (${m[1].replace(' and ', ', ')})` : 'full' };
  }
  const usable = !lost && word !== 'sign in needed' && word !== 'setup failed' && b?.state !== 'unread' && !diskHeld && !boot?.over;
  return {
    id: w.id, kind: cloud ? 'cloud-vm' : 'workstation', word, label, fresh, ago: !fresh && r?.at ? age(r.at, now) : '',
    cpu: has(cpuUsed) && has(capacity) && capacity > 0 ? { used: cpuUsed / capacity * 100, limit: limits.cpu } : null,
    ram: has(ramUsed) ? { used: ramUsed, limit: ramLimit, total: ramTotal } : null,
    disk: dk && has(dk.free) ? { free: dk.free, total: dk.total, hold, warn, held: diskHeld, low: dk.free < warn } : null,
    seats: { held, possible }, verdict, boot, canTake: usable && room > 0, room: usable ? machineRoom(b) : 0,
    cpuCapacity: capacity,
    cluster: clusterFacts(project.substrate?.[w.id], b?.substrate, null, capacity, now),
    images: machineImages(project, w.id, REMOTE_ARCH),
  };
}

// macArch(arch) — ASS-580: the Mac's own architecture as the sandbox images name it (arm64 on Apple silicon, amd64 on
// Intel): the image its cluster runs. Remote machines run the amd64 one (substrate:deliver-image).
export const macArch = (arch = process.arch) => (arch === 'x64' ? 'amd64' : 'arm64');
const REMOTE_ARCH = 'amd64';

// machineImages(project, id, arch) — ASS-580: the sandbox images a machine's cluster runs for the project, for its card:
// [{ arch, image }] (image null when none was built) while the project has a Substrate cluster on the machine; the Mac
// also shows its architecture's image when one was built for a cluster not declared (yet, or any more). [] otherwise.
function machineImages(project, id, arch) {
  const image = project.sandboxImages?.[arch] ?? null;
  const cluster = (project.substrateMachines ?? []).includes(id);
  return cluster || (id === 'mac' && image) ? [{ arch, image }] : [];
}

// clusterFacts(live, use, disk, capacity, now) — a machine's Substrate cluster for its card: its last check's state
// and troubles (machine-health.js clusterTrouble: what the header's chips say), the project's part of its memory and
// CPU (seat-budget.json used.substrate on the Mac, remote-seats.json substrate on a remote machine); null without one.
function clusterFacts(live, use, disk, capacity, now = Date.now()) {
  if (!live && !(use && use['memory-bytes'] != null)) return null;
  return { state: live?.state ?? null, troubles: clusterTrouble(live, now, disk), up: use?.running !== false, memory: use?.['memory-bytes'] ?? null, cpu: has(use?.['cpu-percent']) && capacity > 0 ? use['cpu-percent'] / capacity * 100 : null };
}

// shareFacts(budget, capacity) — the project's share of the harness's budget on the Mac (seat-budget.json): share,
// allotment, use, what it lends and borrows; CPU as a percent of the Mac.
function shareFacts(b, capacity) {
  const cpu = c => (has(c) && capacity > 0 ? c / capacity * 100 : null);
  const fig = f => ({ memory: f?.['memory-bytes'] ?? null, cpu: cpu(f?.['cpu-percent']) });
  return { share: b.share ?? null, split: b['share-source'] === 'split', allotment: b.allotment?.seats ?? null, allotted: fig(b.allotment), uses: b.used?.seats ?? 0, used: fig(b.used), lends: fig(b.lends), borrows: fig(b.borrows) };
}

// machines(state, now) — the project on screen's machines' card facts, in its pool's order: the Mac, always (ASS-580:
// a project that can't run work there gets it with its "no work" verdict), then its workstations and cloud VMs
// (dev-environments order). Remote machines are never shared between projects, so no other project's appear. []
// without a project.
export function machines(state, now = Date.now()) {
  const project = state.projects?.[state.project];
  if (!project) return [];
  const remote = (project.devEnvironments?.workstations ?? []).map(w => remoteMachine(project, w, now));
  return [macMachine(state, project), ...remote];
}

// placed(list, next, project) — the machines in placement order (see the module comment).
export function placed(list, next, project) {
  const host = m => (m.kind === 'mac' ? 'local' : m.kind);
  const targets = Array.isArray(project?.runTargets) && project.runTargets.length ? project.runTargets : ['local-vm'];
  const order = m => { const i = targets.findIndex(t => HOST_OF[t] === host(m)); return i < 0 ? targets.length : i; };
  const choice = next?.choice ?? 'first';
  const key = m => (choice === 'first' ? [order(m), 0] : [choice === 'remote-first' && m.kind === 'mac' ? 1 : 0, -rank(m.room)]);
  const able = list.filter(m => m.canTake).map((m, i) => ({ m, i })).toSorted((a, b) => { const [x, y] = [key(a.m), key(b.m)]; return x[0] - y[0] || x[1] - y[1] || a.i - b.i; }).map(e => e.m);
  const nextId = nextMachineId(next);
  const all = [...able, ...list.filter(m => !m.canTake && !m.noWork), ...list.filter(m => !m.canTake && m.noWork)];   // a Mac it can't use last (ASS-580)
  const first = all.find(m => m.id === nextId);
  return first ? [first, ...all.filter(m => m !== first)] : all;
}
const nextMachineId = next => (!next?.target ? null : HOST_OF[next.target] === 'local' ? 'mac' : next.machine ?? null);

// ===== The headline =====

const CHOICE_WORDS = { 'most-room': 'most room', first: 'first with room' };
// headline(project, list, next, columns) — its lines (one, two when too wide): see the module comment.
export function headline(project, list, next, columns) {
  const name = project.name ?? project.id;
  const can = list.filter(m => m.canTake).length;
  const seated = list.filter(m => m.seats);
  const held = seated.reduce((n, m) => n + m.seats.held, 0), possible = seated.reduce((n, m) => n + m.seats.possible, 0);
  const parts = [name, plural(list.length, 'machine'), `${can} can take work`, ...(seated.length ? [possible === Infinity ? `${held} seat${held === 1 ? '' : 's'} in use` : `${held} of ${possible} seats in use`] : [])];
  const id = nextMachineId(next);
  let tail;
  if (!list.length) tail = gray('no machines: its run targets name none');
  else if (!next?.target) {
    // A machine with a free seat now whose seats the planner gives to tickets already waiting: says so first.
    const why = [...(next?.ahead ? [`the free seats go to ${plural(next.ahead, 'ticket')} already waiting`] : []), ...list.filter(m => !m.canTake && !m.noWork).map(m => `${m.id} ${m.verdict.short ?? m.verdict.text}`)];
    tail = red(`nothing can take work${why.length ? `: ${why.join(', ')}` : ''}`);
  } else {
    const m = list.find(x => x.id === id);
    const remote = HOST_OF[next.target] !== 'local';
    const why = next.choice === 'remote-first' ? (remote ? 'remote first, most room' : 'remote machines full') : CHOICE_WORDS[next.choice] ?? next.choice;
    const runs = KIND_WORDS[RUNS_IN[next.target]] ?? next.target;
    const starts = m?.boot ? ` · it is starting: waited ${Math.floor(m.boot.waited / 60)} of ${minutes(m.boot.seconds)} min`
      : m && m.kind !== 'mac' && !m.fresh && m.word !== 'running' ? ` · it is ${m.label}: starts on demand` : '';
    tail = `next ticket → ${green(id ?? `a ${KIND_LABELS[HOST_OF[next.target]] ?? next.target}`)} (${runs}; ${why})${starts}${next.ahead ? ` · after ${plural(next.ahead, 'ticket')} already waiting` : ''}`;
  }
  const one = [...parts, tail].join(' · ');
  if (visible(one) <= columns) return [one];
  return [ellipsis(parts.join(' · '), columns), ...wrapParts([tail], columns)];
}

// ===== The cards =====

// width(columns) — a card's width: two a row from TWO_UP columns, else one across.
export const cardWidth = columns => (columns >= TWO_UP ? Math.floor((columns - GAP) / 2) : columns);
const perRow = columns => (columns >= TWO_UP ? 2 : 1);

const DOTS = { running: ['●', 'green'], starting: ['●', 'amber'], connecting: ['●', 'amber'], stopped: ['○', 'gray'] };
function status(m) {
  const [dot, t] = DOTS[m.word] ?? ['●', 'red'];
  const word = m.label ?? m.word;
  return `${TONES[t](`${dot} ${word}`)}${m.ago ? gray(` · ${m.ago} ago`) : ''}`;
}
const KIND_LABELS = { workstation: 'workstation', 'cloud-vm': 'cloud VM' };

// gaugeLine(label, figures, inner, stale) — "<label> <bar> <text>": the bar as wide as the card leaves after TEXT.
const TEXT = 29;
function gaugeLine(label, g, inner, stale) {
  const bar = Math.max(8, Math.min(40, inner - LABEL - 1 - TEXT));
  const head = label.padEnd(LABEL);
  if (!g) return `${head}${gauge({ used: null, total: null, width: bar })} ${gray('not measured yet')}`;
  const t = g.tone ?? toneOf(g.used, g.limit, g.total);
  const paint = stale ? gray : t === 'green' ? String : TONES[t];
  return `${head}${gauge({ used: g.used, total: g.total, limit: g.limit, width: bar, tone: t, stale })} ${paint(g.text)}`;
}

// figures — each gauge's numbers and words.
function cpuGauge(m) {
  if (!m.cpu) return null;
  const used = Math.round(m.cpu.used);
  return { used: m.cpu.used, total: 100, limit: m.cpu.limit, text: `${used}%${has(m.cpu.limit) ? ` · limit ${Math.round(m.cpu.limit)}%` : ''}` };
}
function ramGauge(m) {
  if (!m.ram) return null;
  const total = has(m.ram.total) ? m.ram.total : has(m.ram.limit) ? Math.max(m.ram.limit, m.ram.used) : null;
  return { used: m.ram.used, total, limit: m.ram.limit, text: `${num(m.ram.used)}${has(m.ram.total) ? ` of ${num(m.ram.total)}` : ''} GiB${has(m.ram.limit) ? ` · limit ${num(m.ram.limit)}` : ''}` };
}
function diskGauge(m) {
  const d = m.disk;
  if (!d) return null;
  const used = has(d.total) ? d.total - d.free : null;
  return {
    used, total: d.total, limit: has(d.total) && has(d.hold) ? d.total - d.hold : null, tone: d.held ? 'red' : d.low ? 'amber' : 'green',
    text: has(d.total) ? `${num(used)} of ${num(d.total)} GiB · ${num(d.free)} free` : `${num(d.free)} GiB free`,
  };
}

// seatsLine(m) — "Seats ■■□ 2 of 3 · can take 1 more".
const SQUARES = 10;
function seatsLine(m) {
  const v = TONES[m.verdict.tone](m.verdict.text);
  if (!m.seats) return `${'Seats'.padEnd(LABEL)}${v}`;
  const { held, possible } = m.seats;
  const free = possible === Infinity ? 0 : Math.max(0, possible - held);
  const squares = held + free <= SQUARES ? `${'■'.repeat(held)}${gray('□'.repeat(free))}` : `■×${held}${free ? gray(` □×${free}`) : ''}`;
  const count = possible === Infinity ? `${held} in use` : `${held} of ${possible}`;
  return `${'Seats'.padEnd(LABEL)}${squares ? `${squares}  ` : ''}${count} · ${v}`;
}

// clusterLine(c) — "Cluster ● healthy · 2.8 GiB · 3% CPU", red with its troubles.
function clusterLine(c) {
  const fig = [c.memory != null && `${num(c.memory)} GiB`, has(c.cpu) && `${Math.round(c.cpu)}% CPU`].filter(Boolean).join(' · ');
  const state = c.troubles.length ? red(`● ${c.troubles.join(', ')}`) : !c.up ? gray('○ not up') : c.state === 'healthy' || c.state == null ? green(`● ${c.state ?? 'up'}`) : AMBER(`● ${c.state}`);
  return `${'Cluster'.padEnd(LABEL)}${state}${fig ? ` · ${fig}` : ''}`;
}

// shareLines(s) — the Mac's share line(s), as parts (machineCard packs them to the card's width): the project's share of
// the harness's budget ("(split)" when project.json names none), its allotment and use in tickets (red "over" past its
// allotment), what it lends or borrows, then (gray) the memory and CPU behind the allotment and the use.
function shareLines(s) {
  if (s.missing) return [[`${'Share'.padEnd(LABEL)}${gray('no seat budget yet (control writes seat-budget.json each tick)')}`]];
  const fig = f => [has(f.memory) && `${num(f.memory)} GiB`, has(f.cpu) && `${Math.round(f.cpu)}% CPU`].filter(Boolean).join(', ');
  const some = f => (f.memory ?? 0) >= 2 ** 20 || (f.cpu ?? 0) >= 0.1;
  const uses = `uses ${s.uses}`;
  return [[
    `${'Share'.padEnd(LABEL)}${s.share ?? '?'}%${s.split ? ' (split)' : ''}`,
    s.allotment == null ? 'allotment: not limited' : `allotment ${plural(s.allotment, 'ticket')}`,
    s.allotment != null && s.uses > s.allotment ? red(`${uses} over`) : uses,
    `lends ${some(s.lends) ? fig(s.lends) : '0'}`, `borrows ${some(s.borrows) ? fig(s.borrows) : '0'}`,
  ], [
    ...(fig(s.allotted) ? [gray(`${' '.repeat(LABEL)}allotted ${fig(s.allotted)}`)] : [' '.repeat(LABEL)]),
    ...(fig(s.used) ? [gray(`used ${fig(s.used)}`)] : []),
  ]];
}

// pack(parts, inner) — parts joined with " · " into lines of `inner` columns, each line after the first hung under the
// label; a part too long for a line of its own wraps (wrapLine) rather than being cut.
function pack(parts, inner) {
  const lines = [];
  for (const p of parts) {
    const last = lines.at(-1);
    if (last != null && visible(last) + 3 + visible(p) <= inner) lines[lines.length - 1] = `${last} · ${p}`;
    else lines.push(last == null ? p : `${' '.repeat(LABEL)}${p}`);
  }
  return lines.flatMap(l => wrapLine(l, inner, LABEL));
}

// machineCard(state, project, m, width) — the card's lines (boxes.js card).
export function machineCard(state, project, m, width) {
  const inner = width - 4, stale = !m.fresh;
  const title = m.kind === 'mac' ? (m.sharedBy > 1 ? `mac · shared by ${m.sharedBy} projects` : 'mac') : `${m.id} · ${KIND_LABELS[m.kind]}`;
  const on = ticketsOn(state, project, m.id, { cpuCapacity: m.cpuCapacity });
  const onLines = on.length ? on.map(e => e.text) : [gray('nothing of its project')];
  return card({
    title, status: status(m), width,
    lines: [
      gaugeLine('CPU', cpuGauge(m), inner, stale),
      gaugeLine('RAM', ramGauge(m), inner, stale),
      gaugeLine('Disk', diskGauge(m), inner, stale),
      seatsLine(m),
      ...(m.cluster ? [clusterLine(m.cluster)] : []),
      ...(m.images ?? []).map(({ arch, image }) => `${'Image'.padEnd(LABEL)}${imageText(arch, image)}`),
    ].flatMap(l => wrapLine(l, inner, LABEL)).concat(
      onLines.map((l, i) => `${(i ? '' : 'On it').padEnd(LABEL)}${l}`),   // one a line, unwrapped: card() cuts it with "…" (ASS-590)
      m.share ? shareLines(m.share).flatMap(parts => pack(parts.filter(p => p.trim()), inner)) : []),
  });
}

// ===== The project line and the legend =====

// projectLines(state, columns) — "agents: <model> 🤖x<n>, … · golden image <name> built <day> UTC" (ASS-566's project
// line: the footer's models box and golden image before), packed into lines; then any sandbox image no card shows
// (ASS-580: each image is on the cards of the machines that run it, never twice on the screen).
export function projectLines(state, columns) {
  const project = state.projects?.[state.project];
  if (!project) return [];
  const models = [...Map.groupBy(projectAssignments(state), a => a.model)]
    .toSorted(([a, x], [b, y]) => y.length - x.length || String(a).localeCompare(String(b)))
    .map(([model, list]) => `${model} 🤖x${list.length}`);
  const golden = project.golden;
  const parts = [
    models.length ? `agents: ${models.join(', ')}` : 'no agents',
    golden ? `golden image ${golden.name} ${golden['built-at'] ? `built ${utcDate(new Date(golden['built-at']))} UTC` : 'not built'}` : 'golden image: none',
    ...sandboxImageParts(project, machines(state)),
  ];
  return wrapParts(parts.map((p, i) => (i < parts.length - 1 ? `${p} ·` : p)), columns);
}

// imageText(arch, image) — one sandbox image: building (amber: a build started, not ended), build failed (red:
// substrate-config.js imageBuildFailed, the header chip's rule), built <day> UTC, or none (never built).
function imageText(arch, image) {
  if (!image) return gray(`sandbox image ${arch}: none`);
  if (imageBuildFailed(image)) return red(`sandbox image ${arch} build failed`);
  if (image.run?.['started-at'] && !image.run['ended-at']) return AMBER(`sandbox image ${arch} building`);
  const at = image.label?.['built-at'];
  return `sandbox image ${arch} ${at ? `built ${utcDate(new Date(at))} UTC` : 'not built'}`;
}

// sandboxImageParts(project, list) — the project line's sandbox images: those no machine's card shows (an amd64 image
// with no remote cluster, say); "sandbox image: none" for a project with a Substrate cluster on no card and no image.
function sandboxImageParts(project, list) {
  const onCards = new Set(list.flatMap(m => (m.images ?? []).map(i => i.arch)));
  const images = Object.entries(project.sandboxImages ?? {});
  const ids = new Set(list.map(m => m.id));
  if (!images.length) return (project.substrateMachines ?? []).some(id => !ids.has(id)) ? ['sandbox image: none'] : [];
  return images.filter(([arch]) => !onCards.has(arch)).map(([arch, image]) => imageText(arch, image));
}

export const LEGEND = `■ seat in use  □ seat free  │ limit  ● running  ○ stopped   ${ICONS.sandbox} sandbox  ${ICONS.worktree} worktree  ${ICONS.vm} Lima VM  ${ICONS.slot} slot  ${ICONS.workspace} workspace`;
const legendLines = columns => (visible(LEGEND) <= columns ? [LEGEND] : wrapParts(LEGEND.split('   '), columns)).map(l => gray(l));

// ===== The screen =====

// view(state, { columns, now, height }) — the screen's lines; `height` the lines it has (app.js render: the rows
// between the header and the footer), none to show everything.
export function view(state, { columns = 120, now = Date.now(), height = null } = {}) {
  const project = state.projects?.[state.project];
  if (!project) return [gray('no project')];
  const next = nextPlace(state, now);
  const list = placed(machines(state, now), next, project);
  const head = headline(project, list, next, columns);
  const width = cardWidth(columns), n = perRow(columns);
  const rows = [];
  for (let i = 0; i < list.length; i += n) rows.push({ count: Math.min(n, list.length - i), lines: cardRow(list.slice(i, i + n).map(m => machineCard(state, project, m, width)), GAP) });
  const legend = legendLines(columns);
  let tail = ['', ...projectLines(state, columns), ...legend];
  let shown = rows, hidden = 0;
  if (height != null) {
    const total = rows.reduce((a, r) => a + r.lines.length, 0);
    let avail = height - head.length - 1 - tail.length;
    if (total > avail) {
      if (avail < 2) { tail = legend; avail = height - head.length - 1 - tail.length; }
      shown = [];
      let used = 0;
      for (const r of rows) { if (used + r.lines.length > avail - 1) break; shown.push(r); used += r.lines.length; }
      hidden = list.length - shown.reduce((a, r) => a + r.count, 0);
    }
  }
  return [
    ...head, '',
    ...shown.flatMap(r => r.lines),
    ...(hidden ? [gray(`+${plural(hidden, 'machine')} below — a taller terminal shows ${hidden === 1 ? 'it' : 'them'}`)] : []),
    ...tail,
  ];
}
