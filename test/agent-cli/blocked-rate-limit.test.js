// ASS-391 — grouped-blocked's Await Rate Limit (ticket:await-rate-limit): a
// ticket Classify found blocked by a Claude rate limit resumes at once when
// the API key fallback is available (the project's .claude-api, no API cap
// holding it, the API key not limited too), else waits — its Health saying
// so, written only when it changes — until the recorded reset, then resumes;
// one with no limit recorded resumes at once, counted by ticket:fix-attempts.
// ASS-395 AC5 — the credentials route's ticket:credentials-unseen: the
// project not held, the operator gets Classify's reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';

const RUN = '77777777-7777-4777-8777-777777777777';
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const outcome = promise => promise.then(r => ({ code: 0, out: JSON.parse(r.stdout || 'null'), stderr: r.stderr }), e => ({ code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr }));
const iso = ms => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const HOUR = 3_600_000;
const utc = at => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

// ABC-3 A of project p, at Blocked; its work folder made; the Blocked run RUN holding `output`.
function setup(output = {}) {
  const f = fixture();
  const at = (...rest) => join(f.dir, ...rest);
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => {
    sprint.features[0].variations[0]['harness-status'] = { state: 'blocked', 'state-engine': 'example-development' };
  });
  edit(at('assignments.json'), a => {
    a['transient-state-engines'].push({ id: RUN, project: 'p', 'state-engine': 'grouped-blocked', state: 'x', parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'blocked' }, 'is-done': false, 'structured-output': output });
  });
  mkdirSync(at('projects', 'p', 'work', 'ABC-3'), { recursive: true });
  const agent = (...args) => outcome(run(AGENT, args, { env: f.env }));
  const limits = json => (json ? writeFileSync(at('projects', 'p', 'rate-limit.json'), JSON.stringify(json)) : rmSync(at('projects', 'p', 'rate-limit.json'), { force: true }));
  const apiKey = () => mkdirSync(at('projects', 'p', '.claude-api'), { recursive: true });
  const project = change => edit(at('projects', 'p', 'project.json'), change);
  const variation = () => JSON.parse(readFileSync(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8')).features[0].variations[0];
  const setVariation = fields => edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => Object.assign(sprint.features[0].variations[0], fields));
  const log = () => (existsSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md')) ? readFileSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md'), 'utf8') : '');
  const wait = () => agent('ticket:await-rate-limit', 'p', 'ABC-3', 'A');
  return { ...f, at, agent, limits, apiKey, project, variation, setVariation, log, wait };
}

test('ASS-391 AC2/AC4: the subscription rate limited and the API key fallback available — the run ends at once (api-fallback), the ticket resumes, logged', async () => {
  const s = setup(), resets = iso(2 * HOUR);
  s.apiKey();
  s.limits({ claude: { since: iso(-HOUR), type: 'five_hour', 'resets-at': resets } });
  const r = await s.wait();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out, { 'rate-limit': { kind: 'claude', type: 'five_hour', 'resets-at': resets }, 'api-fallback': true, 'ai-feedback-short': null, 'ai-feedback-long': null });
  assert.equal(s.variation()['rate-limit-wait'], undefined, 'nothing kept: no wait');
  assert.match(s.log(), /Blocked, Await Rate Limit\nRate limited on the subscription \(claude\) until \S+; the API key fallback is available .*: ABC-3 resumes at once, its next agents paid by the API key\./);
});

test('ASS-391 AC2/AC3/AC4: no API key fallback — it waits (exit 2, its waiting exit) with the Health "Waiting for the rate limit to reset at <time> (no API fallback)", written once, then resumes after the reset', async () => {
  const s = setup(), resets = iso(2 * HOUR);
  s.limits({ claude: { since: iso(-HOUR), type: 'five_hour', 'resets-at': resets } });
  const first = await s.wait();
  assert.equal(first.code, 2, first.stderr);
  assert.deepEqual(first.out, { 'rate-limit': { kind: 'claude', type: 'five_hour', 'resets-at': resets }, 'api-fallback': false, why: 'the project has no API key fallback (no .claude-api folder)' });
  assert.equal(s.variation()['ai-feedback-short'], `Waiting for the rate limit to reset at ${utc(resets)} (no API fallback)`);
  assert.match(s.variation()['ai-feedback-long'], /^ABC-3 was blocked by a Claude rate limit \(five_hour\) on the subscription, which resets at .*\. No API fallback: the project has no API key fallback \(no \.claude-api folder\)\. It waits at Blocked and resumes where it was blocked once the limit resets; nothing for you to do\.$/);
  assert.deepEqual(s.variation()['rate-limit-wait'], { kind: 'claude', type: 'five_hour', 'resets-at': resets, feedback: s.variation()['ai-feedback-long'] });
  assert.match(first.stderr, /ticket:await-rate-limit: ABC-3 A: ABC-3 was blocked by a Claude rate limit/);
  const again = await s.wait();
  assert.equal(again.code, 2);
  assert.equal(again.stderr, '', 'the same wait: the Health not written again, nothing said');
  assert.equal(s.log().match(/Blocked, Await Rate Limit/g).length, 1, 'logged once');
  // The reset passes: control clears the kind (project:clear-rate-limit) — or its time is simply past.
  s.limits({ claude: { since: iso(-3 * HOUR), type: 'five_hour', 'resets-at': iso(-60_000) } });
  const reset = await s.wait();
  assert.equal(reset.code, 0, reset.stderr);
  assert.deepEqual(reset.out, { 'rate-limit-reset': true, 'rate-limit': { kind: 'claude', type: 'five_hour', 'resets-at': resets }, 'ai-feedback-short': null, 'ai-feedback-long': null });
  assert.equal(s.variation()['rate-limit-wait'], undefined);
  assert.equal(s.variation()['ai-feedback-short'], null, 'the waiting Health cleared');
  assert.match(s.log(), /The claude rate limit has reset \(\S+\): ABC-3 resumes where it was blocked\./);
});

