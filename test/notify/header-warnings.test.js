// ASS-412: a Mac notification when a dashboard header warning appears, for any
// project — one list (frame.js headerWarnings) for the header and the
// notifier; each warning's appear, stay and clear-and-return; start-up
// silence and the seen file; No work in progress's 5-minute wait; the
// operator-caused exclusions; the per-project switch; harness-wide warnings
// notifying once; and the click selecting the project. The notifier's
// programs are stubbed: terminal-notifier and osascript never run for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, render, openRequested } from '../../src/tui/app.js';
import { headerWarnings, IDLE_AFTER_MS } from '../../src/tui/screens/frame.js';
import { liveWarnings, HARNESS } from '../../src/notify/warnings.js';
import { headerWarningNotifier, openCommand, GHOSTTY, HARNESS_SUBTITLE } from '../../src/notify/notifier.js';
import { readSeen } from '../../src/notify/detect.js';

const ROOT = join(import.meta.dirname, '..', '..');
const NOW = Date.parse('2026-10-01T16:04:00Z');
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const steps = [
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const blockedSteps = [{ id: 'await-fix', name: 'Await the Fix', sequence: 2, action: { type: 'script', command: './agent.sh ticket:fix-landed {project} {work-item} {variation}', mode: 'timer' } }];
const ticket = (key, extra = {}) => ({ key, title: `Title of ${key}`, variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' }, ...extra }] });
const waitingFix = (key, fix) => ({ key, title: 'T', variations: [{ name: 'A', 'awaiting-restart': fix, 'harness-status': { state: 'build', 'state-engine': 'e', 'sub-status': { state: 'await-fix', 'state-engine': 'gb' } } }] });
// A project at work: an agent on a sprint ticket, so No work in progress is not up.
const project = (id, extra = {}, features = [ticket(`${id.toUpperCase()}-1`)]) => ({ id, name: `Project ${id}`, stateEngine: 'e', sprint: { number: 3, start: '2026-09-25', end: '2026-10-08', features, bugs: [], spikes: [] }, backlog: [], questions: [], days: {}, notifications: true, ...extra });
const busy = projects => projects.map(p => ({ project: p.id, 'agent-name': `agent-${p.id}`, 'work-item': p.sprint.features[0]?.key, variation: 'A' }));
const stateOf = (projects, more = {}) => ({ ...initialState({ projects, workflows: [{ name: 'e', steps }, { name: 'gb', steps: blockedSteps }], assignments: more.assignments ?? busy(projects) }), ...more, assignments: more.assignments ?? busy(projects) });

// Each warning that notifies: how to raise it in project p (of p and q), its id, title and body.
const WARNINGS = [
  { id: 'credentials', text: 'Project blocked by credentials', scope: 'project', todo: 'Run security add-generic-password -s gitlab-token', raise: s => withProject(s, 'p', { credentialsHold: { since: '2026-10-01T00:00:00Z', problems: [{ credential: 'gitlab-token', problem: 'missing from the keychain', fix: 'security add-generic-password -s gitlab-token' }] } }) },
  { id: 'gcloud-login', text: "run 'gcloud auth login' asap", scope: 'project', todo: 'Run gcloud auth login in a terminal', raise: s => withProject(s, 'p', { gcloudReauthentication: true }) },
  { id: 'glab-login', text: "run 'glab auth login' asap", scope: 'project', todo: 'Run glab auth login in a terminal', raise: s => withProject(s, 'p', { glabReauthentication: true }) },
  { id: 'out-of-memory', text: 'Out of memory', scope: 'harness', todo: /^Free memory/, raise: s => withProject(s, 'p', { memoryHold: { since: 'x' } }) },
  { id: 'out-of-disk-space', text: 'Out of disk space', scope: 'harness', todo: 'Free disk space: nothing new starts until 50 GB is free', raise: s => ({ ...s, disk: { level: 'hold', 'free-bytes': 2 ** 30, 'warn-bytes': 50e9 } }) },
  { id: 'disk-low', text: 'Disk low', scope: 'harness', todo: /^Free disk space: 20\.0 GiB free, below the 50 GB/, raise: s => ({ ...s, disk: { level: 'warn', 'free-bytes': 20 * 2 ** 30, 'warn-bytes': 50e9 } }) },
  { id: 'restart', text: 'Restart to load 2 landed fixes', scope: 'harness', todo: 'Restart the harness to load HD-7, HD-9', raise: s => withProject(s, 'p', { sprint: { ...s.projects[0].sprint, features: [...s.projects[0].sprint.features, waitingFix('P-2', 'HD-7'), waitingFix('P-3', 'HD-9')] } }) },
  { id: 'sign-in', text: 'Sign in', scope: 'project', todo: 'Sign in: CLAUDE_CONFIG_DIR=/x/.claude claude, then /login as ops@example.com', raise: s => withProject(s, 'p', { accountHold: { expected: 'ops@example.com', actual: null, 'config-dir': '/x/.claude' } }) },
  { id: 'rate-limited', text: 'Rate limited', scope: 'project', todo: /^Wait: control sends its claude agents nothing until it resets/, raise: s => withProject(s, 'p', { rateLimit: { claude: { since: '2026-10-01T15:00:00Z', type: 'five_hour', 'resets-at': '2026-10-01T18:00:00Z' } } }) },
  { id: 'self-healing', text: 'Self healing', scope: 'project', todo: 'Control is fixing a broken step', raise: s => ({ ...s, selfHealing: { 'HD-1': { project: 'p', summary: 'a broken step', ticket: 'HD-1', paused: [] } } }) },
];
const withProject = (state, id, extra) => ({ ...state, projects: state.projects.map(p => (p.id === id ? { ...p, ...extra } : p)) });

// The notifier with terminal-notifier "on the PATH" (an empty executable) and run faked: records [file, args].
function harness({ path = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'warn-notify-'));
  if (path) { writeFileSync(join(dir, 'terminal-notifier'), ''); chmodSync(join(dir, 'terminal-notifier'), 0o755); }
  const runs = [], logs = [];
  const make = () => headerWarningNotifier({ seenFile: join(dir, 'header-warnings-seen.json'), agentSh: '/h/agent.sh', env: { PATH: path ? dir : '' }, run: (file, args, _opts, done) => { runs.push([file, args]); done(null); }, log: t => logs.push(t), clock: () => NOW });
  const option = (args, name) => args[args.indexOf(name) + 1];
  const sent = () => runs.map(([, args]) => ({ title: option(args, '-title'), subtitle: option(args, '-subtitle'), message: option(args, '-message'), group: option(args, '-group'), execute: option(args, '-execute'), activate: option(args, '-activate'), sound: option(args, '-sound') }));
  return { dir, runs, logs, make, sent };
}
const two = (more = {}) => stateOf([project('p'), project('q')], more);

test('ASS-412 AC1: one list per project — each warning has a stable id, its text, a scope, whether the operator caused it and what to do; the header\'s red boxes are its chips', () => {
  const base = two();
  assert.deepEqual(headerWarnings(base, NOW), []);
  for (const w of WARNINGS) {
    const list = headerWarnings(w.raise(base), NOW);
    assert.equal(list.length, 1, w.id);
    const [got] = list;
    assert.deepEqual([got.id, got.text, got.scope, got.operator], [w.id, w.text, w.scope, false]);
    if (typeof w.todo === 'string') assert.equal(got.todo, w.todo); else assert.match(got.todo, w.todo);
  }
  // The header shows each chip, in white on red, as before.
  const all = WARNINGS.filter(w => ['credentials', 'gcloud-login', 'glab-login', 'out-of-memory', 'restart'].includes(w.id)).reduce((s, w) => w.raise(s), base);
  const chips = headerWarnings(all, NOW).filter(w => w.chip).map(w => w.text);
  assert.deepEqual(chips, ['Project blocked by credentials', "run 'gcloud auth login' asap", "run 'glab auth login' asap", 'Out of memory', 'Restart to load 2 landed fixes']);
  const out = render(all, { columns: 260, rows: 50, now: new Date(NOW) });
  assert.ok(out.some(l => l.includes(chips.map(c => `\x1b[41;97m ${c} \x1b[0m`).join(' '))), out.map(strip).join('\n'));
  // The banner's (disk low, sign in, rate limit, self-healing, the human's pause) are no chips.
  for (const id of ['disk-low', 'sign-in', 'rate-limited', 'self-healing']) assert.equal(headerWarnings(WARNINGS.find(w => w.id === id).raise(base), NOW)[0].chip, false, id);
});

test('ASS-412 AC1: the notifier evaluates it for every project, whichever is selected or the day on show; harness-wide ones once', () => {
  const state = { ...WARNINGS[1].raise(withProject(two(), 'q', { memoryHold: {}, glabReauthentication: true })), project: 1, day: '2026-09-30' };
  const live = liveWarnings(state, NOW);
  assert.deepEqual(Object.fromEntries(Object.entries(live).map(([scope, items]) => [scope, items.map(i => `${i.key}:${i.projects.join(',')}`)])),
    { p: ['gcloud-login:p'], q: ['glab-login:q'], [HARNESS]: ['out-of-memory:p,q'] });
});

for (const w of WARNINGS) {
  test(`ASS-412 AC2, AC5: ${w.id} — appearing notifies once (title, subtitle, what to do, default sound, Ghostty, a click selecting the project); staying up does not; clearing and coming back does`, async () => {
    const h = harness(), n = h.make();
    const clear = two(), up = w.raise(clear);
    assert.deepEqual(n.check(clear), []);
    assert.deepEqual(n.check(up).map(e => e.id), [w.id]);
    assert.deepEqual(n.check(up), [], 'staying up');
    assert.deepEqual(n.check(clear), [], 'cleared');
    assert.deepEqual(n.check(up).map(e => e.id), [w.id], 'back again');
    await n.sent();
    const sent = h.sent();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].title, w.text);
    assert.equal(sent[0].subtitle, w.scope === 'harness' ? HARNESS_SUBTITLE : 'Project p');
    if (typeof w.todo === 'string') assert.equal(sent[0].message, w.todo); else assert.match(sent[0].message, w.todo);
    assert.deepEqual([sent[0].sound, sent[0].activate, sent[0].execute], ['default', GHOSTTY, `'/h/agent.sh' 'notify:open-ticket' 'p'`]);
    assert.equal(sent[0].group, `warning/${w.scope === 'harness' ? 'harness' : 'p'}/${w.id}`);
  });
}

