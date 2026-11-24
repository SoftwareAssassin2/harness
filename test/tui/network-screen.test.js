// ASS-572: the compute network screen (n), redesigned — a headline saying where the project's next ticket goes (the
// planner's own placement), one card per machine (gauges marking the limits, seat squares with a plain verdict, what's
// on it), the project line and a legend. (ASS-557 made the screen, ASS-566 moved the footer's machine boxes onto it,
// ASS-569 made it per project in a bordered table; the table, the boxes and the pool summary are gone now.)
// test/tui/budget-lines.test.js covers the Mac's budget and share and each remote machine's limits on the cards;
// test/tui/substrate-dashboard.test.js the sandboxes and clusters; test/tui/gauge.test.js the gauge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { view, machines, placed, cardWidth, macArch, LEGEND } from '../../src/tui/screens/network.js';
import { nextPlace } from '../../src/tui/screens/shared.js';
import { nextPlacement } from '../../src/control/plan.js';
import { visible } from '../../src/tui/text.js';
import { G, NOW, iso, reading, measured, seatBudget, diskSpace, orbit, atlas, onN, strip, cardOf, onIt, team, crowd, workflows } from '../support/network-fixture.js';

const RED = '\x1b[31m', GRAY = '\x1b[90m', GREEN = '\x1b[32m', AMBER = '\x1b[38;2;255;176;0m';
const out = (state, columns = 120, height = null) => view(state, { columns, now: NOW, height });
const text = (state, columns = 120) => out(state, columns).map(strip);
const head = state => text(state).slice(0, 2).filter(Boolean).join(' · ');
const titles = lines => lines.map(strip).flatMap(l => [...l.matchAll(/┌─ (\S+)/g)].map(m => m[1]));
const line = (c, label) => c.lines.filter((l, n, all) => l.startsWith(label) || (l.startsWith(' ') && all.slice(0, n).findLast(x => !x.startsWith(' '))?.startsWith(label))).map(l => l.trim()).join(' ');

// remoteOnly(p) — orbit with no Mac: remote run targets alone, no Mac cluster, workstation mode.
const remoteOnly = (p = orbit()) => {
  const targets = ['cloud-vm-substrate', 'workstation-substrate', 'workstation-worktree', 'cloud-vm-worktree'];
  return { ...p, devEnvironments: { ...p.devEnvironments, mode: 'workstation' }, runTargets: targets, runTargetPlan: { ...p.runTargetPlan, targets, mode: 'workstation' } };
};
const full = p => {
  p.remoteBudget['ws-east'] = measured({ seats: 2, held: 2, why: 'one more ticket would pass its memory limit', admit: false, memUsed: 26, memBudget: 28.2, cpu: 140, cpuBudget: 720, disk: { total: 196, free: 116 } });
  return p;
};
// stopped(p, at) — both remote machines stopped since `at`, idle (nothing of the project on them), unmeasured.
const stopped = (p, at = NOW - 3 * 3600e3) => {
  for (const id of ['ws-east', 'vm-west']) {
    p.workstations[id] = { state: 'stopped', connected: false, setup: { ok: true }, usage: reading({ totalGib: 16, usedGib: 3, cores: 4, cpu: 20, disk: { total: 96, free: 50 }, at }) };
    p.remoteBudget[id] = { seats: 1, held: 0, pending: 0, state: 'unmeasured', why: 'not connected (stopped, or not started yet)', admit: true, limits: { memory: 90, cpu: 90 } };
  }
  return { ...p, seats: [], substrate: {}, sprint: { ...p.sprint, features: [] } };
};

// ===== AC1: the headline =====

test('AC1: remote-first with room — the headline names the machine the planner places the next ticket on, and why', () => {
  const s = onN([orbit(), atlas()]);
  assert.equal(head(s), 'Orbit · 3 machines · 2 can take work · 3 of 4 seats in use · next ticket → ws-east (sandbox; remote first, most room)');
  // The planner's own answer (plan.js nextPlacement, planDispatch's next), not one worked out by the screen.
  const next = nextPlace(s);
  assert.deepEqual([next.target, next.machine, next.choice], ['workstation-substrate', 'ws-east', 'remote-first']);
  assert.ok(Array.isArray(next.rooms), 'pool choice rated the candidates');
  // ws-east full and vm-west with room: the planner goes to vm-west, and so does the headline.
  const p = full(orbit());
  p.remoteBudget['vm-west'] = { ...p.remoteBudget['vm-west'], seats: 2, admit: true, why: 'one more ticket fits' };
  assert.match(head(onN([p, atlas()])), /next ticket → vm-west \(sandbox; remote first, most room\)$/);
  // The next ticket's machine's name is green.
  assert.ok(out(s)[0].includes(`${GREEN}ws-east`));
});

test('AC1: all full — the headline says in red why nothing can take work, machine by machine', () => {
  const p = full(remoteOnly());
  const s = onN([p]);
  assert.equal(nextPlace(s).target, null);
  assert.equal(head(s), 'Orbit · 3 machines · 0 can take work · 3 of 3 seats in use · nothing can take work: ws-east full (memory), vm-west full (memory)');
  assert.ok(out(s).slice(0, 2).join('').includes(`${RED}nothing can take work`));
  // Seats free on a machine, but the planner gives them to tickets already waiting: said first.
  const q = remoteOnly();
  q.seats = q.seats.filter(r => r.key !== 'ORB-101');   // ORB-101 at Build, seated nowhere: it takes vm-west's free seat
  q.remoteBudget['ws-east'] = { ...q.remoteBudget['ws-east'], seats: 2, held: 2 };
  q.remoteBudget['vm-west'] = { ...q.remoteBudget['vm-west'], seats: 1, held: 0 };
  assert.match(head(onN([q])), /nothing can take work: the free seats go to 1 ticket already waiting/);
});

