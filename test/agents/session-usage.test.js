// ASS-190: the pure fold of stream-json events into usage.json's model,
// context tokens, cumulative tokens and cost — and its atomic read/write beside
// session.txt. No spawn here; every event and price table is inline. The
// numbers mirror test/support/fake-agent.js: a top-level assistant usage of
// 10/20/30/40 (input/output/cache-read/cache-creation), a result that repeats
// that same usage, and a result total_cost_usd of 0.5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as su from '../../src/agents/session-usage.js';

// Event builders. usage() names the stream-json fields; top() a top-level
// assistant event (parent_tool_use_id null), sub() a sub-agent one, result()
// the turn-end event (repeating the turn's usage, per fake-agent).
const usage = (i, o, r, w) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w });
const top = (model = 'm', u = usage(10, 20, 30, 40)) => ({ type: 'assistant', parent_tool_use_id: null, message: { model, usage: u } });
const sub = (model = 'm', u = usage(1, 2, 3, 4)) => ({ type: 'assistant', parent_tool_use_id: 'sub1', message: { model, usage: u } });
const result = (extra = {}) => ({ type: 'result', total_cost_usd: 0.5, usage: usage(10, 20, 30, 40), ...extra });
// Anthropic-style USD per million tokens (Sonnet tier): with 10/20/30/40 the
// estimate is (10*3 + 20*15 + 30*0.3 + 40*3.75)/1e6 = 489/1e6 = 0.000489.
const prices = { m: { input: 3, output: 15, 'cache-read': 0.3, 'cache-write': 3.75 } };
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('ASS-190 AC1: initialUsage is the documented shape — all tokens zero, costExact false, the rest null', () => {
  const s = su.initialUsage();
  assert.equal(s.model, null);
  assert.equal(s.at, null);
  assert.equal(s.contextTokens, null);
  assert.equal(s.contextWindow, null);
  assert.deepEqual(s.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(s.costUsd, null);
  assert.equal(s.costExact, false);
  assert.equal(s.billing, null);
});

test('ASS-190 AC1: foldUsage returns null for anything but init/assistant/result events, so the caller writes nothing', () => {
  const opts = { prices: {}, windows: {} };
  assert.equal(su.foldUsage(su.initialUsage(), { type: 'system', subtype: 'status' }, opts), null);
  assert.equal(su.foldUsage(su.initialUsage(), { type: 'user', message: {} }, opts), null);
  assert.equal(su.foldUsage(su.initialUsage(), { type: 'rate_limit_event' }, opts), null);
});

test('ASS-190 AC1: a top-level assistant event sets model/at/contextTokens (input+cache-read+cache-creation) and adds its usage to cumulative tokens', () => {
  const s = su.foldUsage(su.initialUsage(), top('m'), { prices: {}, windows: {} });
  const j = su.toUsageJson(s);
  assert.equal(j.model, 'm');
  assert.equal(typeof j.at, 'string');
  assert.equal(j.contextTokens, 80);                                           // 10 + 30 + 40
  assert.deepEqual(j.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
});

test('ASS-190 AC1: a sub-agent event adds to cumulative tokens but leaves model/contextTokens/at untouched', () => {
  let s = su.foldUsage(su.initialUsage(), top('m'), { prices: {}, windows: {} });
  const before = su.toUsageJson(s);
  s = su.foldUsage(s, sub('m', usage(1, 2, 3, 4)), { prices: {}, windows: {} });
  const j = su.toUsageJson(s);
  assert.deepEqual(j.tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  assert.equal(j.contextTokens, 80);
  assert.equal(j.model, 'm');
  assert.equal(j.at, before.at);
});

test('ASS-190 AC1: a sub-agent before any top-level grows cumulative tokens but leaves model/contextTokens null', () => {
  let s = su.foldUsage(su.initialUsage(), sub('m', usage(1, 2, 3, 4)), { prices: {}, windows: {} });
  let j = su.toUsageJson(s);
  assert.deepEqual(j.tokens, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.equal(j.model, null);
  assert.equal(j.contextTokens, null);
  s = su.foldUsage(s, top('m'), { prices: {}, windows: {} });
  j = su.toUsageJson(s);
  assert.deepEqual(j.tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  assert.equal(j.contextTokens, 80);
});

test('ASS-190 AC1: a <synthetic>/all-zero assistant event (an error turn) does not overwrite model or contextTokens', () => {
  let s = su.foldUsage(su.initialUsage(), top('m'), { prices: {}, windows: {} });
  s = su.foldUsage(s, { type: 'assistant', parent_tool_use_id: null, message: { model: '<synthetic>', usage: usage(0, 0, 0, 0) } }, { prices: {}, windows: {} });
  const j = su.toUsageJson(s);
  assert.equal(j.model, 'm');
  assert.equal(j.contextTokens, 80);
  assert.deepEqual(j.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
});

test('ASS-190 AC1: an assistant event with no usage and no model is a no-op — tokens, model and contextTokens unchanged, nothing thrown, no NaN', () => {
  let s = su.foldUsage(su.initialUsage(), top('m'), { prices: {}, windows: {} });
  const before = su.toUsageJson(s);
  s = su.foldUsage(s, { type: 'assistant', message: { content: [{ type: 'text', text: 'args --model m' }] } }, { prices: {}, windows: {} });
  const after = su.toUsageJson(s);
  assert.deepEqual(after.tokens, before.tokens);
  assert.equal(after.model, 'm');
  assert.equal(after.contextTokens, 80);
  assert.ok(!Number.isNaN(after.tokens.input));
});

test('ASS-190 AC1: a priced model gets an estimate (Σ usage × price / 1e6), costExact false', () => {
  const s = su.foldUsage(su.initialUsage(), top('m'), { prices, windows: {} });
  const j = su.toUsageJson(s);
  assert.ok(close(j.costUsd, 0.000489), String(j.costUsd));
  assert.equal(j.costExact, false);
});

test('ASS-190 AC1: a model missing from the price table leaves costUsd null (costExact false) across many events, then exact at the result', () => {
  let s = su.foldUsage(su.initialUsage(), top('m'), { prices: {}, windows: {} });
  assert.equal(su.toUsageJson(s).costUsd, null);
  assert.equal(su.toUsageJson(s).costExact, false);
  s = su.foldUsage(s, sub('m'), { prices: {}, windows: {} });
  assert.equal(su.toUsageJson(s).costUsd, null);
  s = su.foldUsage(s, result(), { prices: {}, windows: {} });
  assert.equal(su.toUsageJson(s).costUsd, 0.5);
  assert.equal(su.toUsageJson(s).costExact, true);
});

test('ASS-190 AC1: a priced model with sub-agent events prices every event at the top-level model rate', () => {
  let s = su.foldUsage(su.initialUsage(), sub('m', usage(1, 2, 3, 4)), { prices, windows: {} });
  s = su.foldUsage(s, top('m'), { prices, windows: {} });
  const j = su.toUsageJson(s);
  assert.deepEqual(j.tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  assert.ok(close(j.costUsd, (11 * 3 + 22 * 15 + 33 * 0.3 + 44 * 3.75) / 1e6), String(j.costUsd));
});

test('ASS-190 AC1: the result event replaces the estimate with the exact cost, flips costExact, and a next-turn estimate starts from the exact cost', () => {
  let s = su.foldUsage(su.initialUsage(), top('m'), { prices, windows: {} });
  s = su.foldUsage(s, result(), { prices, windows: {} });
  assert.equal(su.toUsageJson(s).costUsd, 0.5);
  assert.equal(su.toUsageJson(s).costExact, true);
  s = su.foldUsage(s, top('m'), { prices, windows: {} });
  const j = su.toUsageJson(s);
  assert.equal(j.costExact, false);
  assert.ok(close(j.costUsd, 0.5 + 0.000489), String(j.costUsd));   // exact base + this turn's estimate, not from zero
});

test('ASS-268 AC1: the init event records the session\'s billing — subscription on apiKeySource none, else api — kept through the turns and written', () => {
  const opts = { prices, windows: {} };
  let s = su.foldUsage(su.initialUsage(), { type: 'system', subtype: 'init', apiKeySource: 'none' }, opts);
  assert.equal(su.toUsageJson(s).billing, 'subscription');
  assert.equal(su.toUsageJson(s).costUsd, null);                               // nothing spent yet
  s = su.foldUsage(s, top('m'), opts);
  s = su.foldUsage(s, result(), opts);
  assert.equal(su.toUsageJson(s).billing, 'subscription');
  assert.equal(su.toUsageJson(su.foldUsage(su.initialUsage(), { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }, opts)).billing, 'api');
  assert.equal(su.toUsageJson(su.foldUsage(su.initialUsage(), { type: 'system', subtype: 'init' }, opts)).billing, 'api');   // no source named: as process.js billingOf
});

test('ASS-190 AC1 (must-fix 3): the result\'s repeated usage is not added to cumulative tokens', () => {
  const opts = { prices: {}, windows: {} };
  let s = su.foldUsage(su.initialUsage(), top('m'), opts);
  assert.deepEqual(su.toUsageJson(s).tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  s = su.foldUsage(s, result(), opts);
  assert.deepEqual(su.toUsageJson(s).tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  s = su.foldUsage(s, top('m'), opts);
  s = su.foldUsage(s, result(), opts);
  assert.deepEqual(su.toUsageJson(s).tokens, { input: 20, output: 40, cacheRead: 60, cacheWrite: 80 });
});

test('ASS-190 AC2: the result\'s modelUsage[model].contextWindow is adopted; absent, the prior value is kept', () => {
  let s = su.foldUsage(su.initialUsage(), top('m'), { prices: {}, windows: { m: 100 } });
  assert.equal(su.toUsageJson(s).contextWindow, 100);
  s = su.foldUsage(s, result(), { prices: {}, windows: { m: 100 } });                     // no modelUsage → keeps 100
  assert.equal(su.toUsageJson(s).contextWindow, 100);
  s = su.foldUsage(s, result({ modelUsage: { m: { contextWindow: 999 } } }), { prices: {}, windows: { m: 100 } });
  assert.equal(su.toUsageJson(s).contextWindow, 999);
});

test('ASS-190 AC2: a learned window (windows[model]) populates contextWindow on the first assistant event, before any result', () => {
  const s = su.foldUsage(su.initialUsage(), top('m'), { prices: {}, windows: { m: 123456 } });
  assert.equal(su.toUsageJson(s).contextWindow, 123456);
});

test('ASS-190 AC1: toUsageJson is exactly the on-disk shape — no bookkeeping (exactCost/sinceResult) leaks', () => {
  const s = su.foldUsage(su.initialUsage(), top('m'), { prices, windows: {} });
  const j = su.toUsageJson(s);
  assert.deepEqual(j, { model: 'm', at: j.at, contextTokens: 80, contextWindow: null, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, costUsd: j.costUsd, costExact: false, billing: null });
  assert.ok(!('exactCost' in j) && !('sinceResult' in j));
});

test('ASS-190 AC1: writeUsage writes atomically and readUsage round-trips; absent → null; a rewrite leaves only usage.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'su-'));
  assert.equal(su.readUsage(dir), null);
  const j1 = { model: 'm', at: 't', contextTokens: 80, contextWindow: null, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: null, costExact: false };
  su.writeUsage(dir, j1);
  assert.deepEqual(su.readUsage(dir), j1);
  su.writeUsage(dir, { ...j1, costExact: true });
  assert.deepEqual(su.readUsage(dir), { ...j1, costExact: true });
  assert.deepEqual(readdirSync(dir), ['usage.json']);                                      // no temp file left behind
});

test('ASS-190 AC2: mergedWindows lets harness context-windows win per model; keys on one side pass through; both empty → {}', () => {
  assert.deepEqual(su.mergedWindows({ 'context-windows': { m: 100 } }, { m: 50, n: 200 }), { m: 100, n: 200 });
  assert.deepEqual(su.mergedWindows({}, { n: 5 }), { n: 5 });
  assert.deepEqual(su.mergedWindows({ 'context-windows': { x: 9 } }, {}), { x: 9 });
  assert.deepEqual(su.mergedWindows({}, {}), {});
});
