// memory:record-spend (ASS-269) — what a project's Hindsight spent on Claude,
// from its Prometheus /metrics: the hindsight_llm_tokens_* counters, totals
// since that Hindsight started. "Hindsight" here is an HTTP server on the
// project's port answering /metrics with a real sample of the harness
// project's (fixtures/hindsight-metrics.txt), then that sample moved on; the
// prices are the repo's data/harness.json's (AC1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures', 'hindsight-metrics.txt'), 'utf8');

// The sample with each `[series, by]` — a line's start, up to its value — counted on by `by`.
const counted = (text, changes) => text.split('\n').map(line => {
  const change = changes.find(([series]) => line.startsWith(series));
  if (!change) return line;
  const at = line.lastIndexOf(' ');
  return `${line.slice(0, at)} ${Number(line.slice(at + 1)) + change[1]}`;
}).join('\n');
const LABELS = 'model="claude-haiku-5-5",otel_scope_name="hindsight_api.metrics",otel_scope_schema_url="",otel_scope_version="",provider="anthropic"';
const series = (kind, scope, bucket) => `hindsight_llm_tokens_${kind}_tokens_total{${LABELS},scope="${scope}",success="true",token_bucket="${bucket}"}`;
const CPU = 'hindsight_process_cpu_seconds{otel_scope_name="hindsight_api.metrics",otel_scope_schema_url="",otel_scope_version="",type="user"}';
// Later in the same Hindsight: a consolidation (100000 in, 3000 out) and a retain (20000 in, 15000 of them cache reads).
const LATER = counted(SAMPLE, [
  [series('input', 'consolidation', '10k-50k'), 100000],
  [series('output', 'consolidation', '5k-10k'), 3000],
  [series('input', 'retain_extract_facts', '1k-5k'), 20000],
  [series('cached_input', 'retain_extract_facts', '1k-5k'), 15000],
  [CPU, 60],
]);
// A Hindsight restarted since: its counters begin again — one verification call (15 in, 4 out), as the sample's first.
const RESTARTED = [
  `${series('input', 'verification', '0-100')} 15.0`,
  `${series('output', 'verification', '0-100')} 4.0`,
  `${CPU} 3.2`,
].join('\n');

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// Project p, its Hindsight on a free port answering /metrics with `serve.metrics`; harness.json the repo's.
async function setup(t, { key = 'sk-ant-test-not-a-real-key' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'memory-spend-')));
  const port = await freePort();
  mkdirSync(join(dir, 'projects', 'p', 'hindsight'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', hindsight: { port, 'llm-api-key': key } }));
  copyFileSync(join(ROOT, 'data', 'harness.json'), join(dir, 'harness.json'));
  const serve = { metrics: SAMPLE };
  const server = await new Promise(resolve => { const s = createServer((req, res) => res.end(req.url === '/metrics' ? serve.metrics : '{}')).listen(port, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json') };
  const file = join(dir, 'projects', 'p', 'memory-spend.json');
  return {
    serve, file,
    pid: pid => writeFileSync(join(dir, 'projects', 'p', 'hindsight', 'hindsight.pid'), `${pid}\n`),
    record: async () => JSON.parse((await run(AGENT, ['memory:record-spend', 'p'], { env })).stdout),
    fails: () => run(AGENT, ['memory:record-spend', 'p'], { env }).then(() => assert.fail('memory:record-spend succeeded'), error => error),
    records: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).records : []),
  };
}

// The records' tokens and cost added up (one hour's collections are one record per model).
const totals = records => records.reduce((sum, r) => ({
  input: sum.input + r['input-tokens'], cacheRead: sum.cacheRead + r['cache-read-tokens'], output: sum.output + r['output-tokens'], cost: sum.cost + r['cost-usd'],
}), { input: 0, cacheRead: 0, output: 0, cost: 0 });
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

test('ASS-269 AC1: harness.json\'s model-prices has claude-haiku-5-5 at its published rates (USD per million tokens, prompts up to 100K)', () => {
  const prices = JSON.parse(readFileSync(join(ROOT, 'data', 'harness.json'), 'utf8'))['model-prices'];
  assert.deepEqual(prices['claude-haiku-5-5'], { input: 0.1, output: 0.5, 'cache-read': 0.01, 'cache-write': 0.125 });
});

test('ASS-269 AC2/AC5: the first read of a real /metrics sample is the baseline, recording nothing; what Hindsight spends after it is recorded as a dated api record, priced from model-prices — cache reads at their rate', async t => {
  const s = await setup(t);
  const first = await s.record();
  assert.deepEqual(first, { project: 'p', provider: 'anthropic', collection: { at: first.collection.at, baseline: true, restarted: false, recorded: [], unpriced: [] } });
  assert.deepEqual(s.records(), []);
  s.serve.metrics = LATER;
  const second = await s.record();
  const [record] = s.records();
  assert.equal(s.records().length, 1);
  assert.match(record.timestamp, STAMP);
  // 105000 at the input rate ($0.10), 15000 cache reads ($0.01), 3000 out ($0.50): $0.0105 + $0.00015 + $0.0015.
  assert.deepEqual(record, { timestamp: record.timestamp, billing: 'api', source: 'memory', model: 'claude-haiku-5-5', 'input-tokens': 105000, 'cache-read-tokens': 15000, 'output-tokens': 3000, 'cost-usd': 0.01215 });
  assert.deepEqual(second.collection.recorded, [record]);
  assert.equal(second.collection.baseline, false);
});

test('ASS-269 AC2/AC5: reading the same counters twice records nothing the second time', async t => {
  const s = await setup(t);
  await s.record();
  s.serve.metrics = LATER;
  await s.record();
  const once = s.records();
  const again = await s.record();
  assert.deepEqual(again.collection.recorded, []);
  assert.deepEqual(s.records(), once);
});

test('ASS-269 AC2: a restarted Hindsight — its counters lower again — is counted from zero, and what was recorded before stays', async t => {
  const s = await setup(t);
  await s.record();
  s.serve.metrics = LATER;
  await s.record();
  s.serve.metrics = RESTARTED;
  const after = await s.record();
  assert.equal(after.collection.restarted, true);
  const { cost, ...tokens } = totals(s.records());
  assert.deepEqual(tokens, { input: 105015, cacheRead: 15000, output: 3004 });
  assert.ok(Math.abs(cost - 0.0121535) < 1e-12, String(cost));   // + 15 × $0.10 + 4 × $0.50 a million
  assert.deepEqual((await s.record()).collection.recorded, []);   // and once only
});

test('ASS-269 AC2: a Hindsight memory:up restarted — a new pid in hindsight.pid — is counted from zero though its counters have passed the old ones', async t => {
  const s = await setup(t);
  s.pid(111);
  await s.record();
  s.pid(222);
  s.serve.metrics = LATER;   // every counter higher than the baseline's, but all of it the new Hindsight's
  const after = await s.record();
  assert.equal(after.collection.restarted, true);
  const sample = totals(s.records());
  assert.ok(sample.input > 1e7 && sample.output > 1e6, JSON.stringify(sample));
});

test('ASS-269 AC4: a project whose Hindsight runs with provider none — no llm-api-key — records nothing, whatever /metrics says', async t => {
  const s = await setup(t, { key: null });
  assert.deepEqual(await s.record(), { project: 'p', provider: 'none', collection: null });
  s.serve.metrics = LATER;
  await s.record();
  assert.equal(existsSync(s.file), false);
});

test('ASS-269 AC2: a model with no model-prices entry is recorded with its tokens, its cost null, and named unpriced', async t => {
  const s = await setup(t);
  await s.record();
  s.serve.metrics = `${SAMPLE}\n${series('output', 'reflect', '100-500').replace('claude-haiku-5-5', 'claude-future-9')} 200.0`;
  const out = await s.record();
  assert.deepEqual(out.collection.unpriced, ['claude-future-9']);
  assert.deepEqual(s.records().map(r => [r.model, r['output-tokens'], r['cost-usd']]), [['claude-future-9', 200, null]]);
});

test('ASS-269: a Hindsight that does not answer fails the read, writing nothing', async t => {
  const s = await setup(t);
  s.serve.metrics = null;
  const dir = JSON.parse(readFileSync(join(s.file, '..', 'project.json'), 'utf8'));
  writeFileSync(join(s.file, '..', 'project.json'), JSON.stringify({ ...dir, hindsight: { ...dir.hindsight, port: await freePort() } }));
  const error = await s.fails();
  assert.match(error.stderr, /memory:record-spend: p's Hindsight on 127\.0\.0\.1:\d+ did not answer \/metrics/);
  assert.equal(existsSync(s.file), false);
});