test('AC1: all stopped — a stopped machine still takes the next ticket (it is started on demand); stopped and unreachable, nothing can', () => {
  const s = onN([stopped(remoteOnly())]);
  const next = nextPlace(s);
  assert.equal(next.machine, 'vm-west', 'equal room: the run targets\' order (cloud-vm-substrate first)');
  assert.match(head(s), /3 machines · 2 can take work · 0 of 2 seats in use · next ticket → vm-west \(sandbox; remote first, most room\) · it is stopped: starts on demand$/);
  const p = stopped(remoteOnly());
  for (const id of ['ws-east', 'vm-west']) p.workstations[id]['last-error'] = { at: iso(NOW - 60e3), message: 'IAP tunnel refused' };
  assert.match(head(onN([p])), /nothing can take work: ws-east unreachable, vm-west unreachable$/);
});

test('AC1: Mac only — the next ticket goes to the Mac; with no seat for it, red, why', () => {
  assert.equal(head(onN([atlas(), orbit()])), 'Atlas · 1 machine · 1 can take work · 1 of 3 seats in use · next ticket → mac (Lima VM; first with room)');
  const fullMac = atlas({ seatBudget: seatBudget({ seats: 1, allotment: { seats: 1, 'memory-bytes': 8 * G, 'cpu-percent': 200 }, used: { seats: 1, 'memory-bytes': 4 * G, 'cpu-percent': 100 } }) });
  fullMac.sprint = { number: 1, start: '2026-11-17', end: '2026-11-30', bugs: [], spikes: [], features: [{ key: 'ATL-1', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }] }] };
  fullMac.seats = [{ key: 'ATL-1', variation: 'A', kind: 'vm', target: 'local-vm' }];
  fullMac.stateEngine = 'e';
  assert.equal(head(onN([fullMac], { assignments: [] })), 'Atlas · 1 machine · 0 can take work · 1 of 1 seats in use · nothing can take work: mac full (allotment)');
});

// ===== AC2: one card per machine, in placement order, with gauges =====

test('AC2: a card per machine in placement order — the next ticket\'s machine first, those that can take work, then the rest', () => {
  const s = onN([orbit(), atlas()]);
  assert.deepEqual(titles(out(s)), ['ws-east', 'mac', 'vm-west']);
  // remote-first: a remote machine with room before the Mac; most-room: by room; first: the run targets' order.
  const list = machines(s, NOW);
  assert.deepEqual(placed(list, { target: null, choice: 'remote-first' }, s.projects[0]).map(m => m.id), ['ws-east', 'mac', 'vm-west']);
  assert.deepEqual(placed(list, { target: null, choice: 'first' }, { runTargets: ['local-worktree', 'workstation-worktree'] }).map(m => m.id), ['mac', 'ws-east', 'vm-west']);
  assert.deepEqual(placed(list, { target: 'local-worktree', choice: 'most-room' }, s.projects[0]).map(m => m.id)[0], 'mac', 'the next ticket\'s machine first');
});

test('AC2: CPU, RAM and disk gauges — the bar the whole machine, │ at the limit, CPU as a percent of the machine, colored by headroom', () => {
  const lines = out(onN([orbit(), atlas()]));
  const ws = cardOf(lines, 'ws-east'), vm = cardOf(lines, 'vm-west'), mac = cardOf(lines, 'mac');
  // ws-east: 140% of one core on 8 cores is 18% of the machine; its limit 90%.
  assert.match(line(ws, 'CPU'), /^CPU +█+░+│░+ 18% · limit 90%$/);
  const bar = line(ws, 'CPU').match(/[█░│]+/)[0];
  assert.equal(bar.indexOf('│'), Math.round(0.9 * bar.length), 'the limit marked at 90% of the bar');
  assert.match(line(ws, 'RAM'), /9\.6 of 31\.3 GiB · limit 28\.2$/);
  assert.match(line(ws, 'Disk'), /80\.0 of 196 GiB · 116 free$/);
  // The Mac's are the whole Mac's: 168% of one core on 14 cores is 12%.
  assert.match(line(mac, 'CPU'), /12% · limit 90%$/);
  assert.match(line(mac, 'RAM'), /30\.2 of 48\.0 GiB · limit 43\.2$/);
  assert.match(line(mac, 'Disk'), /691 of 931 GiB · 240 free$/);
  // vm-west: 53% of its CPU; RAM within 10 points of its limit (12.9 of 15.6, limit 14.0): amber; ws-east green.
  assert.match(line(vm, 'CPU'), /53% · limit 90%$/);
  const raw = lines.join('\n');
  assert.ok(raw.includes(`${AMBER}12.9 of 15.6 GiB · limit 14.0`), 'amber within 10 points');
  assert.ok(raw.includes(`${GREEN}███`), 'green well under');
  // Over a limit: red.
  const p = orbit();
  p.remoteBudget['ws-east'] = { ...p.remoteBudget['ws-east'], 'memory-used-bytes': 30 * G };
  assert.ok(out(onN([p])).join('\n').includes(`${RED}30.0 of 31.3 GiB · limit 28.2`));
  // A disk below its hold: red, the hold marked; below its warn level: amber.
  const d = orbit();
  d.remoteBudget['vm-west'].disk = { ...d.remoteBudget['vm-west'].disk, 'free-bytes': 10 * G, 'used-bytes': 86 * G, held: true };
  const dl = out(onN([d]));
  assert.ok(dl.join('\n').includes(`${RED}86.0 of 96.0 GiB · 10.0 free`));
  assert.match(line(cardOf(dl, 'vm-west'), 'Seats'), /held: disk below its 15 GB hold \(10\.0 GiB free at \/home\/u\/harness\) — no new ticket until 50 GB is free$/);
  assert.ok(out(onN([orbit()], { disk: diskSpace({ level: 'warn', 'free-bytes': 40 * G }) })).join('\n').includes(`${AMBER}891 of 931 GiB · 40.0 free`));
});

// ===== AC3: status, seats and verdict, what's on it, stale figures =====

