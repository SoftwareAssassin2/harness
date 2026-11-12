// ASS-383: macOS notifications when a ticket becomes Operator Needed —
// detection per project (entry, exit, re-entry, start-up silence, the seen
// file), the per-project switch, the AI description and its fallback, both
// notifiers and the click's request, all with stubbed programs on PATH:
// terminal-notifier, osascript and claude never run for real here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState } from '../../src/tui/app.js';
import { openRequested } from '../../src/tui/app.js';
import { loadProjects, loadWorkflows } from '../../src/tui/load.js';
import { operatorNeeded } from '../../src/tui/screens/shared.js';
import { neededTickets, entered, readSeen } from '../../src/notify/detect.js';
import { describe, fallback, promptOf, askClaude, MODEL } from '../../src/notify/describe.js';
import { operatorNeededNotifier, notification, openCommand, GHOSTTY, loginEnvs, SPEND_ID } from '../../src/notify/notifier.js';

const ROOT = join(import.meta.dirname, '..', '..');
const steps = [
  { id: 'stuck', name: 'Blocked for Human', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'review', name: 'Human Review', sequence: 8, action: { type: 'human', instructions: 'Review the variation and approve or reject it.' },
    'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'done' }, { condition: { 'human-review': 'Rejected' }, 'move-to-state': 'build' }] },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const ticket = (key, state, extra = {}) => ({ key, title: `Title of ${key}`, variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra }] });
const project = (id, features, { questions = [], notifications = true } = {}) => ({ id, name: `Project ${id}`, stateEngine: 'e', sprint: { number: 1, features, bugs: [], spikes: [] }, backlog: [], questions, days: {}, notifications });
const stateOf = projects => initialState({ projects, workflows: [{ name: 'e', steps }] });
const asked = (key, question) => ({ 'asked-on-ticket': key.toLowerCase(), status: 'Asked', blocking: true, question });

// The notifier with its programs faked: ask answers as `answer` says, run records [file, args].
function harness({ answer = () => ({ ok: true, text: 'Approve or reject the variation.', usd: 0.002, billing: 'api', priced: true }), env = { PATH: '' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const runs = [], asks = [], logs = [];
  const make = () => operatorNeededNotifier({
    seenFile: join(dir, 'operator-needed-seen.json'), projectsDir: join(dir, 'projects'), agentSh: '/h/agent.sh', env,
    ask: async opts => { asks.push(opts); return answer(opts); },
    run: (file, args, _opts, done) => { runs.push([file, args]); done(null); },
    log: text => logs.push(text),
  });
  return { dir, runs, asks, logs, make, notified: () => runs.filter(([file]) => file !== '/h/agent.sh') };
}

test('ASS-383 AC1: tickets already Operator Needed at start do not notify; one entering notifies once; leaving and coming back notifies again', async () => {
  const h = harness(), n = h.make();
  const start = stateOf([project('p', [ticket('A-1', 'stuck'), ticket('A-2', 'build')])]);
  assert.deepEqual(n.check(start), []);                                                 // A-1 is already waiting: start-up silence
  assert.match(h.logs[0], /osascript/);                                                  // which notifier, logged once at start
  const entering = stateOf([project('p', [ticket('A-1', 'stuck'), ticket('A-2', 'review')])]);
  assert.deepEqual(n.check(entering).map(e => e.ticket.key), ['A-2']);
  assert.deepEqual(n.check(entering), []);                                               // still in the set: no second notification
  assert.deepEqual(n.check(stateOf([project('p', [ticket('A-1', 'stuck'), ticket('A-2', 'build')])])), []);   // left
  assert.deepEqual(n.check(entering).map(e => e.ticket.key), ['A-2']);                   // back again
  await n.sent();
  assert.equal(h.notified().length, 2);
  assert.equal(h.logs.length, 1);
});

test('ASS-383 AC1: each ticket entering gets its own notification, in every project, computed on the live sprint whatever the project or day on show', async () => {
  const h = harness(), n = h.make();
  n.check({ ...stateOf([project('p', [ticket('A-1', 'build')]), project('q', [ticket('B-1', 'build')])]), project: 1, day: '2026-01-01' });
  const later = { ...stateOf([project('p', [ticket('A-1', 'stuck'), ticket('A-3', 'review')]), project('q', [ticket('B-1', 'build')], { questions: [asked('B-1', 'Which database?')] })]), project: 1, day: '2026-01-01' };
  later.projects.forEach(p => { p.days = { '2026-01-01': { number: 1, features: [], bugs: [], spikes: [] } }; });
  assert.deepEqual(n.check(later).map(e => `${e.project}/${e.ticket.key}`).sort(), ['p/A-1', 'p/A-3', 'q/B-1']);
  await n.sent();
  const groups = h.notified().map(([, args]) => args[args.indexOf('display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name "default"') + 4]);
  assert.deepEqual(groups.sort(), ['A-1 needs you', 'A-3 needs you', 'B-1 needs you']);
});

test('ASS-383 AC1: the seen set is kept in a file under data/, so a restarted dashboard does not notify again', async () => {
  const h = harness();
  const first = h.make();
  first.check(stateOf([project('p', [ticket('A-1', 'build')])]));
  first.check(stateOf([project('p', [ticket('A-1', 'stuck')])]));
  await first.sent();
  assert.deepEqual(readSeen(join(h.dir, 'operator-needed-seen.json')), { p: ['A-1'] });
  const again = h.make();                                                                 // restarted
  assert.deepEqual(again.check(stateOf([project('p', [ticket('A-1', 'stuck')])])), []);
  assert.deepEqual(again.check(stateOf([project('p', [ticket('A-1', 'stuck')])])), []);
  await again.sent();
  assert.equal(h.notified().length, 1);
});

test('ASS-383 AC1: entered — a pure diff of the seen keys against the sets now', () => {
  const now = { p: [{ key: 'A-1' }, { key: 'A-2' }], q: [] };
  assert.deepEqual(entered({ p: ['A-1'], q: ['B-1'] }, now), { seen: { p: ['A-1', 'A-2'], q: [] }, entered: [{ project: 'p', ticket: { key: 'A-2' } }] });
});

test('ASS-383 AC2: project.json operator-needed-notifications false turns them off for that project alone; absent, they are on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-load-'));
  for (const [id, json] of [['on', {}], ['off', { 'operator-needed-notifications': false }], ['yes', { 'operator-needed-notifications': true }]]) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'project.json'), JSON.stringify({ name: id, ...json }));
  }
  assert.deepEqual(loadProjects(dir, dir).map(p => [p.id, p.notifications]), [['off', false], ['on', true], ['yes', true]]);
  const h = harness(), n = h.make();
  n.check(stateOf([project('p', [ticket('A-1', 'build')]), project('q', [ticket('B-1', 'build')], { notifications: false })]));
  const both = stateOf([project('p', [ticket('A-1', 'stuck')]), project('q', [ticket('B-1', 'stuck')], { notifications: false })]);
  assert.deepEqual(n.check(both).map(e => e.ticket.key), ['A-1']);
  await n.sent();
  assert.equal(h.notified().length, 1);
  assert.equal(h.asks.length, 1);                                                         // no description asked for the switched-off project
});

