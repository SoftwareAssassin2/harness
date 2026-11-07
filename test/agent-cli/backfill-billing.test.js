// project:backfill-billing (ASS-272 AC1): the re-runnable backfill of a
// project's agent dispatches that have a cost but no billing — in its sprints
// (their end-of-day snapshots too) and backlog — from the dispatch's
// payment-method, else the project's login (claude-usage.json's auth-method),
// a subscription's cost zeroed, an api one's kept; one neither says is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

const dispatch = (cost, extra = {}) => ({ 'dispatched-to': 'Thor', timestamp: '2026-10-27T10:00:00Z', 'completed-timestamp': '2026-10-27T10:30:00Z', 'cost-usd': cost, ...extra });
const ticket = (key, log) => ({ key, variations: [{ name: 'A', 'state-changes': [{ 'to-state': 'build', 'agent-dispatch-log': log }] }] });
const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, `${JSON.stringify(json, null, 4)}\n`); };
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const FILES = ['sprints/sprint-2/sprint.json', 'sprints/days/2026-10-27.json', 'backlog.json'];

// projects/p logged in by `authMethod` (none: no claude-usage.json): a sprint,
// a day's snapshot of it and the backlog, each with a costed dispatch of no
// payment-method, one paid api, one paid by subscription, one billing: null
// (a key written but unknown), one already billed, one never costed.
function fixture(authMethod) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-billing-'));
  const p = join(dir, 'p');
  const log = () => [dispatch(1.5), dispatch(2.25, { 'payment-method': 'api' }), dispatch(0.75, { 'payment-method': 'subscription' }),
    dispatch(1, { billing: null }), dispatch(0.5, { billing: 'api' }), dispatch(null)];
  write(join(p, 'sprints', 'sprint-2', 'sprint.json'), { number: 2, features: [ticket('A-1', log())], bugs: [], spikes: [] });
  write(join(p, 'sprints', 'days', '2026-10-27.json'), { number: 2, features: [ticket('A-1', log())], bugs: [], spikes: [] });
  write(join(p, 'backlog.json'), { tickets: [ticket('A-2', log()), { key: 'A-3' }] });
  if (authMethod) write(join(p, 'claude-usage.json'), { email: 'me@example.com', 'auth-method': authMethod, org: 'Org', 'as-of': '2026-10-29T12:27:16Z' });
  const backfill = (project = 'p') => run(AGENT, ['project:backfill-billing', project], { env: { ...process.env, PROJECTS_DIR: dir } });
  const logOf = file => { const json = read(join(p, file)); return (json.features?.[0] ?? json.tickets[0]).variations[0]['state-changes'][0]['agent-dispatch-log'].map(d => [d.billing, d['cost-usd']]); };
  const bytes = () => FILES.map(file => readFileSync(join(p, file), 'utf8'));
  return { p, backfill, logOf, bytes };
}

test('ASS-272 AC1: on a claude.ai (subscription) login, a costed dispatch with no billing takes its payment-method, else subscription, zeroed; a billed or never-costed one is left; a second run changes nothing', async () => {
  const f = fixture('claude.ai');
  const { stdout } = await f.backfill();
  for (const file of FILES) {
    assert.deepEqual(f.logOf(file), [['subscription', 0], ['api', 2.25], ['subscription', 0], ['subscription', 0], ['api', 0.5], [undefined, null]], file);
  }
  assert.match(stdout, /^sprints\/sprint-2\/sprint\.json: 3 dispatches billed subscription, \$3\.25 zeroed; 1 billed api, \$2\.25 kept$/m);
  assert.match(stdout, /^sprints\/days\/2026-10-27\.json: 3 dispatches billed subscription, \$3\.25 zeroed; 1 billed api, \$2\.25 kept$/m);
  assert.match(stdout, /^backlog\.json: 3 dispatches billed subscription, \$3\.25 zeroed; 1 billed api, \$2\.25 kept$/m);
  const before = f.bytes();
  assert.equal((await f.backfill()).stdout, 'p: nothing to backfill\n');
  assert.deepEqual(f.bytes(), before);
});

test('ASS-272 AC1: on an api_key login, a costed dispatch with no billing or payment-method is billed api, its cost kept; its payment-method still wins', async () => {
  const f = fixture('api_key');
  const { stdout } = await f.backfill();
  assert.deepEqual(f.logOf('backlog.json'), [['api', 1.5], ['api', 2.25], ['subscription', 0], ['api', 1], ['api', 0.5], [undefined, null]]);
  assert.match(stdout, /^backlog\.json: 1 dispatches billed subscription, \$0\.75 zeroed; 3 billed api, \$4\.75 kept$/m);
  assert.equal((await f.backfill()).stdout, 'p: nothing to backfill\n');
});

test('ASS-272 AC1: with no known login (no claude-usage.json), a dispatch with no payment-method is left without billing, and said so; a second run changes nothing', async () => {
  const f = fixture();
  const { stdout } = await f.backfill();
  assert.deepEqual(f.logOf('sprints/sprint-2/sprint.json'), [[undefined, 1.5], ['api', 2.25], ['subscription', 0], [null, 1], ['api', 0.5], [undefined, null]]);
  assert.match(stdout, /^sprints\/sprint-2\/sprint\.json: 1 dispatches billed subscription, \$0\.75 zeroed; 1 billed api, \$2\.25 kept$/m);
  assert.match(stdout, /^p: 6 dispatches with a cost left without billing: no payment-method and no known login$/m);
  const before = f.bytes();
  assert.equal((await f.backfill()).stdout, 'p: nothing to backfill\np: 6 dispatches with a cost left without billing: no payment-method and no known login\n');
  assert.deepEqual(f.bytes(), before);
});

test('ASS-272 AC1: project:backfill-billing fails, writing nothing, on an unknown project or one that climbs out of the projects folder', async () => {
  const f = fixture('claude.ai');
  const before = f.bytes();
  await assert.rejects(f.backfill('nope'), /invalid project/);
  await assert.rejects(f.backfill('../p'), /invalid project/);
  assert.deepEqual(f.bytes(), before);
});