test('AC3: each card\'s status dot and word — running green, starting amber, stopped gray, unreachable / setup failed / sign-in needed red', () => {
  const titleOf = entry => { const p = orbit(); p.workstations['vm-west'] = { ...p.workstations['vm-west'], ...entry }; const raw = out(onN([p])).find(l => strip(l).includes('┌─ vm-west')); return raw.slice(raw.indexOf('vm-west')); };
  assert.ok(titleOf({}).includes(`${GREEN}● running`));
  assert.ok(titleOf({ connected: false, state: 'starting', 'state-at': iso(NOW) }).includes(`${AMBER}● starting`));
  assert.ok(titleOf({ connected: false, state: 'stopped' }).includes(`${GRAY}○ stopped`));
  assert.ok(titleOf({ connected: false, 'last-error': { at: iso(NOW), message: 'refused' } }).includes(`${RED}● unreachable`));
  assert.ok(titleOf({ setup: { ok: false, error: 'apt failed' } }).includes(`${RED}● setup failed`));
  assert.ok(titleOf({ connected: false, 'last-error': { at: iso(NOW), kind: 'expired' } }).includes(`${RED}● sign-in needed`));
  // Their verdicts say why they take no work.
  const why = entry => { const p = orbit(); p.workstations['vm-west'] = { ...p.workstations['vm-west'], ...entry }; return line(cardOf(out(onN([p])), 'vm-west'), 'Seats'); };
  assert.match(why({ setup: { ok: false, error: 'apt failed' } }), /no work: its setup failed: apt failed$/);
  assert.match(why({ connected: false, 'last-error': { at: iso(NOW), kind: 'expired' } }), /no work: its gcloud login needs reauthentication$/);
});

test('AC3: seat squares — ■ per seat in use, □ per seat free — then a plain verdict', () => {
  const lines = out(onN([orbit(), atlas()]));
  assert.equal(line(cardOf(lines, 'ws-east'), 'Seats'), 'Seats   ■■□  2 of 3 · can take 1 more');
  assert.equal(line(cardOf(lines, 'vm-west'), 'Seats'), 'Seats   ■  1 of 1 · full: one more would pass its memory limit');
  assert.equal(line(cardOf(lines, 'mac'), 'Seats'), 'Seats   none needed: worktrees on the Mac take no seat');
  assert.equal(line(cardOf(out(onN([atlas(), orbit()])), 'mac'), 'Seats'), 'Seats   ■□□  1 of 3 · can take 2 more');
  assert.equal(line(cardOf(out(onN([stopped(orbit())])), 'ws-east'), 'Seats'), 'Seats   □  0 of 1 · stopped: starts on demand (up to 15 min) · can take 1');
  // Many seats: counted, not drawn one by one.
  const p = orbit();
  p.remoteBudget['ws-east'] = { ...p.remoteBudget['ws-east'], seats: 14, held: 12 };
  assert.match(line(cardOf(out(onN([p])), 'ws-east'), 'Seats'), /^Seats {3}■×12 □×2 {2}12 of 14 · can take 2 more$/);
});

test('AC3: what\'s on a machine — kind icon, key, variation and state: a step, hibernated, crashed (will be replaced), unsandboxed, idle', () => {
  const s = onN([orbit(), atlas()], { sandboxed: { Y: { sandboxed: false, why: 'socat not installed' } } });
  const lines = out(s, 200);   // wide: each line whole (at 120 a long one is cut with "…", ASS-590)
  assert.deepEqual(onIt(cardOf(lines, 'ws-east')), [
    '🌿 ORB-102 worktree · 🤖x2 Write Plan · unsandboxed',
    '📦 ORB-103 sandbox · hibernated (0.4 GiB snapshot)',
    '📦 ORB-104 sandbox · crashed (will be replaced)',
  ]);
  assert.deepEqual(onIt(cardOf(lines, 'vm-west')), ['📦 ORB-101 sandbox · 🤖 Build · running 6.1 GiB 38% CPU']);
  assert.deepEqual(onIt(cardOf(lines, 'mac')), ['🌿 ORB-105 worktree · idle']);
  const raw = lines.join('\n');
  assert.ok(raw.includes(`${RED}crashed (will be replaced)`) && raw.includes('\x1b[38;2;255;215;0munsandboxed'), 'crashed red, unsandboxed gold');
  // A slot, a variation not A, a worktree kept on a machine between steps (idle), the Mac's checkout and Lima VMs.
  const p = orbit();
  p.workstations['ws-east'].holders = { 1: { ticket: 'ORB-106', variation: 'B', slot: 1 } };
  p.sprint.features.push({ key: 'ORB-107', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'review', 'state-engine': 'e' }, 'remote-worktrees': [{ name: 'ws-east' }] }] });
  p.runTargets = [...p.runTargets, 'local-workspace', 'local-vm'];
  p.localSeats = [{ key: 'ORB-108', variation: 'A', target: 'local-workspace' }];
  p.seats = [...p.seats, { key: 'ORB-109', variation: 'A', kind: 'vm', target: 'local-vm' }, { key: 'ORB-110', variation: 'A', kind: 'vm', target: 'local-vm' }];
  p.vms = { 'orb-109-a': { ticket: 'ORB-109', variation: 'A', state: 'Running' } };
  const q = out(onN([p]));
  // ASS-590 AC1: every ticket listed, no "+N more".
  const east = onIt(cardOf(q, 'ws-east'));
  assert.deepEqual(east.slice(0, 3), ['🌿 ORB-102 worktree · 🤖x2 Write Plan', '📁 ORB-106 B slot · idle', '🌿 ORB-107 worktree · idle']);
  assert.equal(east.length, 5, east.join('\n'));
  assert.ok(east.some(l => l.includes('ORB-103')) && east.some(l => l.includes('ORB-104')), east.join('\n'));
  assert.ok(!east.some(l => /\+\d+ more/.test(l)), 'no +N more');
  assert.deepEqual(onIt(cardOf(q, 'mac')), ['💺 ORB-109 Lima VM · running', '💺 ORB-110 Lima VM · creating', '🌿 ORB-105 worktree · idle', '📂 ORB-108 workspace · idle']);
});