test('ASS-383 AC3: the model gets only the key, title, step and reason; the description is the model\'s line, its cost recorded under the project', async () => {
  const h = harness(), n = h.make();
  const secret = { description: 'SECRET DESCRIPTION', 'agent-dispatch-log': 'SECRET LOG' };
  n.check(stateOf([project('p', [{ ...ticket('A-1', 'build'), ...secret }])]));
  n.check(stateOf([project('p', [{ ...ticket('A-1', 'stuck', { 'ai-feedback-short': 'VM will not start', 'ai-feedback-long': 'The golden image is missing.' }), ...secret }], { questions: [asked('A-1', 'Which region?')] })]));
  await n.sent();
  const { prompt } = h.asks[0];
  assert.match(prompt, /Ticket: A-1 — Title of A-1/);
  assert.match(prompt, /Waiting at step: Blocked for Human/);
  assert.match(prompt, /AI feedback \(short\): VM will not start/);
  assert.match(prompt, /AI feedback \(long\): The golden image is missing\./);
  assert.match(prompt, /Blocking question: Which region\?/);
  assert.match(prompt, /at most 15 words/);
  assert.doesNotMatch(prompt, /SECRET/);
  const [[, args]] = h.notified();
  assert.equal(args.at(-3), 'Approve or reject the variation.');
  assert.deepEqual(h.runs.find(([file]) => file === '/h/agent.sh'), ['/h/agent.sh', ['chat:add-spend', 'p', SPEND_ID, '0.002', 'api']]);
});

