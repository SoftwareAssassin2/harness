// harness:set-api-cost — the Anthropic API organization's month-to-date spend
// (ASS-153), as control reads it, recorded in data/api-cost.json (live data;
// API_COST_FILE overrides it) for the dashboard's models box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAMP } from './harness-fixture.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const costFile = () => join(mkdtempSync(join(tmpdir(), 'ac-')), 'api-cost.json');
const cli = (file, ...args) => run(AGENT, ['harness:set-api-cost', ...args], { env: { ...process.env, API_COST_FILE: file } });
const cost = file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

test('harness:set-api-cost writes { month, usd, as-of } to the api-cost file, a plain overwrite', async () => {
  const file = costFile();
  await cli(file, '2026-10', '12.34');
  assert.match(cost(file)['as-of'], STAMP);
  assert.deepEqual({ ...cost(file), 'as-of': 'now' }, { month: '2026-10', usd: 12.34, 'as-of': 'now' });
  await cli(file, '2026-11', '0');
  assert.deepEqual({ ...cost(file), 'as-of': 'now' }, { month: '2026-11', usd: 0, 'as-of': 'now' });
});

test('harness:set-api-cost fails, writing nothing, on a month not YYYY-MM or an amount not a number of dollars', async () => {
  const file = costFile();
  for (const args of [['2026-1', '1'], ['October', '1'], ['2026-10', '-1'], ['2026-10', 'ten'], ['2026-10', ''], ['2026-10'], []]) {
    await assert.rejects(cli(file, ...args), undefined, args.join(' '));
    assert.equal(cost(file), undefined, args.join(' '));
  }
});