test('AC3: an agent\'s step and a script step (💻), as the sprint screen counts them; none on a past day', () => {
  const p = orbit();
  const scriptStep = [{ name: 'e', steps: [{ id: 'build', name: 'Build', sequence: 1, action: { type: 'prompt' } }, { id: 'lint', name: 'Lint', sequence: 2, action: { type: 'script' } }, { id: 'review', name: 'Code Review', sequence: 3, action: { type: 'human' } }] }];
  p.sprint.features[1].variations[0]['harness-status'].state = 'lint';
  const s = onN([p], { assignments: [], workflows: scriptStep });
  assert.deepEqual(onIt(cardOf(out(s), 'ws-east'))[0], '🌿 ORB-102 worktree · 💻 Lint');
  const past = { ...s, day: '2026-11-18', projects: [{ ...p, days: { '2026-11-18': p.sprint } }] };
  assert.deepEqual(onIt(cardOf(out(past), 'ws-east'))[0], '🌿 ORB-102 worktree · idle');
});

test('AC3: a stopped or unreachable machine\'s last figures are dimmed, their age in its title', () => {
  const lines = out(onN([stopped(remoteOnly())]));
  const c = cardOf(lines, 'ws-east');
  assert.match(c.title, /┌─ ws-east · workstation ─+ ○ stopped · 3h ago ─┐$/);
  assert.match(line(c, 'CPU'), /5% · limit 90%$/);
  const raw = lines.find(l => strip(l).startsWith('│ CPU'));
  assert.ok(!raw.includes(GREEN) && raw.includes(`${GRAY}5% · limit 90%`), JSON.stringify(raw));
  // A fresh one is not dimmed, and says no age.
  assert.match(cardOf(out(onN([orbit()])), 'ws-east').title, /● running ─┐$/);
});

// ===== AC4: the Mac's card =====

test('AC4: the Mac\'s card: whole-Mac gauges, this project\'s seats, tickets and share (ASS-580: for every project, see below)', () => {
  const withCluster = remoteOnly({ ...orbit(), substrateMachines: ['mac', 'ws-east'] });
  assert.ok(line(cardOf(out(onN([withCluster])), 'mac'), 'Share'), 'a Mac Substrate cluster: a Share line');
  // Both projects see the same whole Mac, each its own seats, tickets and share.
  const o = cardOf(out(onN([orbit(), atlas()], { project: 0 })), 'mac'), a = cardOf(out(onN([orbit(), atlas()], { project: 1 })), 'mac');
  assert.match(o.title, /^┌─ mac · shared by 2 projects ─/);
  for (const label of ['CPU', 'RAM', 'Disk']) assert.equal(line(o, label), line(a, label), `${label}: the whole Mac's`);
  assert.equal(line(a, 'Seats'), 'Seats   ■□□  1 of 3 · can take 2 more');
  assert.deepEqual(onIt(o), ['🌿 ORB-105 worktree · idle']);
  assert.deepEqual(onIt(a), ['nothing of its project']);
  assert.match(line(a, 'Share'), /^Share {3}50% \(split\) · allotment 3 tickets · uses 1 /);
  assert.match(line(o, 'Share'), /lends 0 · borrows 0/);
  // Alone on the Mac: just "mac".
  assert.match(cardOf(out(onN([atlas()])), 'mac').title, /^┌─ mac ─/);
});

// ===== AC5: layout =====

test('AC5: two cards a row from 120 columns, one a row narrower; nothing wider than the screen', () => {
  const s = onN([orbit(), atlas()]);
  for (const columns of [120, 200]) {
    const lines = out(s, columns);
    for (const l of lines) assert.ok(visible(l) <= columns, `${visible(l)} > ${columns}: ${strip(l)}`);
    const top = lines.map(strip).find(l => l.startsWith('┌─ ws-east'));
    assert.deepEqual([...top.matchAll(/┌─ (\S+)/g)].map(m => m[1]), ['ws-east', 'mac'], `${columns}: two a row`);
    assert.equal(visible(top), 2 * cardWidth(columns) + 2);
  }
  assert.equal(cardWidth(120), 59);
  assert.equal(cardWidth(200), 99);
  const narrow = out(s, 100);
  for (const l of narrow) assert.ok(visible(l) <= 100);
  assert.ok(narrow.map(strip).filter(l => l.startsWith('┌─')).every(l => (l.match(/┌─/g) ?? []).length === 1), 'one a row');
  // A long id is cut in the title, the status kept.
  const p = orbit();
  const long = 'a-workstation-with-a-very-long-id-indeed-and-more';
  p.devEnvironments = { ...p.devEnvironments, workstations: [{ ...p.devEnvironments.workstations[0], id: long }, p.devEnvironments.workstations[1]] };
  p.workstations[long] = p.workstations['ws-east'];
  p.remoteBudget[long] = p.remoteBudget['ws-east'];
  for (const l of out(onN([p]))) assert.ok(visible(l) <= 120);
  assert.ok(text(onN([p])).some(l => /┌─ a-workstation-with-a-very-long-id-in.*… ─* ● running ─┐/.test(l)), text(onN([p])).join('\n'));
});