test('ASS-412 AC3: warnings already up when the dashboard starts do not notify, nor after a restart (the seen file under data/); one that cleared while it was down notifies when it returns', async () => {
  const h = harness();
  const up = WARNINGS[0].raise(WARNINGS[1].raise(two()));
  const first = h.make();
  assert.deepEqual(first.check(up), []);
  assert.deepEqual(first.check(up), []);
  assert.deepEqual(readSeen(join(h.dir, 'header-warnings-seen.json')), { p: ['credentials', 'gcloud-login'] });
  const again = h.make();                                                         // restarted
  assert.deepEqual(again.check(up), []);
  assert.deepEqual(again.check(WARNINGS[1].raise(two())), []);                    // credentials cleared
  assert.deepEqual(again.check(up).map(e => e.id), ['credentials']);
  await again.sent();
  assert.equal(h.sent().length, 1);
});

test('ASS-412 AC3: No work in progress notifies only once it has stayed up 5 minutes — a short gap never; due() tells the clock when to check', async () => {
  const h = harness(), n = h.make();
  const working = two(), idle = stateOf([project('p'), project('q')], { assignments: busy([project('q')]) });
  assert.deepEqual(headerWarnings(idle, NOW).map(w => [w.id, w.after]), [['idle', IDLE_AFTER_MS]]);
  n.check(working, NOW);
  assert.deepEqual(n.check(idle, NOW), []);
  assert.equal(n.due(NOW + IDLE_AFTER_MS - 1), false);
  assert.deepEqual(n.check(idle, NOW + 60e3), []);
  assert.deepEqual(n.check(working, NOW + 120e3), [], 'a short gap');
  assert.equal(n.due(NOW + 10 * IDLE_AFTER_MS), false);
  assert.deepEqual(n.check(idle, NOW + 180e3), []);
  assert.equal(n.due(NOW + 180e3 + IDLE_AFTER_MS), true);
  assert.deepEqual(n.check(idle, NOW + 180e3 + IDLE_AFTER_MS).map(e => `${e.project}/${e.id}`), ['p/idle']);
  assert.equal(n.due(NOW + 180e3 + 2 * IDLE_AFTER_MS), false);
  assert.deepEqual(n.check(idle, NOW + 180e3 + 2 * IDLE_AFTER_MS), [], 'staying up');
  await n.sent();
  assert.deepEqual(h.sent().map(s => [s.title, s.subtitle]), [['No work in progress', 'Project p']]);
  // Idle when the dashboard starts: seen, so never notified, however long it stays.
  const fresh = harness().make();
  fresh.check(idle, NOW);
  assert.deepEqual(fresh.check(idle, NOW + 60e3), []);
  assert.deepEqual(fresh.check(idle, NOW + 2 * IDLE_AFTER_MS), []);
});