test('ASS-391 AC2/AC4: an API cap holding the fallback — it waits, saying which cap; the API key limited too, or the limited runs already on the API, it waits as well', async () => {
  const s = setup(), resets = iso(HOUR);
  s.apiKey();
  s.limits({ claude: { since: iso(-HOUR), type: 'seven_day', 'resets-at': resets } });
  s.project(p => { p['api-cap-hold'] = { since: iso(-HOUR), cap: 'day', 'spend-usd': 51.2, 'limit-usd': 50 }; });
  const capped = await s.wait();
  assert.equal(capped.code, 2, capped.stderr);
  assert.equal(capped.out.why, 'the API day cap holds it ($51.2 spent of $50)');
  assert.equal(s.variation()['ai-feedback-short'], `Waiting for the rate limit to reset at ${utc(resets)} (no API fallback)`);
  s.project(p => { delete p['api-cap-hold']; });
  const apiReset = iso(30 * 60_000);
  s.limits({ claude: { since: iso(-HOUR), type: 'seven_day', 'resets-at': resets }, anthropic: { since: iso(-HOUR), type: 'unknown', 'resets-at': apiReset } });
  const both = await s.wait();
  assert.equal(both.code, 2);
  assert.equal(both.out.why, `the API key is rate limited too, until ${utc(apiReset)}`);
  assert.notEqual(both.stderr, '', 'the reason changed: the Health written again');
  const onApi = setup();
  onApi.limits({ anthropic: { since: iso(-HOUR), type: 'five_hour', 'resets-at': resets } });
  const api = await onApi.wait();
  assert.equal(api.code, 2);
  assert.deepEqual([api.out['rate-limit'].kind, api.out.why], ['anthropic', 'the limited runs were on the API key already']);
  assert.match(onApi.variation()['ai-feedback-long'], /on the API key, which resets at/);
});

test('ASS-391: no rate limit recorded as holding — the run ends at once (rate-limit-held false), and ticket:fix-attempts counts such resumes toward its 3', async () => {
  const s = setup();
  const none = await s.wait();
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual(none.out, { 'rate-limit-held': false, 'ai-feedback-short': null, 'ai-feedback-long': null });
  assert.match(s.log(), /Classify said the block was a Claude rate limit, but none is recorded as holding p's agents now/);
  const top = (from, to) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to });
  const unheld = { 'rate-limit-held': false, 'ended-at': 'done' }, fallback = { 'api-fallback': true, 'ended-at': 'done' };
  const attempts = () => s.agent('ticket:fix-attempts', 'p', 'ABC-3', 'A');
  s.setVariation({ 'state-changes': [top('build', 'blocked')], blocks: [unheld, unheld] });
  assert.deepEqual((await attempts()).out, { 'fix-attempts': 2, 'rate-limit-unheld': 2 });
  s.setVariation({ blocks: [unheld, unheld, fallback] });
  assert.deepEqual((await attempts()).out, { 'fix-attempts': 0 }, 'a fallback resume is no failed attempt, and ends the count');
  s.setVariation({ blocks: [unheld, unheld, unheld] });
  const three = await attempts();
  assert.equal(three.code, 3);
  assert.match(three.out['ai-feedback-long'], /^It was classified as rate limited 3 times with no rate limit recorded, and resumed \(ASS-391\), and the block came back\./);
});

test('ASS-395 AC5: ticket:credentials-unseen — the project not held, Blocked for Human gets Classify\'s reason and what to do, logged', async () => {
  const s = setup({ issue: 'credentials', reasoning: 'The deploy token in the keychain item "Example Token" was rejected (401).', 'human-action': 'save a fresh token in the keychain item "Example Token"' });
  const r = await s.agent('ticket:credentials-unseen', 'p', 'ABC-3', 'A', RUN);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out['credentials-held'], false);
  assert.equal(r.out['ai-feedback-short'], 'A credential blocks it that the credentials check cannot see');
  assert.equal(r.out['ai-feedback-long'], 'Blocked classified ABC-3\'s block as a missing or failing credential: The deploy token in the keychain item "Example Token" was rejected (401). A fresh credentials check (project:check-credentials) finds nothing missing, so it holds no work until this one is fixed. What to do: save a fresh token in the keychain item "Example Token". Fix the credential, then resolve, or have AI try again.');
  assert.match(s.log(), /Blocked, Check the Credentials\nBlocked classified ABC-3's block as a missing or failing credential.*Handed to the operator\./);
  assert.equal((await s.agent('ticket:credentials-unseen', 'p', 'ABC-3', 'A', 'no-such-run')).code, 1);
});