test('AC5: on a short terminal the cards are cut a row at a time from the bottom; the headline and the legend always show, and what is hidden is said', () => {
  const s = onN([orbit(), atlas()]);
  const all = out(s, 120);
  const short = out(s, 120, 20).map(strip);
  assert.ok(short.length <= 20, short.length);
  assert.match(short[0], /^Orbit · 3 machines/);
  assert.deepEqual(titles(short), ['ws-east', 'mac']);
  assert.ok(short.includes('+1 machine below — a taller terminal shows it'), short.join('\n'));
  assert.equal(short.at(-1), strip(LEGEND));
  // Shorter still: no card, the headline and the legend kept.
  const tiny = out(s, 120, 6).map(strip);
  assert.equal(tiny.length <= 6, true);
  assert.match(tiny[0], /^Orbit/);
  assert.ok(tiny.includes('+3 machines below — a taller terminal shows them'));
  assert.equal(tiny.at(-1), strip(LEGEND));
  // Tall enough: everything, no note.
  assert.deepEqual(out(s, 120, 200), all);
  // Through the dashboard: its body's height, the legend on screen above the footer.
  const screen = render(s, { columns: 120, rows: 34, now: NOW }).map(strip);
  assert.ok(screen.some(l => l.startsWith('Orbit · 3 machines')), screen.join('\n'));
  assert.ok(screen.some(l => l === strip(LEGEND)), screen.join('\n'));
  assert.ok(screen.some(l => /^\+\d machines? below/.test(l)), screen.join('\n'));
});

// ===== AC6: nothing lost; the old table, boxes and pool summary gone =====

test('AC6: the project line — agents per model, its golden image, its sandbox images — and the legend', () => {
  const t = text(onN([orbit(), atlas()], { assignments: team }));
  const joined = t.join(' ');
  assert.match(joined, /agents: opus-5 🤖x2, haiku-5 🤖x1 · golden image golden-orbit built 2026-11-18 UTC /);
  // ASS-580: the amd64 image is on the remote machines' cards, so not on the project line too.
  assert.doesNotMatch(t.filter(l => !l.startsWith('│')).join(' '), /sandbox image/);
  assert.ok(t.includes(strip(LEGEND)));
  assert.equal(strip(LEGEND), '■ seat in use  □ seat free  │ limit  ● running  ○ stopped   📦 sandbox  🌿 worktree  💺 Lima VM  📁 slot  📂 workspace');
  // No agents, no golden image, a failed and a running sandbox image build.
  // An image no card shows (no cluster runs that architecture) stays on the project line.
  const other = macArch() === 'arm64' ? 'amd64' : 'arm64';
  const p = orbit({ golden: null, substrateMachines: [], sandboxImages: { [other]: { label: { hash: 'a' }, run: { hash: 'b', 'started-at': iso(NOW), 'ended-at': iso(NOW), 'exit-code': 1 } } } });
  const raw = out(onN([p], { assignments: [] })).join('\n');
  assert.match(strip(raw), new RegExp(`no agents · golden image: none · sandbox image ${other} build failed`));
  assert.ok(raw.includes(`${RED}sandbox image ${other} build failed`));
  const never = orbit({ golden: { name: 'golden-orbit', 'built-at': null }, sandboxImages: {} });
  assert.match(text(onN([never], { assignments: [] })).join(' '), /golden image golden-orbit not built\s/);
});

test('AC6: every machine figure the table showed is on a card — CPU, RAM used/limit/total, disk used/free/total, what is on it, seats', () => {
  const lines = out(onN([orbit(), atlas()]));
  const ws = cardOf(lines, 'ws-east');
  assert.match(line(ws, 'CPU'), /18% · limit 90%/);
  assert.match(line(ws, 'RAM'), /9\.6 of 31\.3 GiB · limit 28\.2/);
  assert.match(line(ws, 'Disk'), /80\.0 of 196 GiB · 116 free/);
  assert.match(line(ws, 'Seats'), /2 of 3/);
  assert.match(line(ws, 'Cluster'), /2\.8 GiB · 4% CPU/);
  assert.equal(onIt(ws).length, 3);
});

test('AC6: the old table, the repeated machine boxes and the pool summary are gone', () => {
  const t = text(onN([orbit(), atlas()])).join('\n');
  for (const gone of [/Machine +│? *Kind/, /^pool: /m, /Mac share:/, /│ gcp workstations/, /│ cloud virtual machines/, /│ local virtual machines/, /│ substrate sandboxes/, /│ local +│/, /↳/, /Mac total/]) assert.ok(!gone.test(t), `${gone}:\n${t}`);
});

test('ASS-557: n opens the compute network screen and the ? menu lists it; the left and right arrows switch project', () => {
  const s = initialState({ projects: [orbit(), atlas()], workflows: [], assignments: [] });
  assert.equal(handleKey(s, { name: 'n', sequence: 'n' }).screen, 'n');
  const menu = render({ ...s, menuOpen: true }, { columns: 120, rows: 80, now: NOW }).map(strip);
  assert.ok(menu.some(l => /│ n +compute network\b/.test(l)), menu.join('\n'));
  let n = onN([orbit(), atlas()]);
  assert.match(strip(render(n, { columns: 120, rows: 60, now: NOW }).find(l => /^(Orbit|Atlas) ·/.test(strip(l)))), /^Orbit/);
  n = handleKey(n, { name: 'right' });
  assert.match(strip(render(n, { columns: 120, rows: 60, now: NOW }).find(l => /^(Orbit|Atlas) ·/.test(strip(l)))), /^Atlas/);
  assert.equal(view({ ...n, projects: [] }, { columns: 120 }).map(strip)[0], 'no project');
});

test('ASS-572: the dashboard\'s planner places as control does — its run targets and remote seats are passed on', () => {
  const s = onN([orbit()]);
  // As control would see the same project (state.js: runTargets is projectRunTargets', remoteBudget remote-seats.json).
  const p = s.projects[0];
  const control = { projects: [{ id: 'orbit', json: {}, engines: {}, engine: undefined, tickets: [], seats: p.seats, devEnvironments: p.devEnvironments, workstations: p.workstations, remoteBudget: p.remoteBudget, runTargets: p.runTargetPlan, seatBudget: p.seatBudget }], assignments: [], harness: {}, engines: {} };
  control.allProjects = control.projects;
  assert.deepEqual([nextPlacement(control, control.projects[0]).target, nextPlacement(control, control.projects[0]).machine], [nextPlace(s).target, nextPlace(s).machine]);
});