test('ASS-412 AC3: warnings the operator caused — Background work off, the operator\'s own pause — never notify', async () => {
  const h = harness(), n = h.make();
  n.check(two());
  const off = withProject(two(), 'p', { backgroundWorkOff: true });
  assert.deepEqual(headerWarnings(off, NOW).map(w => [w.id, w.operator, w.chip]), [['background-work-off', true, true]]);
  assert.deepEqual(n.check(off), []);
  const paused = two({ pauses: { p: { human: { at: 'x' } } } }), all = two({ pauses: { all: { human: { at: 'x' } } } });
  assert.deepEqual(headerWarnings(paused, NOW).map(w => [w.id, w.operator, w.scope]), [['paused-by-human', true, 'project']]);
  assert.deepEqual(headerWarnings(all, NOW).map(w => [w.id, w.operator, w.scope]), [['paused-by-human', true, 'harness']]);
  assert.deepEqual(n.check(paused), []);
  assert.deepEqual(n.check(all), []);
  await n.sent();
  assert.equal(h.runs.length, 0);
});

test('ASS-412 AC4: the project\'s notifications switch turns them off for that project alone; a harness-wide one goes to a project with them on, none when all are off', async () => {
  const h = harness(), n = h.make();
  const quiet = (s, ids) => ({ ...s, projects: s.projects.map(p => (ids.includes(p.id) ? { ...p, notifications: false } : p)) });
  n.check(quiet(two(), ['p']));
  const login = s => withProject(withProject(s, 'p', { gcloudReauthentication: true }), 'q', { gcloudReauthentication: true });
  assert.deepEqual(n.check(quiet(login(two()), ['p'])).map(e => `${e.project}/${e.id}`), ['q/gcloud-login']);
  const memory = s => withProject(s, 'p', { memoryHold: {} });
  assert.deepEqual(n.check(quiet(memory(login(two())), ['p'])).map(e => `${e.scope}/${e.project}/${e.id}`), [`${HARNESS}/q/out-of-memory`]);
  assert.deepEqual(n.check(quiet(login(two()), ['p', 'q'])), []);
  assert.deepEqual(n.check(quiet(memory(login(two())), ['p', 'q'])), [], 'every project off');
  await n.sent();
  assert.deepEqual(h.sent().map(s => [s.title, s.subtitle, s.execute]), [
    ["run 'gcloud auth login' asap", 'Project q', `'/h/agent.sh' 'notify:open-ticket' 'q'`],
    ['Out of memory', HARNESS_SUBTITLE, `'/h/agent.sh' 'notify:open-ticket' 'q'`],
  ]);
});