test('ASS-383 AC3: a gate\'s reason is its needs, its instructions and its choices; a requirements change\'s, the new description', () => {
  const [gate] = neededTickets(stateOf([project('p', [ticket('A-1', 'review')])])).p;
  assert.deepEqual(gate, { key: 'A-1', title: 'Title of A-1', variation: 'A', step: 'Human Review',
    reason: { gate: 'Human Review', choices: ['Approved', 'Rejected'], instructions: 'Review the variation and approve or reject it.' } });
  assert.equal(fallback(gate), 'Human Review: Approved or Rejected');
  const [change] = neededTickets(stateOf([project('p', [{ ...ticket('A-1', 'build'), 'pending-requirements-change': { description: 'New text' } }])])).p;
  assert.equal(change.reason.change, 'New text');
  assert.match(promptOf(change), /Pending requirements change, new description: New text/);
});

test('ASS-383 AC3: when the model fails or times out, the plain fallback from the same reason goes out instead', async () => {
  const h = harness({ answer: () => ({ ok: false, text: '', usd: 0, billing: null, priced: false }) }), n = h.make();
  n.check(stateOf([project('p', [ticket('A-1', 'build')])]));
  n.check(stateOf([project('p', [ticket('A-1', 'stuck', { 'ai-feedback-short': 'Needs a new token' })])]));
  await n.sent();
  const [[, args]] = h.notified();
  assert.equal(args.at(-3), 'Blocked for Human: Needs a new token');
  assert.equal(h.runs.filter(([file]) => file === '/h/agent.sh').length, 0);             // nothing priced, nothing recorded
  assert.equal(fallback({ step: 'Build', reason: { questions: ['Which region?\nmore'] } }), 'Open question: Which region?');
  // The 20 seconds are shared by the subscription and the API key: none is asked once they are spent.
  let clock = 0;
  const asks = [];
  const text = await describe({ key: 'A-1', step: 'S', reason: { blocked: true } }, { envs: [{}, {}], timeoutMs: 20_000, now: () => clock,
    ask: async ({ timeoutMs }) => { asks.push(timeoutMs); clock += 20_000; return { ok: false, priced: false }; } });
  assert.deepEqual([text, asks], ['Blocked for Human', [20_000]]);
});

// A stub program on PATH: a script recording its argv (and stdin) as a JSON line in `log`, then running `body`.
function stub(bin, name, log, body = '') {
  writeFileSync(join(bin, name), `#!${process.execPath}
const fs = require('fs');
let input = ''; if (${JSON.stringify(name)} === 'claude') { try { input = fs.readFileSync(0, 'utf8'); } catch {} }   // the notifiers' stdin is never closed
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2), input, config: process.env.CLAUDE_CONFIG_DIR ?? null }) + '\\n');
${body}`);
  chmodSync(join(bin, name), 0o755);
}
const lines = log => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);