test('AC7: CLAUDE.md and README describe the redesigned n screen — the headline, the cards, the gauges, the verdicts, the short terminal', async () => {
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url).pathname;
  for (const name of ['CLAUDE.md', 'README.md']) {
    const doc = readFileSync(`${root}${name}`, 'utf8');
    for (const words of ['next ticket →', 'nextPlacement', 'nothing can take work', 'shared by N projects', 'can take 2 more', 'starts on demand', '+N machines below', 'never per core', 'within 10 points']) assert.ok(doc.includes(words), `${name}: ${words}`);
    for (const gone of ['Mac total', 'pool summary, its Mac share line', 'at most four', 'At most four lines a card']) assert.ok(!doc.includes(gone), `${name} still says ${gone}`);
    assert.ok(doc.includes('one a line'), `${name}: On it lists every ticket, one a line (ASS-590 AC4)`);
  }
});

// ===== ASS-575: the remote machines' boot waits (control's boot-waits.json) =====

// waiting(p, id, sinceMs, over) — control's boot-waits.json for `id`, loaded as the dashboard loads it (load.js bootWaits).
const waiting = (p, id, since, over = false, seconds = 900) => ({ ...p, bootWaits: { 'wait-seconds': seconds, machines: { [id]: { since: iso(since), 'ends-at': iso(since + seconds * 1000), over } } } });

test('ASS-575 AC2: a machine past its boot wait is never the headline\'s next machine — the dashboard\'s planner treats it as lost, as control does', () => {
  // Without a boot wait vm-west takes the next ticket (AC1 "all stopped"); past its wait it is lost, so ws-east does.
  for (const p of [waiting(stopped(remoteOnly()), 'vm-west', NOW - 20 * 60e3, true), waiting(stopped(remoteOnly()), 'vm-west', NOW - 16 * 60e3, false)]) {
    const s = onN([p]);
    const next = nextPlace(s, NOW);
    assert.equal(next.machine, 'ws-east', 'over (control said so, or its time ran out since control\'s last tick): not placed on');
    assert.match(head(s), /3 machines · 1 can take work · .*next ticket → ws-east /);
    assert.doesNotMatch(head(s), /next ticket → vm-west/);
  }
  // (test/control/boot-waits.test.js checks that the dashboard's bootWaitOver is control's own, word for word.)
  // A machine that came up since is not waited for, whatever the file still says.
  const up = waiting(stopped(remoteOnly()), 'vm-west', NOW - 20 * 60e3, true);
  up.workstations['vm-west'] = { ...up.workstations['vm-west'], state: 'running', connected: true, 'connected-at': iso(NOW - 60e3), setup: { ok: true, 'checked-at': iso(NOW - 30e3) } };
  assert.equal(nextPlace(onN([up]), NOW).machine, 'vm-west');
});

test('ASS-575 AC3: a card shows "starting · waited m of n min" during the boot wait and the "didn\'t come up" verdict after it', () => {
  const during = onN([waiting(stopped(remoteOnly()), 'vm-west', NOW - 5 * 60e3 - 20e3)]);
  const c1 = cardOf(out(during), 'vm-west');
  assert.match(line(c1, 'Seats'), /starting · waited 5 of 15 min · can take 1/);
  assert.equal(nextPlace(during, NOW).machine, 'vm-west', 'within its wait it is still placed on');
  assert.match(head(during), /next ticket → vm-west .* · it is starting: waited 5 of 15 min$/);
  const after = onN([waiting(stopped(remoteOnly()), 'vm-west', NOW - 20 * 60e3, true)]);
  const c2 = cardOf(out(after), 'vm-west');
  assert.match(line(c2, 'Seats'), /no work: didn't come up within 15 min; work goes elsewhere until it's up/);
  assert.ok(out(after).some(l => l.includes(RED) && strip(l).includes("didn't come up")), 'red');
  // With every machine unable to take work, the headline says why.
  const both = waiting(stopped(remoteOnly()), 'vm-west', NOW - 20 * 60e3, true);
  both.bootWaits.machines['ws-east'] = { since: iso(NOW - 20 * 60e3), 'ends-at': iso(NOW - 5 * 60e3), over: true };
  assert.match(head(onN([both])), /nothing can take work: ws-east didn't come up, vm-west didn't come up$/);
  // Another wait length is the file's (remote-boot-wait-seconds).
  assert.match(line(cardOf(out(onN([waiting(stopped(remoteOnly()), 'vm-west', NOW - 60e3, false, 300)])), 'vm-west'), 'Seats'), /starting · waited 1 of 5 min/);
});

// ===== ASS-580: the Mac's card for every project; each card's sandbox images =====

const arm = macArch();   // the Mac's own architecture (arm64 on Apple silicon)
const built = (day, hash = 'h') => ({ label: { hash, 'built-at': `${day}T10:00:00Z` }, run: { hash, 'started-at': `${day}T09:30:00Z`, 'ended-at': `${day}T10:00:00Z`, 'exit-code': 0 } });
const imageLines = c => c.lines.filter(l => l.startsWith('Image'));

