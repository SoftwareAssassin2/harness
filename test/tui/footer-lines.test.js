// ASS-566: the dashboard's footer is three status lines, for the project on screen, instead of a row of boxes:
// 1. control and accounts — control's state, uptime and pid (red when down: its exit code and restart countdown, or
//    "given up … press R"), Hindsight's state and port, the forge provider and its push account, the Claude account;
// 2. machine health — one summary per machine group the project has (local, gcp workstations, cloud VMs): "healthy",
//    or its healthy and unhealthy machines counted, the unhealthy red;
// 3. usage and spend — Claude's session and weekly use with their resets (red when rate limited), or the API budget's
//    figures when the project bills by API key, the free disk, the repositories, today's and the sprint's spend.
// Each fits 120 columns; a wider screen gets more spacing, never more lines; what doesn't fit is shortened, never wrapped.
// The behaviours of ASS-292 (disk), ASS-293 (Hindsight), ASS-307 (forge, push account), ASS-310 (control), ASS-153 and
// ASS-221 (billing), once the control and models boxes', are tested here on their new lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render, controlStarted, controlExited, controlRestarted } from '../../src/tui/app.js';
import { platform, statusLine } from '../../src/tui/screens/frame.js';
import { machineGroups } from '../../src/tui/machine-health.js';
import { visible, link } from '../../src/tui/text.js';
import { timestamp } from '../../src/tui/screens/shared.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const RED = '\x1b[31m', GREEN = '\x1b[32m', AMBER = '\x1b[38;2;255;176;0m';
const NOW = Date.parse('2026-10-01T16:04:00Z');
const screen = { columns: 120, rows: 40, now: NOW };
const at = '2026-10-01T16:00:00Z';
const G = 2 ** 30;
const ws = id => ({ id, 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' });
const cloud = id => ({ kind: 'cloud-vm', id, 'gcp-project': 'example-gcp-project', zone: 'us-central1-a' });
const running = (extra = {}) => ({ state: 'running', connected: true, 'connected-at': at, setup: { ok: true, 'checked-at': at }, ...extra });
const repos = Array.from({ length: 27 }, (_, i) => ({ url: `https://gitlab.example.com/example-group/repo-${i}` }));
const usage = { email: 'someone@example.com', session: { percent: 21, 'resets-at': '2026-10-03T04:04:00Z' }, weekly: { percent: 90, 'resets-at': '2026-10-03T17:04:00Z' } };
const disk = (level, freeGb) => ({ level, 'free-bytes': freeGb * G, 'warn-bytes': 50e9, 'hold-bytes': 15e9 });
const macProject = (extra = {}) => ({
  id: 'p', name: 'P', sprint: null, environments: [], devEnvironments: { mode: 'vm', workstations: [] }, runTargets: ['local-vm'],
  repositories: repos, pushAccount: { provider: 'GitLab', account: 'push-bot' }, hindsight: { port: 8892 }, claudeUsage: usage, ...extra,
});
const remoteProject = (extra = {}) => macProject({
  devEnvironments: { mode: 'vm+workstation', workstations: [ws('ws-1'), ws('ws-2'), cloud('cvm-1')] }, runTargets: ['workstation', 'cloud-vm', 'local-vm'],
  workstations: { 'ws-1': running(), 'ws-2': running(), 'cvm-1': { state: 'stopped', connected: false } }, ...extra,
});
const stateOf = (p, extra = {}) => ({
  ...initialState({ projects: [p], controls: { p: { pid: 7501, startTime: new Date(NOW - 8000).toISOString() } }, disk: disk('ok', 224.8) }),
  memoryHealth: { p: { port: 8892, healthy: true, since: NOW } }, ...extra,
});
const raw = (s, columns = 120, now = NOW) => platform(s, columns, now);
const footer = (s, columns, now) => raw(s, columns, now).map(strip);
const line = (s, n, columns, now) => footer(s, columns, now)[n].trim();
const parts = text => text.split(/ {2,}/);

test('AC1: the footer is three status lines and a blank, no boxes, for a project on Mac targets only — every line within 120 columns', () => {
  const s = stateOf(macProject());
  const out = footer(s);
  assert.equal(out.length, 4);
  assert.equal(out[3], '');
  assert.ok(!out.join('\n').match(/[┌│└]/), out.join('\n'));
  // At 120 the provider gives way first: its account line names it too.
  assert.deepEqual(parts(out[0].trim()), ['control: up (8s, pid: 7501)', 'hindsight: up (port 8892)', 'GitLab account: push-bot', 'claude account: someone@example.com']);
  assert.deepEqual(parts(out[1].trim()), ['local: healthy']);
  // The third line shortens what doesn't fit at 120 (the repositories' group, the weekly reset), never the spend.
  assert.deepEqual(parts(out[2].trim()), ['session: 21%, resets 1d 12h', 'weekly: 90%', 'disk free: 224.8 GiB', 'repos: 27', 'day spend: $0.00', 'sprint spend: $0.00']);
  for (const l of raw(s)) assert.ok(visible(l) <= 120, strip(l));
  // Wider, everything shows whole, on the same three lines, with more room between.
  const wide = footer(s, 240);
  assert.equal(wide.length, 4);
  assert.deepEqual(parts(wide[0].trim()), ['control: up (8s, pid: 7501)', 'hindsight: up (port 8892)', 'provider: GitLab', 'GitLab account: push-bot', 'claude account: someone@example.com']);
  assert.deepEqual(parts(wide[2].trim()), ['session: 21%, resets 1d 12h', 'weekly: 90%, resets 2d 1h', 'disk free: 224.8 GiB', 'repos: 27 in example-group', 'day spend: $0.00', 'sprint spend: $0.00']);
  assert.ok(wide[0].includes('      hindsight'), 'more spacing on a wider screen');
  // The whole dashboard keeps its size with the footer at its bottom.
  const out120 = render(s, screen).map(strip);
  assert.equal(out120.length, 40);
  assert.match(out120.at(-1), /press \? for menu/);
  assert.equal(out120.at(-2), '');
  assert.match(out120.at(-5), /control: up/);
});

test('AC1: a project with a workstation and a cloud VM — line 2 has its three groups; every line within 120 columns', () => {
  const s = stateOf(remoteProject());
  assert.deepEqual(parts(line(s, 1)), ['local: healthy', 'gcp workstations: 2 healthy', 'cloud VMs: 1 healthy']);
  for (const l of raw(s)) assert.ok(visible(l) <= 120, strip(l));
  // Remote targets only: local still shown (ASS-573: the Mac runs control, the forwarder and Hindsight for every project).
  const remoteOnly = stateOf(remoteProject({ devEnvironments: { mode: 'workstation', workstations: [ws('ws-1'), cloud('cvm-1')] }, runTargets: ['workstation', 'cloud-vm'] }));
  assert.deepEqual(parts(line(remoteOnly, 1)), ['local: healthy', 'gcp workstations: 1 healthy', 'cloud VMs: 1 healthy']);
  // Cloud VMs alone: no workstations group.
  const cloudOnly = stateOf(remoteProject({ devEnvironments: { mode: 'vm+workstation', workstations: [cloud('cvm-1')] } }));
  assert.deepEqual(parts(line(cloudOnly, 1)), ['local: healthy', 'cloud VMs: 1 healthy']);
});

test('AC1: a down control is red on the first line — its exit code and restart countdown, or given up (press R), or ended (press R)', () => {
  const logged = { ...stateOf(macProject()), controlLog: [{ text: 'boom', project: 'p' }, { text: 'control exited (code 1)', project: 'p' }] };
  const down = controlExited(logged, 'p', 1, 0, NOW);
  assert.equal(parts(line(down, 0))[0], 'control: DOWN (exit 1, restart in 5s, crash 1)');
  assert.ok(raw(down)[0].includes(`${RED}control: DOWN (exit 1`), raw(down)[0]);
  assert.equal(parts(line(down, 0, 120, NOW + 3000))[0], 'control: DOWN (exit 1, restart in 2s, crash 1)', 'counting down');
  const gaveUp = { ...down, controlsDown: { p: { ...down.controlsDown.p, restartAt: null, gaveUp: true, crashes: 5 } } };
  assert.equal(parts(line(gaveUp, 0))[0], 'control: DOWN (exit 1, given up after 5 crashes, press R)');
  const ended = controlExited(logged, 'p', 0, 0, NOW);
  assert.equal(parts(line(ended, 0))[0], 'control: DOWN (exit 0, ended, press R)');
  const signal = controlExited(logged, 'p', null, 0, NOW);
  assert.match(parts(line(signal, 0))[0], /^control: DOWN \(exit by signal, restart in 5s/);
  // Its Hindsight and accounts still show (whole on a wider screen), and the lines still fit.
  assert.deepEqual(parts(line(down, 0, 200)).slice(1), ['hindsight: up (port 8892)', 'provider: GitLab', 'GitLab account: push-bot', 'claude account: someone@example.com']);
  for (const l of raw(gaveUp)) assert.ok(visible(l) <= 120, strip(l));
  // Started again after a crash: shown running (ASS-460).
  const back = controlRestarted(down, 'p', { pid: 7502, startTime: new Date(NOW).toISOString() }, NOW);
  assert.match(line(back, 0), /^control: up/);
});

test('AC1 (ASS-310, ASS-457): control from the control the dashboard started — up, draining, restarting, waiting for its data (red), 🤖 for an agent on control, not running', () => {
  const p = macProject();
  const s = controlStarted(initialState({ projects: [p] }), 'p', { pid: 44704, startTime: new Date('2026-10-01T15:51:00Z') });
  assert.equal(parts(line(s, 0))[0], 'control: up (13m 0s, pid: 44704)');
  assert.equal(parts(line(controlStarted(initialState({ projects: [p] }), 'p', { pid: 1, startTime: '2026-09-30T16:43:00Z' }), 0))[0], 'control: up (23h 21m, pid: 1)');
  assert.equal(parts(line({ ...s, draining: { p: 2 } }, 0))[0], 'control: draining (13m 0s, pid: 44704)');
  assert.equal(parts(line({ ...s, draining: { p: 2 }, restart: true }, 0))[0], 'control: draining (13m 0s, pid: 44704)', 'draining over restarting');
  assert.equal(parts(line({ ...s, restart: true }, 0))[0], 'control: restarting (13m 0s, pid: 44704)');
  assert.equal(parts(line({ ...s, draining: { q: 1 } }, 0))[0], 'control: up (13m 0s, pid: 44704)', 'another project draining');
  const waiting = { ...s, dataWaiting: { p: { text: 'cannot read x', since: new Date(NOW) } } };
  assert.equal(parts(line(waiting, 0))[0], 'control: waiting for its data (13m 0s, pid: 44704)');
  assert.ok(raw(waiting)[0].includes(`${RED}control: waiting for its data`));
  const robot = { ...s, assignments: [{ project: 'p', model: 'm', 'agent-name': 'X', 'work-item': null, control: true }] };
  assert.match(line(robot, 0), /^control 🤖: up/);
  const other = { ...s, assignments: [{ project: 'other', model: 'm', 'agent-name': 'X', 'work-item': null, control: true }] };
  assert.match(line(other, 0), /^control: up/);
  assert.equal(parts(line(initialState({ projects: [p] }), 0))[0], 'control: not running');
});

test('AC1 (ASS-293): Hindsight — up green with its port, down red since when, checking before the first check, none without one', () => {
  const at = memoryHealth => ({ ...stateOf(macProject()), memoryHealth });
  assert.ok(raw(at({ p: { port: 8892, healthy: true } }))[0].includes(`${GREEN}hindsight: up (port 8892)`));
  const since = Date.parse('2026-10-01T15:58:00Z');
  assert.ok(raw(at({ p: { port: 8892, healthy: false, since } }), 200)[0].includes(`${RED}hindsight: down (port 8892) since ${timestamp(new Date(since))}`));
  assert.equal(parts(line(at({}), 0))[1], 'hindsight: checking');
  assert.equal(parts(line(at({ p: { port: 9999, healthy: true } }), 0))[1], 'hindsight: checking');
  assert.equal(parts(line({ ...stateOf(macProject({ hindsight: null })) }, 0))[1], 'hindsight: none');
});

test('AC1 (ASS-307): the provider and its push account — plain, red on failure, … unknown; one repository or several on line 3, linked; none without repositories', () => {
  const s = account => stateOf(macProject({ pushAccount: account }));
  assert.equal(parts(line(s({ provider: 'GitLab', account: 'push-bot' }), 0, 200))[3], 'GitLab account: push-bot');
  for (const pending of [null, { provider: 'GitHub', account: 'old' }]) assert.equal(parts(line(s(pending), 0, 200))[3], 'GitLab account: …');
  const failed = s({ provider: 'GitLab', account: null, error: 'token rejected (401)' });
  assert.equal(parts(line(failed, 0, 200))[3], 'GitLab account: token rejected (401)');
  assert.ok(raw(failed, 200)[0].includes(`${RED}GitLab account: token rejected (401)`));
  // One GitHub repository: repo: owner/name, linked.
  const hub = 'https://github.com/example-owner/harness';
  const one = stateOf(macProject({ repositories: [{ url: hub }], pushAccount: { provider: 'GitHub', account: 'bot' } }));
  assert.deepEqual(parts(line(one, 0, 200)).slice(2, 4), ['provider: GitHub', 'GitHub account: bot']);
  assert.ok(raw(one, 240)[2].includes(`repo: ${link('example-owner/harness', hub)}`));
  // Several: repos: <N> in <group>, linked to the group (whole on a wide screen); under no common owner, the host.
  assert.ok(raw(stateOf(macProject()), 240)[2].includes(`repos: ${link('27 in example-group', 'https://gitlab.example.com/example-group')}`));
  const apart = stateOf(macProject({ repositories: [{ url: 'https://gitlab.com/one/a' }, { url: 'https://gitlab.com/two/b' }, { url: 'not a url' }] }));
  assert.ok(footer(apart, 240)[2].includes('repos: 2 in gitlab.com'));
  // No repositories: no provider, account or repos.
  for (const repositories of [undefined, [], [{ url: 'not a url' }]]) {
    const none = footer(stateOf(macProject({ repositories })), 240).join('\n');
    assert.ok(!/provider:|account: push|repos?:/.test(none), none);
  }
});

test('AC1 (ASS-47, ASS-65, ASS-221): the Claude account on line 1; session and weekly with their resets on line 3, dashes without a reading, red while rate limited', () => {
  const s = stateOf(macProject());
  assert.equal(parts(line(s, 0)).at(-1), 'claude account: someone@example.com');
  assert.deepEqual(parts(line(s, 2, 240)).slice(0, 2), ['session: 21%, resets 1d 12h', 'weekly: 90%, resets 2d 1h']);
  const passed = parts(line(s, 2, 240, Date.parse('2026-10-03T04:04:05Z')))[0];
  assert.equal(passed, 'session: —');                                  // ASS-571: a window that is over shows no percent
  const none = stateOf(macProject({ claudeUsage: null }));
  assert.deepEqual(parts(line(none, 2)).slice(0, 2), ['session: —', 'weekly: —']);
  assert.equal(parts(line(none, 0)).at(-1), 'claude account: —');
  const limited = stateOf(macProject({ rateLimit: { claude: { type: 'five_hour', 'resets-at': '2026-10-01T18:00:00Z' } } }));
  assert.ok(raw(limited)[2].includes(`${RED}session: 21%`) && raw(limited)[2].includes(`${RED}weekly: 90%`), raw(limited)[2]);
  assert.ok(!raw(s)[2].includes(RED));
});

test('ASS-571 AC3: a window past its reset shows a gray dash; a reading over 10 minutes old its age in gray; a recorded failure a red "usage unreadable (…)"; all within 120 columns', () => {
  const GRAY = '\x1b[90m';
  // Seen live: a session that reset 1d 19h ago, the week still running, read two days ago, the token expired since.
  const old = { ...usage, session: { percent: 21, 'resets-at': '2026-09-29T21:04:00Z' }, 'as-of': '2026-09-29T16:00:00Z', failure: { why: 'the token has expired; Claude Code could not refresh it (claude -p failed: …)', at: '2026-09-29T18:00:00Z' } };
  const s = stateOf(macProject({ claudeUsage: old }));
  const wide = parts(line(s, 2, 240));
  assert.deepEqual(wide.slice(0, 3), ['session: —', 'weekly: 90%, resets 2d 1h', 'usage unreadable (token expired), as of 2d ago']);
  const out = raw(s);
  assert.ok(out[2].includes(`${GRAY}session: —`), out[2]);
  assert.ok(out[2].includes(`${RED}unreadable`), out[2]);
  for (const l of out) assert.ok(visible(l) <= 120, strip(l));
  // At 120 the note shortens with the rest (ASS-566), keeping both what failed and how old the figures are.
  assert.deepEqual(parts(strip(out[2]).trim()), ['session: —', 'weekly: 90%', 'unreadable, read 2d ago', 'disk free: 224.8 GiB', 'repos: 27', 'day spend: $0.00', 'sprint spend: $0.00']);
  assert.ok(raw(s, 240)[2].includes(`${RED}usage unreadable (token expired)`) && raw(s, 240)[2].includes(`${GRAY}, as of 2d ago`), raw(s, 240)[2]);
  // The weekly window past its reset too; gray even while rate limited.
  const both = stateOf(macProject({ claudeUsage: { ...old, weekly: { percent: 93, 'resets-at': '2026-09-30T03:00:00Z' } }, rateLimit: { claude: { type: 'five_hour', 'resets-at': '2026-10-01T18:00:00Z' } } }));
  assert.ok(raw(both)[2].includes(`${GRAY}weekly: —`), raw(both)[2]);
  // Fresh (within 10 minutes) with no failure: neither note.
  const fresh = stateOf(macProject({ claudeUsage: { ...usage, 'as-of': '2026-10-01T15:56:00Z' } }));
  assert.ok(!/as of|unreadable/.test(line(fresh, 2, 240)), line(fresh, 2, 240));
  const eleven = stateOf(macProject({ claudeUsage: { ...usage, 'as-of': '2026-10-01T15:53:00Z' } }));
  assert.equal(parts(line(eleven, 2, 240))[2], 'as of 11m ago');
  const hours = stateOf(macProject({ claudeUsage: { ...usage, 'as-of': '2026-10-01T11:00:00Z' } }));
  assert.equal(parts(line(hours, 2, 240))[2], 'as of 5h ago');
  // Each cause in a few words.
  const why = w => parts(line(stateOf(macProject({ claudeUsage: { ...usage, 'as-of': '2026-10-01T16:03:00Z', failure: { why: w, at: '2026-10-01T16:03:00Z' } } })), 2, 240))[2];
  assert.equal(why('the token was refused (401)'), 'usage unreadable (token refused)');
  assert.equal(why('no token'), 'usage unreadable (no token)');
  assert.equal(why('the usage endpoint is unreachable'), 'usage unreadable (endpoint unreachable)');
  assert.equal(why('the usage endpoint is unavailable (503)'), 'usage unreadable (endpoint unavailable)');
  // Worst case at 120: a remote project, its repositories, a failure and an old reading, still one line within 120.
  const crowded = stateOf(remoteProject({ claudeUsage: old }));
  for (const l of raw(crowded)) assert.ok(visible(l) <= 120, strip(l));
  assert.ok(strip(raw(crowded)[2]).includes('unreadable, read 2d ago'), strip(raw(crowded)[2]));
});

test('AC1 (ASS-153, ASS-221): billed by API key — its org and the API budget\'s figures (gold from 80%, red at it), or spend unknown; a subscription keeps its own spend beside its use', () => {
  const api = (apiCost, method = 'api_key') => stateOf(macProject({ claudeUsage: { ...usage, 'auth-method': method, org: 'Example Org' }, apiCost }));
  const cost = (usd, budget = null, month = '2026-10') => ({ month, usd, budget });
  assert.deepEqual(parts(line(api(cost(3.92, 50)), 2, 240)).slice(0, 2), ['billing: API key (Example Org)', 'API $3.92 / $50 this month']);
  assert.deepEqual(parts(line(api(null), 2, 240)).slice(0, 2), ['billing: API key (Example Org)', 'API spend: unknown for Example Org']);
  assert.equal(parts(line(api(cost(3.92, 50, '2026-09')), 2, 240))[1], 'API spend: unknown for Example Org', 'last month\'s is not this month\'s');
  assert.ok(raw(api(cost(40, 50)), 240)[2].includes('\x1b[38;2;255;215;0mAPI $40.00 / $50'), 'gold from 80%');
  assert.ok(raw(api(cost(50, 50)), 240)[2].includes(`${RED}API $50.00 / $50`), 'red at the budget');
  assert.equal(parts(line(api(cost(12.34)), 2, 240))[1], 'API $12.34 this month');
  const subscription = api(cost(3.92, 50), 'claude.ai');
  assert.deepEqual(parts(line(subscription, 2, 240)).slice(0, 3), ['session: 21%, resets 1d 12h', 'weekly: 90%, resets 2d 1h', 'API $3.92 / $50 this month']);
  for (const s of [api(cost(3.92, 50)), subscription]) for (const l of raw(s)) assert.ok(visible(l) <= 120, strip(l));
});

test('AC1 (ASS-292): the free disk — amber below the warning level, unknown never read', () => {
  assert.ok(footer(stateOf(macProject(), { disk: disk('ok', 120) }))[2].includes('disk free: 120.0 GiB'));
  assert.ok(raw(stateOf(macProject(), { disk: disk('warn', 42) }))[2].includes(`${AMBER}disk free: 42.0 GiB`));
  assert.ok(raw(stateOf(macProject(), { disk: disk('hold', 12) }))[2].includes(`${AMBER}disk free: 12.0 GiB`));
  assert.ok(!raw(stateOf(macProject(), { disk: disk('ok', 120) }))[2].includes(AMBER));
  assert.ok(footer(stateOf(macProject(), { disk: null }))[2].includes('disk free: unknown'));
});

test('AC1: no footer on the flow screens, none without a project; the screens size themselves to it', () => {
  for (const screen of ['S', 'B']) assert.deepEqual(raw({ ...stateOf(macProject()), screen }), []);
  assert.deepEqual(raw(initialState({ projects: [] })), []);
});

test('AC1: statusLine never wraps — it shortens the marked segments first, then the widest, with an ellipsis, never past the columns', () => {
  assert.equal(statusLine(['a', 'b'], 20), `${' '.repeat(6)}a      b`);   // more room, up to 6 apart, centred
  const cut = strip(statusLine(['x'.repeat(50), { text: 'y'.repeat(50), cut: 1 }, 'z'.repeat(10)], 60));
  assert.ok(visible(cut) <= 60, cut);
  assert.ok(cut.includes('…'));
  assert.ok(cut.includes('z'.repeat(10)), 'the short one kept');
  const short = strip(statusLine([{ text: 'repos: 27 in some-long-group', short: 'repos: 27', cut: 1 }, 'w'.repeat(100)], 120));
  assert.ok(short.startsWith('repos: 27  ') || short.trimStart().startsWith('repos: 27  '), short);
  assert.ok(visible(strip(statusLine(['q'.repeat(300)], 120))) <= 120);
});

// AC2: line 2's counts. unhealthy(remote) — the remote project with ws-2 (or cvm-1) set as given.
const group = (s, name) => parts(line(s, 1, 200)).find(p => p.startsWith(`${name}:`));
const rawGroup = s => raw(s, 200)[1];
const fresh = '2026-10-01T16:03:00Z';

test('AC2: a workstation whose setup failed, or that needs a sign-in, is unhealthy — counted, red, with why', () => {
  const failed = stateOf(remoteProject({ workstations: { 'ws-1': running(), 'ws-2': running({ setup: { ok: false, error: 'no docker' } }), 'cvm-1': { state: 'stopped' } } }));
  assert.equal(group(failed, 'gcp workstations'), 'gcp workstations: 1 healthy, 1 unhealthy (ws-2 setup failed)');
  assert.ok(rawGroup(failed).includes(`${RED}1 unhealthy (ws-2 setup failed)`), rawGroup(failed));
  assert.ok(!rawGroup(failed).includes(`${RED}gcp workstations: 1 healthy`), 'the healthy count not red');
  const signIn = stateOf(remoteProject({ workstations: { 'ws-1': running(), 'ws-2': { connected: false, 'last-error': { at, kind: 'expired', message: 'login expired' } }, 'cvm-1': { state: 'stopped' } } }));
  assert.equal(group(signIn, 'gcp workstations'), 'gcp workstations: 1 healthy, 1 unhealthy (ws-2 sign in needed)');
});

test('AC2: a cloud VM that can\'t be reached, or whose start timed out, is unhealthy', () => {
  const unreachable = stateOf(remoteProject({ workstations: { 'ws-1': running(), 'ws-2': running(), 'cvm-1': { state: 'stopped', connected: false, 'last-error': { at, kind: 'ssh', message: 'no route' } } } }));
  assert.equal(group(unreachable, 'cloud VMs'), 'cloud VMs: 1 unhealthy (cvm-1 unreachable)');
  assert.ok(rawGroup(unreachable).includes(`${RED}1 unhealthy (cvm-1 unreachable)`));
  const timedOut = stateOf(remoteProject({ workstations: { 'ws-1': running(), 'ws-2': running(), 'cvm-1': { connected: false, 'last-error': { at, kind: 'timeout', message: 'no SSH' } } } }));
  assert.equal(group(timedOut, 'cloud VMs'), 'cloud VMs: 1 unhealthy (cvm-1 start timed out)');
});

test('AC2: a remote machine over its memory or CPU limit, whose reading failed, or whose disk is held, is unhealthy; the Mac over its budget or holding its disk too', () => {
  const measured = extra => ({ state: 'measured', held: 1, seats: 2, 'memory-used-bytes': 8 * G, 'memory-budget-bytes': 28 * G, 'cpu-percent': 100, 'cpu-budget-percent': 720, ...extra });
  const budget = remoteBudget => stateOf(remoteProject({ remoteBudget }));
  assert.equal(group(budget({ 'ws-2': measured({ 'memory-used-bytes': 30 * G }) }), 'gcp workstations'), 'gcp workstations: 1 healthy, 1 unhealthy (ws-2 over memory)');
  assert.equal(group(budget({ 'ws-2': measured({ 'cpu-percent': 800 }) }), 'gcp workstations'), 'gcp workstations: 1 healthy, 1 unhealthy (ws-2 over cpu)');
  assert.equal(group(budget({ 'ws-2': { state: 'unread', why: 'ssh failed' } }), 'gcp workstations'), 'gcp workstations: 1 healthy, 1 unhealthy (ws-2 not read)');
  assert.equal(group(budget({ 'ws-1': measured({ disk: { held: true, 'free-bytes': 5e9 } }), 'ws-2': measured({ disk: { held: true } }) }), 'gcp workstations'), 'gcp workstations: 2 unhealthy (ws-1 disk held; ws-2 disk held)');
  assert.equal(group(budget({ 'ws-2': measured() }), 'gcp workstations'), 'gcp workstations: 2 healthy', 'measured under its limits');
  // The Mac: over its memory or CPU budget, unreadable, holding its disk, or out of memory.
  const mac = (over, extra = {}) => stateOf(macProject({ seatBudget: { seats: 2, mac: { over } } }), extra);
  assert.equal(group(mac(['memory']), 'local'), 'local: unhealthy (over memory)');
  assert.ok(rawGroup(mac(['memory'])).includes(`${RED}local: unhealthy (over memory)`));
  assert.equal(group(mac(['cpu']), 'local'), 'local: unhealthy (over cpu)');
  assert.equal(group(mac(['unread']), 'local'), 'local: unhealthy (not read)');
  assert.equal(group(mac([], { disk: disk('hold', 12) }), 'local'), 'local: unhealthy (disk held)');
  assert.equal(group(stateOf(macProject({ memoryHold: { since: at } })), 'local'), 'local: unhealthy (out of memory)');
  assert.equal(group(mac([], { disk: disk('warn', 42) }), 'local'), 'local: healthy', 'disk low is a warning, not unhealthy');
  assert.equal(group(mac([]), 'local'), 'local: healthy');
});

test('AC2: a machine whose Substrate cluster is broken is unhealthy — the Mac\'s and a workstation\'s; a stale check counts for nothing', () => {
  const check = (state, problems = [], checkedAt = fresh) => ({ state, problems, 'checked-at': checkedAt });
  const broken = stateOf(remoteProject({ substrateMachines: ['mac', 'ws-2'], substrate: { mac: check('missing'), 'ws-2': check('broken', [{ what: 'node', why: 'down', repair: true }]) } }));
  assert.equal(group(broken, 'local'), 'local: unhealthy (cluster missing)');
  assert.equal(group(broken, 'gcp workstations'), 'gcp workstations: 1 healthy, 1 unhealthy (ws-2 cluster broken)');
  const memory = stateOf(remoteProject({ substrate: { 'ws-2': check('broken', [{ what: 'host memory', why: 'low', repair: false }]) } }));
  assert.equal(group(memory, 'gcp workstations'), 'gcp workstations: 1 healthy, 1 unhealthy (ws-2 Docker memory low)');
  const golden = stateOf(macProject({ substrateMachines: ['mac'], substrate: { mac: check('broken', [{ what: 'templates', why: 'no golden snapshot', repair: false }]) } }));
  assert.equal(group(golden, 'local'), 'local: unhealthy (no golden snapshot)');
  const stale = stateOf(remoteProject({ substrate: { 'ws-2': check('broken', [], '2026-10-01T10:00:00Z') } }));
  assert.equal(group(stale, 'gcp workstations'), 'gcp workstations: 2 healthy');
  const healthy = stateOf(remoteProject({ substrate: { 'ws-2': check('healthy') } }));
  assert.equal(group(healthy, 'gcp workstations'), 'gcp workstations: 2 healthy');
});

test('AC2: stopped and idle is not unhealthy — a stopped workstation or cloud VM with no error counts healthy, nothing red', () => {
  const s = stateOf(remoteProject({ workstations: { 'ws-1': { state: 'stopped', connected: false }, 'ws-2': running(), 'cvm-1': { state: 'stopped', connected: false } }, remoteBudget: { 'ws-1': { state: 'unmeasured', why: 'not connected', seats: 1, held: 0 } } }));
  assert.equal(group(s, 'gcp workstations'), 'gcp workstations: 2 healthy');
  assert.equal(group(s, 'cloud VMs'), 'cloud VMs: 1 healthy');
  assert.ok(!rawGroup(s).includes(RED), rawGroup(s));
  // machineGroups gives each machine's troubles, none here.
  assert.deepEqual(machineGroups(s, s.projects[0], NOW).map(g => [g.name, g.machines.map(m => m.troubles.length)]), [['local', [0]], ['gcp workstations', [0, 0]], ['cloud VMs', [0]]]);
});

test('AC2: with many unhealthy machines line 2 is shortened with an ellipsis, never wrapped', () => {
  const list = Array.from({ length: 12 }, (_, i) => ws(`workstation-number-${i}`));
  const s = stateOf(remoteProject({ devEnvironments: { mode: 'vm+workstation', workstations: list }, workstations: Object.fromEntries(list.map(w => [w.id, running({ setup: { ok: false } })])) }));
  const out = raw(s);
  assert.equal(out.length, 4);
  assert.ok(visible(out[1]) <= 120 && strip(out[1]).includes('…'), strip(out[1]));
  assert.match(strip(out[1]), /gcp workstations: 12 unhealthy/);
});

test('ASS-573 AC2: control is coloured like Hindsight — green up, amber while draining or restarting, red waiting for its data, gray not running', () => {
  const YELLOW = '\x1b[33m', GRAY = '\x1b[90m';
  const up = stateOf(macProject());
  assert.ok(raw(up)[0].includes(`${GREEN}control: up (`), raw(up)[0]);
  assert.ok(raw(up)[0].includes(`${GREEN}hindsight: up (port 8892)`), 'Hindsight as before');
  assert.ok(raw({ ...up, draining: { p: NOW } })[0].includes(`${YELLOW}control: draining (`));
  assert.ok(raw({ ...up, restart: true })[0].includes(`${YELLOW}control: restarting (`));
  assert.ok(raw({ ...up, dataWaiting: { p: true } })[0].includes(`${RED}control: waiting for its data (`));
  const none = { ...up, controls: {} };
  assert.match(strip(raw(none)[0]).trim(), /^control: not running/);
  assert.ok(!raw(none)[0].includes(`${GREEN}control:`));
  for (const s of [up, { ...up, draining: { p: NOW } }]) for (const l of raw(s)) assert.ok(visible(l) <= 120, strip(l));
});