test('ASS-383 AC3: askClaude runs claude -p on the haiku model, no tools, the prompt on stdin, and reads the result, its cost and billing (stubbed claude)', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'claude-bin-')), log = join(bin, 'log');
  stub(bin, 'claude', log, `
console.log(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }));
console.log(JSON.stringify({ type: 'result', result: '"Approve the variation; its review is done."\\n', total_cost_usd: 0.0031, is_error: false }));`);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  const got = await askClaude({ prompt: 'the prompt $(touch nope)', env });
  assert.deepEqual(got, { ok: true, text: 'Approve the variation; its review is done.', usd: 0.0031, billing: 'api', priced: true });
  const [call] = lines(log);
  assert.deepEqual(call.argv, ['-p', '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--no-session-persistence']);
  assert.equal(MODEL, 'claude-haiku-5-5');
  assert.equal(call.input, 'the prompt $(touch nope)');
  // On a subscription its cost is 0, as process.js billed has it.
  stub(bin, 'claude', log, `
console.log(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }));
console.log(JSON.stringify({ type: 'result', result: 'Answer it.', total_cost_usd: 0.01, is_error: false }));`);
  assert.deepEqual(await askClaude({ prompt: 'p', env }), { ok: true, text: 'Answer it.', usd: 0, billing: 'subscription', priced: true });
});

test('ASS-383 AC3: a claude that hangs is killed at the timeout, and one that fails is no answer', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'claude-bin-')), log = join(bin, 'log');
  stub(bin, 'claude', log, 'setTimeout(() => {}, 60000);');
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  const at = Date.now();
  assert.deepEqual(await askClaude({ prompt: 'p', env, timeoutMs: 300 }), { ok: false, text: '', usd: 0, billing: null, priced: false });
  assert.ok(Date.now() - at < 5000);
  stub(bin, 'claude', log, 'process.exit(1);');
  assert.equal((await askClaude({ prompt: 'p', env })).ok, false);
  assert.equal((await askClaude({ prompt: 'p', env: { ...env, PATH: '/nonexistent' } })).ok, false);
});

test('ASS-383 AC3: the description is asked on the project\'s subscription login first, then its API key\'s while no API cap holds it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logins-'));
  const env = { PATH: '/bin' };
  mkdirSync(join(dir, 'p'));
  assert.deepEqual(loginEnvs(dir, { id: 'p' }, env), [env]);                              // no folder of its own: the shared ~/.claude
  mkdirSync(join(dir, 'p', '.claude'));
  mkdirSync(join(dir, 'p', '.claude-api'));
  assert.deepEqual(loginEnvs(dir, { id: 'p' }, env).map(e => e.CLAUDE_CONFIG_DIR), [join(dir, 'p', '.claude'), join(dir, 'p', '.claude-api')]);
  assert.deepEqual(loginEnvs(dir, { id: 'p', apiCapHold: { cap: 'day' } }, env).map(e => e.CLAUDE_CONFIG_DIR), [join(dir, 'p', '.claude')]);
});

const hostile = 'Fix "quotes" $(touch PWNED) `id`; rm -rf ~ \'x\'';

test('ASS-383 AC4, AC7: with terminal-notifier on PATH it is used — title, subtitle, body, default sound, grouped per ticket, the terminal activated and a fixed command run on click — ticket text passed as argv alone', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'tn-bin-')), log = join(bin, 'log');
  stub(bin, 'terminal-notifier', log);
  const dir = mkdtempSync(join(tmpdir(), 'tn-'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, TERM_PROGRAM: 'Apple_Terminal' };   // whatever it says, Ghostty is the one brought forward
  const logs = [];
  const n = operatorNeededNotifier({ seenFile: join(dir, 'seen.json'), projectsDir: join(dir, 'projects'), agentSh: join(ROOT, 'agent.sh'), env, log: t => logs.push(t),
    ask: async () => ({ ok: true, text: hostile, usd: 0, billing: 'subscription', priced: false }) });
  assert.equal(n.kind, 'terminal-notifier');
  const titled = t => ({ ...t, title: hostile });
  n.check(stateOf([project('p', [titled(ticket('A-1', 'build'))])]));
  n.check(stateOf([project('p', [titled(ticket('A-1', 'stuck'))])]));
  await n.sent();
  assert.match(logs[0], /terminal-notifier/);
  const [call] = lines(log);
  assert.deepEqual(call.argv, ['-title', 'A-1 needs you', '-subtitle', `Project p — ${hostile}`, '-message', hostile, '-sound', 'default', '-group', 'p/A-1',
    '-activate', 'com.mitchellh.ghostty', '-execute', `'${join(ROOT, 'agent.sh')}' 'notify:open-ticket' 'p' 'A-1'`]);
  assert.equal(existsSync(join(dir, 'PWNED')) || existsSync('PWNED'), false);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /com\.apple\.Terminal/);
});

