// harness:set-context-window — the learned context-window cache (ASS-190),
// data/context-windows.json ({ <model>: tokens }), written through a locked
// agent.sh command when a result event's modelUsage carries a contextWindow.
// Modeled on api-cost.test.js, but it MERGES rather than overwrites.
// CONTEXT_WINDOWS_FILE overrides the real data folder, as API_COST_FILE does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const winFile = () => join(mkdtempSync(join(tmpdir(), 'cw-')), 'context-windows.json');
const cli = (file, ...args) => run(AGENT, ['harness:set-context-window', ...args], { env: { ...process.env, CONTEXT_WINDOWS_FILE: file } });
const windows = file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

test('harness:set-context-window writes { <model>: <tokens> } as a number, creating the file', async () => {
  const file = winFile();
  await cli(file, 'claude-opus-5', '200000');
  assert.deepEqual(windows(file), { 'claude-opus-5': 200000 });
  assert.equal(typeof windows(file)['claude-opus-5'], 'number');
});

test('harness:set-context-window merges, not overwrites: a second model adds, a re-call updates that model and leaves the other alone', async () => {
  const file = winFile();
  await cli(file, 'claude-opus-5', '200000');
  await cli(file, 'claude-sonnet-5', '1000000');
  assert.deepEqual(windows(file), { 'claude-opus-5': 200000, 'claude-sonnet-5': 1000000 });
  await cli(file, 'claude-opus-5', '250000');
  assert.deepEqual(windows(file), { 'claude-opus-5': 250000, 'claude-sonnet-5': 1000000 });
});

test('harness:set-context-window fails, writing nothing, on an empty model, a non-integer or negative token count, or missing arguments', async () => {
  const file = winFile();
  await cli(file, 'seed', '5');                                                    // a prior value, to prove it is untouched
  for (const args of [['', '100'], ['m', '1.5'], ['m', 'abc'], ['m', '-1'], ['m'], []]) {
    await assert.rejects(cli(file, ...args), undefined, args.join(' '));
    assert.deepEqual(windows(file), { seed: 5 }, args.join(' '));                  // byte-identical to before
  }
  const fresh = winFile();                                                         // and nothing is created from scratch on bad input
  await assert.rejects(cli(fresh, 'm', 'abc'));
  assert.equal(windows(fresh), undefined);
});

test('CONTEXT_WINDOWS_FILE overrides the data folder path', async () => {
  const file = winFile();
  await cli(file, 'm', '42');
  assert.deepEqual(windows(file), { m: 42 });
});

test('two concurrent calls both land — the lock serialises them, nothing is lost', async () => {
  const file = winFile();
  await Promise.all([cli(file, 'a', '1'), cli(file, 'b', '2')]);
  assert.deepEqual(windows(file), { a: 1, b: 2 });
});