test('ASS-580 AC1: a remote-only project gets the Mac\'s card — gray "no work" verdict, the whole Mac\'s gauges, no seats or Share — last, counted, never the headline\'s choice', () => {
  for (const p of [remoteOnly(), full(remoteOnly()), stopped(remoteOnly())]) {
    const s = onN([p, atlas()]);
    const lines = out(s);
    const mac = cardOf(lines, 'mac');
    assert.ok(mac, 'a Mac card');
    assert.equal(titles(lines).at(-1), 'mac', 'after every other machine');
    assert.equal(line(mac, 'Seats'), 'Seats   no work: none of its run targets is on the Mac');
    assert.ok(lines.some(l => l.includes(`${GRAY}no work: none of its run targets is on the Mac`)), 'gray');
    assert.equal(line(mac, 'Share'), '', 'no Share line');
    assert.doesNotMatch(mac.lines.join('\n'), /■|□/, 'no seat squares');
    // The whole Mac's gauges, the same another project sees.
    const other = cardOf(out(onN([p, atlas()], { project: 1 })), 'mac');
    for (const label of ['CPU', 'RAM', 'Disk']) assert.equal(line(mac, label), line(other, label));
    assert.match(head(s), /^Orbit · 3 machines · /);
    assert.doesNotMatch(head(s), /next ticket → mac|mac no Mac run target/);
    assert.notEqual(nextPlace(s, NOW).target?.startsWith('local'), true, 'the planner never places it on the Mac');
  }
  // With every remote machine full the red "why" names the remote machines only.
  assert.match(head(onN([full(remoteOnly())])), /nothing can take work: ws-east full \(memory\), vm-west full \(memory\)$/);
});

test('ASS-580 AC2: each card shows the images its machine\'s cluster runs — built, building (amber), build failed (red), none — and none without a cluster', () => {
  const images = {
    amd64: built('2026-11-23'),
    [arm]: built('2026-11-20'),
  };
  if (arm === 'amd64') images.amd64 = built('2026-11-20');
  // orbit: clusters on ws-east, vm-west and the Mac.
  const p = orbit({ substrateMachines: ['mac', 'ws-east', 'vm-west'], sandboxImages: images });
  const lines = out(onN([p]));
  assert.deepEqual(imageLines(cardOf(lines, 'mac')), [`Image   sandbox image ${arm} built 2026-11-20 UTC`]);
  for (const id of ['ws-east', 'vm-west']) assert.deepEqual(imageLines(cardOf(lines, id)), [`Image   sandbox image amd64 built ${arm === 'amd64' ? '2026-11-20' : '2026-11-23'} UTC`]);
  // Building, failed, none.
  const q = orbit({ substrateMachines: ['mac', 'ws-east'], sandboxImages: {
    amd64: { label: { hash: 'a', 'built-at': '2026-11-22T10:00:00Z' }, run: { hash: 'b', 'started-at': iso(NOW), 'ended-at': iso(NOW), 'exit-code': 1 } },
  } });
  const ql = out(onN([q]));
  if (arm !== 'amd64') assert.deepEqual(imageLines(cardOf(ql, 'mac')), [`Image   sandbox image ${arm}: none`]);
  assert.deepEqual(imageLines(cardOf(ql, 'ws-east')), ['Image   sandbox image amd64 build failed']);
  assert.ok(ql.join('\n').includes(`${RED}sandbox image amd64 build failed`));
  assert.deepEqual(imageLines(cardOf(ql, 'vm-west')), [], 'no cluster on vm-west: no image line');
  const r = orbit({ substrateMachines: ['ws-east'], sandboxImages: { amd64: { run: { hash: 'c', 'started-at': iso(NOW) } } } });
  const rl = out(onN([r]));
  assert.deepEqual(imageLines(cardOf(rl, 'ws-east')), ['Image   sandbox image amd64 building']);
  assert.ok(rl.join('\n').includes(`${AMBER}sandbox image amd64 building`));
  // The Mac with no cluster declared: no line, unless an image of its architecture was built.
  assert.deepEqual(imageLines(cardOf(out(onN([remoteOnly()])), 'mac')), []);
  assert.deepEqual(imageLines(cardOf(out(onN([remoteOnly(orbit({ sandboxImages: { [arm]: built('2026-11-19') } }))])), 'mac')), [`Image   sandbox image ${arm} built 2026-11-19 UTC`]);
  // A project with no cluster and no image: no image line anywhere.
  assert.doesNotMatch(text(onN([atlas()])).join('\n'), /sandbox image/);
});

test('ASS-580 AC3, AC6: no image shown twice — an image on a card is not on the project line', () => {
  const p = orbit({ substrateMachines: ['mac', 'ws-east', 'vm-west'], sandboxImages: { amd64: built('2026-11-23'), arm64: built('2026-11-20') } });
  const t = text(onN([p]));
  const below = t.filter(l => !/^[│┌└]/.test(l));
  assert.doesNotMatch(below.join(' '), /sandbox image/, 'none on the project line');
  for (const arch of ['amd64', 'arm64']) assert.ok(t.some(l => l.includes(`sandbox image ${arch} built`)), `${arch} on a card`);
  // Each card shows its image at most once.
  for (const id of ['mac', 'ws-east', 'vm-west']) assert.ok(imageLines(cardOf(out(onN([p])), id)).length <= 1);
});

test('ASS-580 AC4: with the extra card and image lines, two a row and the short-terminal cut still hold', () => {
  const s = onN([remoteOnly(orbit({ sandboxImages: { amd64: built('2026-11-23'), [arm]: built('2026-11-20') } }))]);
  for (const l of out(s, 120)) assert.ok(visible(l) <= 120);
  assert.deepEqual([...text(s).find(l => l.startsWith('┌─ ')).matchAll(/┌─ (\S+)/g)].map(m => m[1]), ['ws-east', 'vm-west'], 'two a row');
  const short = out(s, 120, 20).map(strip);
  assert.ok(short.length <= 20);
  assert.deepEqual(titles(short), ['ws-east', 'vm-west']);
  assert.ok(short.includes('+1 machine below — a taller terminal shows it'), short.join('\n'));
  assert.equal(short.at(-1), strip(LEGEND));
});

// ===== ASS-590: every ticket on a card, cut not wrapped; rows stay aligned; the short-terminal cut holds =====

// rowOf(lines, id) — the indexes of the top (┌) and bottom (└) border lines of machine `id`'s card's row.
const rowOf = (lines, id) => {
  const plain = lines.map(strip);
  const top = plain.findIndex(l => l.includes(`┌─ ${id} `));
  const at = plain[top].indexOf(`┌─ ${id} `);
  const bottom = plain.findIndex((l, n) => n > top && l.slice(at).startsWith('└'));
  return { top, bottom, at };
};