test('ASS-383 AC4, AC7: without terminal-notifier it falls back to osascript, the texts as the script\'s argv, never in the AppleScript', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'osa-bin-')), log = join(bin, 'log');
  stub(bin, 'osascript', log);
  const dir = mkdtempSync(join(tmpdir(), 'osa-'));
  const n = operatorNeededNotifier({ seenFile: join(dir, 'seen.json'), projectsDir: join(dir, 'projects'), agentSh: join(ROOT, 'agent.sh'), env: { PATH: `${bin}:/usr/bin:/bin` },
    ask: async () => ({ ok: false, priced: false }) });
  assert.equal(n.kind, 'osascript');
  n.check(stateOf([project('p', [{ ...ticket('A-1', 'build'), title: hostile }])]));
  n.check(stateOf([project('p', [{ ...ticket('A-1', 'stuck', { 'ai-feedback-short': hostile }), title: hostile }])]));
  await n.sent();
  const [call] = lines(log);
  assert.deepEqual(call.argv, ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name "default"', '-e', 'end run',
    `Blocked for Human: ${hostile}`, 'A-1 needs you', `Project p — ${hostile}`]);
});

test('ASS-383 AC4: a click brings Ghostty to the front, whatever TERM_PROGRAM says — never Terminal.app; no text can pass as an option', () => {
  assert.equal(GHOSTTY, 'com.mitchellh.ghostty');
  const [, args] = notification('terminal-notifier', { title: '-t', subtitle: '--s', message: '-rm', group: 'p/A-1', activate: GHOSTTY });
  assert.deepEqual(args.slice(0, 6), ['-title', 't', '-subtitle', 's', '-message', 'rm']);
  assert.deepEqual(args.slice(args.indexOf('-activate'), args.indexOf('-activate') + 2), ['-activate', 'com.mitchellh.ghostty']);
});

test('ASS-383 AC5, AC7: the click command is fixed — only a plain project id and key go in it, quoted —, and it writes the request the dashboard opens', async () => {
  assert.equal(openCommand('/h/agent.sh', 'p', 'A-1; rm -rf ~'), null);
  assert.equal(openCommand('/h/agent.sh', 'p q', 'A-1'), null);
  assert.equal(openCommand("/it's here/agent.sh", 'p', 'A-1'), `'/it'\\''s here/agent.sh' 'notify:open-ticket' 'p' 'A-1'`);
  const dir = mkdtempSync(join(tmpdir(), 'request-'));
  const file = join(dir, 'open-ticket-request.json');
  const env = { ...process.env, OPEN_TICKET_REQUEST_FILE: file };
  execFileSync('/bin/sh', ['-c', openCommand(join(ROOT, 'agent.sh'), 'p', 'A-2')], { env });   // as terminal-notifier's -execute runs it
  const request = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([request.project, request.key], ['p', 'A-2']);
  for (const args of [['p', 'A-1 x'], ['../p', 'A-1'], ['p']]) {
    await assert.rejects(new Promise((done, fail) => execFile(join(ROOT, 'agent.sh'), ['notify:open-ticket', ...args], { env: { ...env, OPEN_TICKET_REQUEST_FILE: join(dir, 'bad.json') } }, e => (e ? fail(e) : done()))));
  }
  assert.equal(existsSync(join(dir, 'bad.json')), false);
});

test('ASS-383 AC5: a request switches the dashboard to that project, on its live sprint, with the ticket\'s screen open on the waiting variation', () => {
  const base = { ...stateOf([project('p', [ticket('A-1', 'build')]), project('q', [ticket('B-1', 'build'), { key: 'B-2', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }, { name: 'B', 'harness-status': { state: 'review', 'state-engine': 'e' } }] }])]), menuOpen: true, day: '2026-01-01', screen: 'c' };
  const next = openRequested(base, { project: 'q', key: 'B-2' });
  assert.deepEqual([next.project, next.day, next.screen, next.menuOpen, next.ticket], [1, null, 's', false, { key: 'B-2', variation: 'B' }]);
  assert.equal(openRequested(base, { project: 'nope', key: 'B-2' }), base);
  const unknown = openRequested(base, { project: 'q', key: 'B-9' });
  assert.deepEqual([unknown.project, unknown.ticket], [1, null]);
});

