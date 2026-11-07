// ASS-269: what each project's Hindsight spends on Claude, read by control
// every few minutes (memory:record-spend, tested in
// test/agent-cli/memory-spend.test.js) into the project's memory-spend.json,
// and counted against the project's API day and sprint caps — never a
// ticket's spending limit. agent.sh is a recorder for the reads; the caps run
// on the real agent-cli; "Hindsight" is an HTTP server on the project's port,
// or nothing.
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { controlFixture } from './control-fixture.js';
import { recordMemorySpend } from '../../src/control/memory-spend.js';
import { superviseAgents } from '../../src/control/supervise.js';
import { loadMemorySpend } from '../../src/control/state.js';
import { spendRecords, apiCapReached, overSpent, ticketSpend } from '../../src/control/spend.js';

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const projectFile = f => join(f.dir, 'projects', 'p', 'project.json');
const collection = (more = {}) => JSON.stringify({ project: 'p', provider: 'anthropic', collection: { at: '2026-10-30T12:00:00Z', baseline: false, restarted: false, recorded: [], unpriced: [], ...more } });

// p with a Hindsight on a free port (answering once up()); reads recorded, each answered by answer(args).
async function memory(t, { answer = () => collection() } = {}) {
  const f = controlFixture();
  const port = await freePort();
  edit(projectFile(f), p => { p.hindsight = { port, 'llm-api-key': null }; });
  let now = Date.parse('2026-10-30T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); const out = answer(args); if (out instanceof Error) throw out; return out ?? ''; };
  let server = null;
  t.after(() => server?.close());
  return {
    f, calls,
    later: ms => { now += ms; },
    pass: async () => { recordMemorySpend(f.ctx, f.ctx.load()); await Promise.all([...(f.ctx.memory.memorySpend?.values() ?? [])]); },
    up: () => new Promise(resolve => { server = createServer((req, res) => res.end('{}')).listen(port, '127.0.0.1', resolve); }),
  };
}
const reads = m => m.calls.filter(c => c === 'memory:record-spend p').length;

test('ASS-269 AC2: control reads each answering Hindsight\'s spend at once, then every five minutes — not between', async t => {
  const m = await memory(t);
  await m.up();
  await m.pass();
  assert.equal(reads(m), 1);
  m.later(4 * 60e3); await m.pass();
  assert.equal(reads(m), 1);
  m.later(60e3); await m.pass();
  assert.equal(reads(m), 2);
});

test('ASS-269: a Hindsight not answering is not read (memory.js starts it), nor logged', async t => {
  const m = await memory(t);
  await m.pass();
  assert.equal(reads(m), 0);
  assert.deepEqual(m.f.lines, []);
});

test('ASS-269: the baseline, a restart and an unpriced model are logged; a failed read is logged as an error', async t => {
  let answer = collection({ baseline: true });
  const m = await memory(t, { answer: () => answer });
  await m.up();
  await m.pass();
  answer = collection({ restarted: true, unpriced: ['claude-future-9'] });
  m.later(5 * 60e3); await m.pass();
  answer = new Error('memory:record-spend: p\'s Hindsight on 127.0.0.1:1 did not answer /metrics');
  m.later(5 * 60e3); await m.pass();
  assert.deepEqual(m.f.lines, [
    'memory p: counting its Hindsight\'s Claude spend from now (memory:record-spend\'s first read)',
    'memory p: its Hindsight restarted since last read; its Claude spend counted again from zero',
    'memory p: no model-prices in harness.json for claude-future-9; its Hindsight spend is recorded without a cost',
    'error memory p: its Hindsight\'s Claude spend could not be read, tried again in 5m: memory:record-spend: p\'s Hindsight on 127.0.0.1:1 did not answer /metrics',
  ]);
});

const memoryRecord = (timestamp, cost) => ({ timestamp, billing: 'api', source: 'memory', model: 'claude-haiku-5-5', 'input-tokens': 1, 'cache-read-tokens': 0, 'output-tokens': 1, 'cost-usd': cost });

test('ASS-269 AC3/AC5: memory spend counts toward the API day and sprint caps', () => {
  const memorySpend = [memoryRecord('2026-10-29T15:00:00Z', 3), memoryRecord('2026-10-27T15:00:00Z', 2)];
  const dispatch = { timestamp: '2026-10-29T16:00:00Z', billing: 'api', 'cost-usd': 1 };
  const tickets = [{ key: 'A-1', variations: [{ name: 'A', 'state-changes': [{ 'agent-dispatch-log': [dispatch] }] }] }];
  const records = spendRecords(tickets, {}, null, memorySpend);
  const at = new Date('2026-10-29T18:00:00Z');
  assert.deepEqual(apiCapReached(records, { 'max-api-spend-per-day-usd': 4 }, null, at), { cap: 'day', spend: 4, limit: 4 });
  assert.deepEqual(apiCapReached(records, { 'max-api-spend-per-sprint-usd': 6 }, { start: '2026-10-26' }, at), { cap: 'sprint', spend: 6, limit: 6 });
  assert.equal(apiCapReached(spendRecords(tickets, {}), { 'max-api-spend-per-day-usd': 4 }, null, at), null);   // without memory, under
  // AC3: never a ticket's: its spend is its dispatches alone.
  assert.equal(ticketSpend(tickets[0]), 1);
  assert.equal(overSpent({ ...tickets[0], 'max-spend-usd': 2 }, {}, {}), null);
});

test('ASS-269 AC3: control holds a project\'s API key once its Hindsight\'s spend today reaches its day cap (project.json api-cap-hold)', async () => {
  const f = controlFixture();
  const today = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(f.dir, 'projects', 'p', 'memory-spend.json'), JSON.stringify({ records: [memoryRecord(today, 5)] }));
  edit(projectFile(f), p => { p['max-api-spend-per-day-usd'] = 5; });
  assert.deepEqual(loadMemorySpend(join(f.dir, 'projects', 'p')), [memoryRecord(today, 5)]);
  await superviseAgents(f.ctx, f.ctx.load());
  const hold = JSON.parse(readFileSync(projectFile(f), 'utf8'))['api-cap-hold'];
  assert.deepEqual(hold, { since: hold?.since, cap: 'day', 'spend-usd': 5, 'limit-usd': 5 }, f.lines.join('\n'));
});

test('ASS-269: a project with no memory-spend.json, or an unreadable one, has no memory spend', () => {
  const f = controlFixture();
  assert.deepEqual(loadMemorySpend(join(f.dir, 'projects', 'p')), []);
  writeFileSync(join(f.dir, 'projects', 'p', 'memory-spend.json'), '{ half');
  assert.deepEqual(loadMemorySpend(join(f.dir, 'projects', 'p')), []);
});
