// ASS-452: each AI step's model is set in its engine. A prompt step's
// action.model names one of harness.json's claude models (or "stronger",
// ASS-399); validate.js rejects anything else, and a model the step's prompt's
// supported-models leaves out. Every prompt step in engines/ names one:
// claude-opus-5-5, but the review steps' claude-sonnet-5 and grouped-plan's
// stronger re-plan's "stronger".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { ROOT } from '../support/engine-walk.js';
import { readEngine } from '../../src/workflow/engine-file.js';

const REVIEW_PROMPTS = new Set(['code-review', 'code-review-grouped', 'security-review', 'security-review-grouped', 'review-plan', 'review-plan-grouped',
  'review-root-cause-analysis', 'review-root-cause-analysis-grouped', 'review-work']);
const engineWith = action => ({ steps: [
  { id: 'a', sequence: 1, action, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
  { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
] });
const prompt = { type: 'prompt', prompt: 'code-review', 'agent-count': 1 };
const claudeOf = file => JSON.parse(readFileSync(file, 'utf8'))['agentic-command-line-interfaces'].find(c => c.name === 'claude').models;

// Every prompt step of an engine, wherever its lists hold them (steps and every *-steps / *-trigger list).
const promptSteps = engine => Object.entries(engine).filter(([key, list]) => /(^|-)(steps|trigger)$/.test(key) && Array.isArray(list))
  .flatMap(([, list]) => list).filter(s => s.action?.type === 'prompt');
const engines = readdirSync(join(ROOT, 'engines')).filter(d => existsSync(join(ROOT, 'engines', d, 'workflow.yaml'))).toSorted()
  .map(name => ({ name, engine: readEngine(join(ROOT, 'engines', name, 'workflow.yaml')) }));

test('ASS-452 AC1: a prompt step\'s model may name any of harness.json\'s claude models, or "stronger"', () => {
  for (const model of [...claudeOf(join(ROOT, 'data', 'harness.json')), 'stronger'])
    assert.deepEqual(validateStateEngine(engineWith({ ...prompt, model }), ROOT), [], model);
});

test('ASS-452 AC1: any other model — another CLI\'s, an unknown one, not a string — is an error naming the step and the allowed models', () => {
  const allowed = claudeOf(join(ROOT, 'data', 'harness.json')).join(', ');
  for (const model of ['gpt-6-astra', 'claude-opus-9', 'opus', '', 5, null]) {
    const errors = validateStateEngine(engineWith({ ...prompt, model }), ROOT);
    assert.deepEqual(errors, [`step "a" model "${model}" is not "stronger" or one of harness.json's claude models (${allowed})`], String(model));
  }
  assert.match(validateStateEngine(engineWith({ type: 'script', command: './agent.sh ticket:show {project} {ticket}', model: 'claude-opus-5-5' }), ROOT).join('\n'), /step "a" model needs a prompt action/);
});

test('ASS-452 AC1: a named model the prompt\'s prompt.json supported-models leaves out is an error; a prompt listing none takes any claude model', () => {
  const root = mkdtempSync(join(tmpdir(), 'step-models-'));
  try {
    const write = (file, json) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), JSON.stringify(json)); };
    write('data/harness.json', { 'agentic-command-line-interfaces': [{ name: 'claude', models: ['claude-opus-5-5', 'claude-sonnet-5'] }, { name: 'codex', models: ['gpt-6-astra'] }] });
    write('prompts/narrow/prompt.json', { 'supported-models': ['claude-opus-5-5'] });
    write('prompts/open/prompt.json', {});
    write('prompts/empty/prompt.json', { 'supported-models': [] });
    const errors = (name, model) => validateStateEngine(engineWith({ type: 'prompt', prompt: name, 'agent-count': 1, model }), root);
    assert.deepEqual(errors('narrow', 'claude-opus-5-5'), []);
    assert.deepEqual(errors('narrow', 'claude-sonnet-5'), ['step "a" model "claude-sonnet-5" is not in prompt "narrow"\'s supported-models (claude-opus-5-5)']);
    assert.deepEqual(errors('narrow', 'stronger'), []);   // resolved by control, as before (ASS-399)
    for (const name of ['open', 'empty']) assert.deepEqual(errors(name, 'claude-sonnet-5'), [], name);
    // The models come from that root's harness.json: one it does not list is unknown there.
    assert.deepEqual(errors('open', 'claude-opus-5'), ['step "a" model "claude-opus-5" is not "stronger" or one of harness.json\'s claude models (claude-opus-5-5, claude-sonnet-5)']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ASS-452 AC3: every prompt step in engines/ names its model — claude-sonnet-5 for a review step, "stronger" for grouped-plan\'s stronger re-plan alone, claude-opus-5-5 for every other', () => {
  const steps = engines.flatMap(({ name, engine }) => promptSteps(engine).map(s => ({ at: `${name}/${s.id}`, prompt: s.action.prompt, model: s.action.model })));
  assert.ok(steps.length >= 100, String(steps.length));
  for (const { at, prompt: p, model } of steps) {
    const want = at === 'grouped-plan/write-execution-plan-stronger' ? 'stronger' : REVIEW_PROMPTS.has(p) ? 'claude-sonnet-5' : 'claude-opus-5-5';
    assert.equal(model, want, `${at} (${p})`);
  }
  const reviews = steps.filter(s => REVIEW_PROMPTS.has(s.prompt));
  assert.ok(reviews.length > 0);
  for (const s of reviews) assert.equal(s.model, 'claude-sonnet-5', s.at);
  assert.deepEqual(steps.filter(s => s.model === 'stronger').map(s => s.at), ['grouped-plan/write-execution-plan-stronger']);
});

test('ASS-452 AC3: every model an engine in engines/ names is one of data/harness.json\'s claude models, and in its prompt\'s supported-models', () => {
  const claude = claudeOf(join(ROOT, 'data', 'harness.json'));
  for (const { name, engine } of engines) for (const s of promptSteps(engine)) {
    if (s.action.model === 'stronger') continue;
    assert.ok(claude.includes(s.action.model), `${name}/${s.id}`);
    const supported = JSON.parse(readFileSync(join(ROOT, 'prompts', s.action.prompt, 'prompt.json'), 'utf8'))['supported-models'] ?? [];
    assert.ok(supported.length === 0 || supported.includes(s.action.model), `${name}/${s.id}`);
  }
});