test('ASS-383 AC4: terminal-notifier exiting non-zero (no permission) is logged once, and each such notification goes out through osascript', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'tn-fail-')), log = join(bin, 'log');
  stub(bin, 'terminal-notifier', log, 'console.error("Could not request notification permission: denied"); process.exit(3);');
  stub(bin, 'osascript', log);
  const dir = mkdtempSync(join(tmpdir(), 'tn-fail-'));
  const logs = [];
  const n = operatorNeededNotifier({ seenFile: join(dir, 'seen.json'), projectsDir: join(dir, 'projects'), agentSh: join(ROOT, 'agent.sh'), env: { PATH: `${bin}:/usr/bin:/bin` }, log: t => logs.push(t),
    ask: async () => ({ ok: true, text: 'Do it.', usd: 0, billing: 'subscription', priced: false }) });
  n.check(stateOf([project('p', [ticket('A-1', 'build'), ticket('A-2', 'build')])]));
  n.check(stateOf([project('p', [ticket('A-1', 'stuck'), ticket('A-2', 'stuck')])]));
  await n.sent();
  assert.deepEqual(lines(log).map(l => l.name).sort(), ['osascript', 'osascript', 'terminal-notifier', 'terminal-notifier']);
  assert.equal(logs.filter(t => /terminal-notifier failed/.test(t)).length, 1);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /com\.apple\.Terminal/);
  assert.ok(lines(log).filter(l => l.name === 'osascript').every(l => !l.argv.includes('-execute')));   // the fallback has no click action
});

test('ASS-391 AC3: a ticket waiting at Blocked\'s Await Rate Limit — its Health "Waiting for the rate limit to reset at …" — is not Operator Needed and notifies nothing; at Blocked for Human it would', async () => {
  const workflows = loadWorkflows(join(ROOT, 'engines'));
  const top = 'harness-development-grouped';
  const waiting = { key: 'A-1', title: 'Rate limited', variations: [{ name: 'A',
    'harness-status': { state: 'blocked', 'state-engine': top, 'sub-status': { state: 'await-rate-limit', 'state-engine': 'grouped-blocked' } },
    'ai-feedback-short': 'Waiting for the rate limit to reset at 2026-11-12 14:00 UTC (no API fallback)', 'ai-feedback-long': 'A-1 was blocked by a Claude rate limit …',
    'state-changes': [{ 'state-engine': top, 'from-state': 'build', 'to-state': 'blocked', timestamp: '2026-11-12T09:00:00Z' },
      { 'state-engine': top, 'from-state': 'blocked', 'to-state': 'blocked', timestamp: '2026-11-12T09:05:00Z', 'sub-state-change': { 'state-engine': 'grouped-blocked', 'from-state': 'classify', 'to-state': 'await-rate-limit' } }] }] };
  const handed = { key: 'A-2', title: 'Stuck', variations: [{ name: 'A', 'harness-status': { state: 'blocked-for-human', 'state-engine': top }, 'ai-feedback-short': 'Needs you' }] };
  const stateWith = features => initialState({ projects: [{ ...project('p', features), stateEngine: top }], workflows });
  assert.deepEqual([...operatorNeeded(stateWith([waiting, handed]))], ['A-2'], 'only Blocked for Human needs the operator');
  assert.deepEqual(neededTickets(stateWith([waiting])), { p: [] });
  const h = harness(), n = h.make();
  n.check(stateWith([{ ...waiting, variations: [{ ...waiting.variations[0], 'harness-status': { state: 'build', 'state-engine': top }, 'ai-feedback-short': null }] }]));
  assert.deepEqual(n.check(stateWith([waiting])), [], 'entering the wait notifies nothing');
  await n.sent();
  assert.equal(h.notified().length, 0);
});