test('ASS-590 AC1: a card with more than four tickets lists them all, one a line — no "+N more"', () => {
  const p = orbit();
  const extra = crowd(p, 4);   // ORB-102, -103, -104 and four more: 7 on ws-east
  const lines = out(onN([p, atlas()]));
  const east = onIt(cardOf(lines, 'ws-east'));
  assert.equal(east.length, 7, east.join('\n'));
  for (const key of ['ORB-102', 'ORB-103', 'ORB-104', ...extra]) assert.equal(east.filter(l => l.includes(`${key} `)).length, 1, `${key} once: ${east.join(' | ')}`);
  // The order is unchanged (ticketsOn's): the first three as before.
  assert.deepEqual(east.slice(0, 3), ['🌿 ORB-102 worktree · 🤖x2 Write Plan', '🌿 ORB-201 worktree · idle', '🌿 ORB-202 worktree · idle']);
  assert.ok(!lines.map(strip).some(l => /\+\d+ more/.test(l)), 'no "+N more" on any card');
  // The old boundary: exactly 4 and 5 tickets.
  for (const [n, want] of [[1, 4], [2, 5]]) {
    const q = orbit();
    crowd(q, n);
    const on = onIt(cardOf(out(onN([q])), 'ws-east'));
    assert.equal(on.length, want, on.join('\n'));
    assert.ok(!on.some(l => /more/.test(l)));
  }
  // None: still "nothing of its project".
  assert.deepEqual(onIt(cardOf(out(onN([orbit(), atlas()], { project: 1 })), 'mac')), ['nothing of its project']);
});

test('ASS-590 AC1: an On it line longer than the card is cut with …, never wrapped; its color kept', () => {
  const p = orbit();
  const long = [{ ...workflows[0], steps: workflows[0].steps.map(s => s.id === 'build' ? { ...s, name: 'Build the Whole Thing' } : s) }];
  const assignments = [...team, { project: 'orbit', 'agent-name': 'W', 'work-item': 'ORB-104', variation: 'A', model: 'opus-5' }];
  for (const columns of [120, 200]) {
    const lines = out(onN([p, atlas()], { workflows: long, assignments }), columns);
    for (const l of lines) assert.ok(visible(l) <= columns, `${visible(l)} > ${columns}: ${strip(l)}`);
    for (const id of ['ws-east', 'vm-west']) {
      const c = cardOf(lines, id);
      const i = c.lines.findIndex(l => l.startsWith('On it'));
      const rest = c.lines.slice(i + 1);
      // No continuation line (an entry wrapped under its key, 11 spaces in).
      assert.ok(!rest.some(l => l.startsWith(' '.repeat(11))), `${id} at ${columns}: wrapped\n${c.lines.join('\n')}`);
    }
    if (columns === 120) {
      const east = cardOf(lines, 'ws-east'), crashed = east.lines.find(l => l.includes('ORB-104'));
      assert.ok(crashed.endsWith('…'), crashed);
      assert.ok(onIt(cardOf(lines, 'vm-west'))[0].endsWith('…'), 'vm-west\'s sandbox line cut');
      const raw = lines.find(l => strip(l).includes('ORB-104'));
      assert.ok(raw.includes(RED), 'the crashed state keeps its red on the cut line');
    }
  }
});

test('ASS-590 AC2: side by side, cards of different heights start on one line and the row is the taller card\'s height', () => {
  const p = orbit();
  crowd(p, 4);
  const s = onN([p, atlas()]);
  for (const columns of [120, 200]) {
    const lines = out(s, columns), plain = lines.map(strip);
    const east = rowOf(lines, 'ws-east'), mac = rowOf(lines, 'mac');
    assert.equal(east.top, mac.top, `${columns}: tops on one line`);
    assert.equal(east.bottom, mac.bottom, `${columns}: bottoms on one line\n${plain.join('\n')}`);
    const tall = cardOf(lines, 'ws-east').lines.length, short = cardOf(lines, 'mac').lines.length;
    assert.ok(tall > short, `ws-east (${tall}) taller than mac (${short}) inside`);
    assert.equal(east.bottom - east.top - 1, tall, 'the row as tall as the taller card');
    for (let n = east.top; n <= east.bottom; n++) assert.equal(visible(lines[n]), 2 * cardWidth(columns) + 2, `${columns} line ${n}: ${plain[n]}`);
    for (const l of lines) assert.ok(visible(l) <= columns);
  }
  // Narrow (one a row): each card its own height, all 7 still listed.
  const narrow = out(s, 100);
  for (const l of narrow) assert.ok(visible(l) <= 100);
  assert.equal(onIt(cardOf(narrow, 'ws-east')).length, 7);
});

test('ASS-590 AC3: a short terminal still keeps the headline and the legend, says what is hidden, cuts no card in half', () => {
  const p = orbit();
  crowd(p, 4);
  const s = onN([p, atlas()]);
  for (const height of [20, 30, 6]) {
    const short = out(s, 120, height).map(strip);
    assert.ok(short.length <= height, `${height}: ${short.length}`);
    assert.match(short[0], /^Orbit · \d machines/);
    assert.equal(short.at(-1), strip(LEGEND));
    const shown = titles(short), hidden = 3 - shown.length;
    if (hidden) assert.ok(short.includes(`+${hidden} machine${hidden > 1 ? 's' : ''} below — a taller terminal shows ${hidden > 1 ? 'them' : 'it'}`), `${height}:\n${short.join('\n')}`);
    // Every card shown is whole: each ┌ has its └.
    for (const id of shown) assert.ok(rowOf(short, id).bottom > 0, `${height}: ${id} cut`);
  }
  // Too short for the tall first row: no card at all.
  assert.deepEqual(titles(out(s, 120, 6)), []);
  // Tall enough: everything.
  assert.deepEqual(out(s, 120, 200), out(s, 120));
});
