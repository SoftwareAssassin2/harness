// project:mark-billing (ASS-216 AC3): the one-time marking of what a project
// recorded before dispatches and chat turns said what they were billed to —
// every agent dispatch with no billing, in its sprints (their end-of-day
// snapshots too) and backlog, and each ticket chat's undated spend-usd total —
// as subscription, its cost zeroed, or, from <api-from> on, api, its cost kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const CUTOFF = '2026-10-28T12:33:02Z';

const dispatch = (timestamp, cost, extra = {}) => ({ 'dispatched-to': 'Thor', timestamp, 'completed-timestamp': timestamp, 'cost-usd': cost, ...extra });
const ticket = (key, log) => ({ key, variations: [{ name: 'A', 'state-changes': [{ 'to-state': 'build', 'agent-dispatch-log': log }] }] });
const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, `${JSON.stringify(json, null, 4)}\n`); };
const read = file => JSON.parse(readFileSync(file, 'utf8'));

// projects/p: a sprint, a day's snapshot of it and the backlog, each with
// dispatches either side of the cutoff — one already billed, one never costed
// — and three chats: one last written before the cutoff, one after, one
// recorded as turns already.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mark-billing-'));
  const p = join(dir, 'p');
  const log = () => [dispatch('2026-10-28T12:33:01Z', 1.5), dispatch(CUTOFF, 2.25), dispatch('2026-10-29T00:00:00Z', 0.5, { billing: 'subscription' }), dispatch('2026-10-27T00:00:00Z', null)];
  write(join(p, 'sprints', 'sprint-2', 'sprint.json'), { number: 2, features: [ticket('A-1', log())], bugs: [], spikes: [] });
  write(join(p, 'sprints', 'days', '2026-10-28.json'), { number: 2, features: [ticket('A-1', log())], bugs: [], spikes: [] });
  write(join(p, 'backlog.json'), { tickets: [ticket('A-2', log()), { key: 'A-3' }] });
  const chat = (key, spend, at) => {
    const file = join(p, 'work', key, 'collaboration.json');
    write(file, { 'session-id': 's', briefed: null, 'spend-usd': spend });
    utimesSync(file, new Date(at), new Date(at));
  };
  chat('A-1', 4.06, '2026-10-19T10:41:27Z');
  chat('A-2', 33.27, '2026-10-28T23:04:07Z');
  write(join(p, 'work', 'A-3', 'collaboration.json'), { 'session-id': 's', briefed: null, turns: [{ timestamp: '2026-10-29T10:00:00Z', billing: 'api', 'cost-usd': 1 }] });
  const mark = (...args) => run(AGENT, ['project:mark-billing', 'p', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
  return { p, mark };
}
const marked = file => read(file).features?.[0] ?? read(file).tickets[0];
const logOf = t => t.variations[0]['state-changes'][0]['agent-dispatch-log'].map(d => [d.billing, d['cost-usd']]);

test('ASS-216 AC3: with no api-from (harness, family, software-assassin), every unbilled dispatch and chat total is marked subscription and zeroed; a billed one is left as it is', async () => {
  const f = fixture();
  const { stdout } = await f.mark();
  for (const file of [join(f.p, 'sprints', 'sprint-2', 'sprint.json'), join(f.p, 'sprints', 'days', '2026-10-28.json'), join(f.p, 'backlog.json')]) {
    assert.deepEqual(logOf(marked(file)), [['subscription', 0], ['subscription', 0], ['subscription', 0.5], ['subscription', null]], file);
  }
  assert.deepEqual(read(join(f.p, 'work', 'A-1', 'collaboration.json')), { 'session-id': 's', briefed: null, turns: [{ timestamp: null, billing: 'subscription', 'cost-usd': 0 }] });
  assert.deepEqual(read(join(f.p, 'work', 'A-2', 'collaboration.json')).turns, [{ timestamp: null, billing: 'subscription', 'cost-usd': 0 }]);
  assert.match(stdout, /^sprints\/sprint-2\/sprint\.json: 3 dispatches marked subscription, \$3\.75 zeroed$/m);
  assert.match(stdout, /^backlog\.json: 3 dispatches marked subscription, \$3\.75 zeroed$/m);
  assert.match(stdout, /^work\/A-1\/collaboration\.json: chat spend marked subscription, \$4\.06 zeroed$/m);
  assert.doesNotMatch(stdout, /A-3/);
});

test('ASS-216 AC3: with api-from (example\'s 2026-10-28T12:33:02Z), what is timestamped before it is marked subscription and zeroed, from it on api and kept — a chat total by when its file was last written; a second run changes nothing', async () => {
  const f = fixture();
  const { stdout } = await f.mark(CUTOFF);
  const sprint = join(f.p, 'sprints', 'sprint-2', 'sprint.json');
  assert.deepEqual(logOf(marked(sprint)), [['subscription', 0], ['api', 2.25], ['subscription', 0.5], ['subscription', null]]);
  assert.deepEqual(read(join(f.p, 'work', 'A-1', 'collaboration.json')).turns, [{ timestamp: null, billing: 'subscription', 'cost-usd': 0 }]);
  assert.deepEqual(read(join(f.p, 'work', 'A-2', 'collaboration.json')).turns, [{ timestamp: null, billing: 'api', 'cost-usd': 33.27 }]);
  assert.match(stdout, /^sprints\/sprint-2\/sprint\.json: 2 dispatches marked subscription, \$1\.50 zeroed; 1 marked api, \$2\.25 kept$/m);
  assert.match(stdout, /^work\/A-2\/collaboration\.json: chat spend marked api, \$33\.27 kept$/m);
  const files = ['sprints/sprint-2/sprint.json', 'sprints/days/2026-10-28.json', 'backlog.json', 'work/A-1/collaboration.json', 'work/A-2/collaboration.json', 'work/A-3/collaboration.json'];
  const before = files.map(file => readFileSync(join(f.p, file), 'utf8'));
  const again = await f.mark(CUTOFF);
  assert.equal(again.stdout, 'p: nothing to mark\n');
  assert.deepEqual(files.map(file => readFileSync(join(f.p, file), 'utf8')), before);
});

test('ASS-216 AC3: project:mark-billing fails, writing nothing, on an unknown project or an api-from that is not a UTC time to the second', async () => {
  const f = fixture();
  const before = readFileSync(join(f.p, 'backlog.json'), 'utf8');
  await assert.rejects(f.mark('2026-10-28'), /api-from/);
  await assert.rejects(run(AGENT, ['project:mark-billing', '../p'], { env: { ...process.env, PROJECTS_DIR: join(f.p, '..') } }), /invalid project/);
  assert.equal(readFileSync(join(f.p, 'backlog.json'), 'utf8'), before);
});
