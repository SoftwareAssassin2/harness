// An agent's context use and spend so far (ASS-190): each stream-json event
// folded into a small usage.json beside its session.txt, { model, at,
// contextTokens, contextWindow, tokens: { input, output, cacheRead, cacheWrite },
// costUsd, costExact, billing }, which the dashboard reads for its tiles, and
// control for what an agent cost when no result says it (ASS-268: finish.js
// costArgs). billing is what the init event says the session is billed to
// (billingOf), null until it has: a path without the live agent (control's
// startup clean-up) knows it from here alone. Only a
// top-level assistant event (parent_tool_use_id null) sets model and
// contextTokens — that message's input + cache-read + cache-creation tokens —
// so a sub-agent's smaller context never shows; cumulative tokens and the cost
// estimate count every assistant event, sub-agents' priced at the top-level
// model's rate (usage.json tracks one model). The estimate comes from
// harness.json's model-prices (USD per million tokens), none for a model not
// in it; a result event replaces it with the exact total_cost_usd. A result
// repeats its turn's usage, so tokens are added on assistant events only. A
// resumed chat starts a new process, so its total_cost_usd and this state
// restart: a chat's figures are its process's, not its whole life's.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'usage.json';
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// billingOf(init) — what a session is billed to (ASS-216), from its init
// event: subscription on a subscription (OAuth) login, whose apiKeySource is
// "none"; api on an API key, whose source it names.
export const billingOf = init => (init.apiKeySource === 'none' ? 'subscription' : 'api');

// initialUsage() — no events yet. exactCost (the last total_cost_usd) and
// sinceResult (tokens since then) are bookkeeping, not written.
export function initialUsage() {
  return { model: null, at: null, contextTokens: null, contextWindow: null, tokens: zero(), costUsd: null, costExact: false, billing: null, exactCost: 0, sinceResult: zero() };
}

const add = (t, u) => ({
  input: t.input + (u.input_tokens ?? 0), output: t.output + (u.output_tokens ?? 0),
  cacheRead: t.cacheRead + (u.cache_read_input_tokens ?? 0), cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens ?? 0),
});

// foldUsage(state, event, { prices, windows }) — the state after `event`, or
// null when it changes nothing worth writing (not an init, assistant or
// result event). `windows` is mergedWindows' { <model>: tokens }.
export function foldUsage(state, event, { prices = {}, windows = {} } = {}) {
  if (event.type === 'system' && event.subtype === 'init') return { ...state, billing: billingOf(event) };
  if (event.type === 'result') {
    const window = event.modelUsage?.[state.model]?.contextWindow;
    return { ...state, costUsd: event.total_cost_usd ?? state.costUsd, costExact: true, exactCost: event.total_cost_usd ?? state.exactCost,
      sinceResult: zero(), contextWindow: window ?? state.contextWindow };
  }
  if (event.type !== 'assistant') return null;
  const usage = event.message?.usage ?? {};
  const model = event.message?.model;
  const next = { ...state, tokens: add(state.tokens, usage), sinceResult: add(state.sinceResult, usage) };
  if (event.parent_tool_use_id == null && model && model !== '<synthetic>') {
    next.model = model;
    next.at = new Date().toISOString();
    next.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  }
  if (next.model) next.contextWindow = windows[next.model] ?? next.contextWindow;
  const price = prices[next.model];
  const s = next.sinceResult;
  next.costUsd = price ? next.exactCost + (s.input * price.input + s.output * price.output + s.cacheRead * price['cache-read'] + s.cacheWrite * price['cache-write']) / 1e6 : null;
  next.costExact = false;
  return next;
}

// toUsageJson(state) — usage.json's shape, bookkeeping dropped.
export function toUsageJson({ model, at, contextTokens, contextWindow, tokens, costUsd, costExact, billing }) {
  return { model, at, contextTokens, contextWindow, tokens, costUsd, costExact, billing };
}

// writeUsage(dir, json) — usage.json in `dir`, through a temp file and a
// rename so a reader never sees half of it. No lock: the agent's own process
// is its only writer, as with session.txt.
export function writeUsage(dir, json) {
  const temp = join(dir, `.${FILE}.tmp`);
  writeFileSync(temp, `${JSON.stringify(json)}\n`);
  renameSync(temp, join(dir, FILE));
}

// readUsage(dir) — `dir`'s usage.json, null without one.
export function readUsage(dir) {
  try { return JSON.parse(readFileSync(join(dir, FILE), 'utf8')); } catch { return null; }
}

// mergedWindows(harness, learned) — each model's context window: harness.json's
// context-windows override, else the learned data/context-windows.json.
export function mergedWindows(harness, learned) {
  return { ...learned, ...(harness?.['context-windows'] ?? {}) };
}