test('ASS-412 AC4: harness-wide warnings (Out of memory, Out of disk space, Restart to load …) notify once, not once per project', async () => {
  const h = harness(), n = h.make();
  const three = more => stateOf([project('p'), project('q'), project('r')], more);
  n.check(three());
  const memory = withProject(withProject(three({ disk: { level: 'hold', 'free-bytes': 1, 'warn-bytes': 50e9 } }), 'q', { memoryHold: {} }), 'r', { memoryHold: {} });
  assert.deepEqual(n.check(memory).map(e => `${e.scope}/${e.id}`).sort(), [`${HARNESS}/out-of-disk-space`, `${HARNESS}/out-of-memory`]);
  await n.sent();
  assert.equal(h.sent().length, 2);
});

test('ASS-412 AC2: a click selects the project — notify:open-ticket takes the project alone, and the dashboard switches to it; the texts go as argv, never a shell string', async () => {
  assert.equal(openCommand('/h/agent.sh', 'p'), `'/h/agent.sh' 'notify:open-ticket' 'p'`);
  assert.equal(openCommand('/h/agent.sh', 'p; rm -rf ~'), null);
  const dir = mkdtempSync(join(tmpdir(), 'warn-request-')), file = join(dir, 'open-ticket-request.json');
  execFileSync('/bin/sh', ['-c', openCommand(join(ROOT, 'agent.sh'), 'q')], { env: { ...process.env, OPEN_TICKET_REQUEST_FILE: file } });
  const request = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([request.project, 'key' in request], ['q', false]);
  const base = { ...two(), screen: 'c', day: '2026-09-30' };
  const next = openRequested(base, request);
  assert.deepEqual([next.project, next.day, next.screen, next.ticket ?? null], [1, null, 's', null]);
  // Without terminal-notifier, osascript: the texts its argv, never in the script.
  const h = harness({ path: false }), n = h.make();
  n.check(two());
  n.check(withProject(two(), 'p', { credentialsHold: { problems: [{ credential: 'c', problem: 'x', fix: `"; do shell script "touch /tmp/pwned` }] } }));
  await n.sent();
  const [[program, args]] = h.runs;
  assert.equal(program, 'osascript');
  assert.ok(args.slice(0, 6).every(a => !a.includes('pwned')));
  assert.deepEqual(args.slice(-3), ['Run "; do shell script "touch /tmp/pwned', 'Project blocked by credentials', 'Project p']);
});
