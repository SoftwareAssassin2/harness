// Walking a ticket through the real engines with control's own reading of an
// engine (src/control/engine.js nextState), each step's facts faked — as the
// walk() helpers in test/workflow/grouped-development.test.js and
// v2-development.test.js do, shared here for tests that check what an engine
// does rather than how it is written: they assert where a ticket ends up and
// which steps it passes on the way, so rewording a step or adding one leaves
// them passing. And comparing an engine with its copy by what their shared
// steps do (working, sameShared), not by how they are worded.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';

export const ROOT = join(import.meta.dirname, '..', '..');
// The example project's own engines (ASS-277): a GitLab project's flat
// example-development, its grouped example-development-grouped and
// example-backlog-refinement, and grouped-release-example, its Release — kept
// as a project keeps its own in data/projects/<project>/engines (ASS-276),
// and read before engines/ for that project's work, as control reads them.
export const EXAMPLE_ENGINES = join(import.meta.dirname, '..', 'fixtures', 'engines');

const readEngines = dir => (!existsSync(dir) ? {} : Object.fromEntries(readdirSync(dir).filter(d => existsSync(join(dir, d, 'state-engine.json')))
  .map(d => [d, JSON.parse(readFileSync(join(dir, d, 'state-engine.json'), 'utf8'))])));

// loadEngines(root, own) — every engines/<name>/state-engine.json under root and
// every <own>/<name>/state-engine.json, own's over root's, { [name]: its JSON };
// own, for the harness's own root, the example project's (EXAMPLE_ENGINES).
export function loadEngines(root = ROOT, own = root === ROOT ? EXAMPLE_ENGINES : undefined) {
  return { ...readEngines(join(root, 'engines')), ...(own ? readEngines(own) : {}) };
}

// engineDir(name) — engine `name`'s folder: the example project's own, else engines/'s.
export const engineDir = name => (existsSync(join(EXAMPLE_ENGINES, name)) ? join(EXAMPLE_ENGINES, name) : join(ROOT, 'engines', name));
// withExampleEngines(projectDir) — the example project's own engines copied into
// <projectDir>/engines, where the agent-cli and control find a project's own
// (ASS-276), for a test whose project runs example-development; projectDir back.
export const withExampleEngines = projectDir => { cpSync(EXAMPLE_ENGINES, join(projectDir, 'engines'), { recursive: true }); return projectDir; };
// engineNames() — every engine's name, engines/'s and the example project's own.
export const engineNames = () => [...new Set([...readdirSync(join(ROOT, 'engines')), ...readdirSync(EXAMPLE_ENGINES)])].toSorted();

// The passing facts: every turn done, check and script passing, review
// approving, the human approving, one variation with a criterion, no question open.
export const PASSING = {
  turnComplete: true, exitCode: 0, agentNeedsWork: true, fileUpdated: () => true, scriptSucceeds: () => true, questions: () => [],
  variationCount: 1, variation: { 'acceptance-criteria': [{ 'criteria-number': 1, description: 'it works' }] },
  scriptOutput: { status: 'passed', 'needs-attention': false, 'auto-merge': true, merged: true },
  structuredOutput: { 'is-approved': true, 'flagged-for-human-review': false, 'will-spend-tokens': false },
};

// walk(engines, name, { from, given, answers, stop }) — a ticket walked
// through engine `name` from step `from` (its first step when not given).
// Each step's facts are PASSING, then `given`, then answers["<engine>/<step>"]
// — an object, or a list by visit (its last repeated); a human step's choice
// is { humanReview: <decision> } there (Approved when none is given). A
// state-engine step runs its sub-engine first — from the step the exit into
// it named (start-sub-engine-at), else its first — and its exits read the
// done step it ended at and what it returned, merged as control merges it.
// It stops at a done step of `name`, at a step of `stop`, or where no exit
// matches (the ticket rests there: a human step waiting, a timer not yet).
// Returns { trail, end, rests, output }: trail the "<engine>/<step>" visited,
// sub-engines' nested in their step's visit.
export function walk(engines, name, { from, given = {}, answers = {}, stop = [] } = {}) {
  const trail = [], visits = new Map();
  const factsAt = (engine, at) => {
    const key = `${engine}/${at}`, n = visits.get(key) ?? 0;
    visits.set(key, n + 1);
    const answer = Array.isArray(answers[key]) ? answers[key][Math.min(n, answers[key].length - 1)] : answers[key] ?? {};
    const facts = { ...PASSING, ...given, ...answer };
    return { ...facts, humanReview: { state: at, decision: answer.humanReview ?? given.humanReview ?? 'Approved' } };
  };
  const run = (engine, start, top) => {
    const e = engines[engine], changes = [];
    let output = {};
    for (let at = start, startAt, i = 0; i < 300; i++) {
      trail.push(`${engine}/${at}`);
      const step = stepOf(e, at);
      if (!step) throw new Error(`${engine} has no step "${at}"`);
      if (step['is-done'] || (top && stop.includes(at))) return { end: at, rests: false, output };
      let facts = factsAt(engine, at);
      if (step.action?.type === 'state-engine') {
        const child = run(step.action.engine, startAt ?? firstStepId(engines[step.action.engine]), false);
        if (child.rests) return { ...child, output };
        facts = { ...facts, subEngineDone: true, subEngineState: child.end, structuredOutput: { ...output, ...child.output } };
      }
      if (['prompt', 'state-engine'].includes(step.action?.type)) output = { ...output, ...facts.structuredOutput };
      const next = nextState(step, e, facts, changes);
      if (!next) return { end: at, rests: true, output };
      if (next.to == null) throw new Error(`${engine}/${at}: its exit's target cannot be told`);
      changes.push({ 'from-state': at, 'to-state': next.to });
      startAt = next.reason === 'exit' ? next.exit['start-sub-engine-at'] : undefined;
      at = next.to;
    }
    throw new Error(`${engine} ran away: ${trail.slice(-10).join(' ')}`);
  };
  const result = run(name, from ?? firstStepId(engines[name]), true);
  return { trail, ...result };
}

// working(step) — the step as it works, for comparing one engine's step with
// its copy's: without its wording (name, description, a human step's
// instructions) or its place in the list (sequence), which change freely.
export function working(step) {
  const { name: _, description: __, sequence: ___, ...rest } = step;
  if (rest.action?.instructions === undefined) return rest;
  const { instructions: ____, ...action } = rest.action;
  return { ...rest, action };
}

// listsOf(engine) — the keys of every list of steps it holds: `steps` and each top-level `*-steps` / `*-trigger`.
export const listsOf = engine => Object.keys(engine).filter(key => Array.isArray(engine[key]) && (key === 'steps' || /-(steps|trigger)$/.test(key)));

// sameShared(copy, reference, { as, asReference, message }) — asserts that
// every step `copy` shares with `reference` (by id, list by list) works as the
// reference's does (working: wording and order aside) — `as(step)` the copy's
// step and `asReference(step)` the reference's, each read as they should match
// — and that the engines' settings (their other keys) are the same. A step
// only one of them has is that engine's own: adding one breaks nothing.
export function sameShared(copy, reference, { as = s => s, asReference = s => s, message = '' } = {}) {
  for (const key of listsOf(copy)) for (const step of copy[key]) {
    const theirs = (reference[key] ?? []).find(s => s.id === step.id);
    if (theirs) assert.deepEqual(working(as(step)), working(asReference(theirs)), `${message} ${key}/${step.id}`);
  }
  const lists = new Set([...listsOf(copy), ...listsOf(reference)]);
  for (const key of new Set([...Object.keys(copy), ...Object.keys(reference)])) if (!lists.has(key)) assert.deepEqual(copy[key], reference[key], `${message} ${key}`);
}

// inOrder(trail, steps) — whether `steps` appear in `trail` in that order, others between them allowed.
export function inOrder(trail, steps) {
  let i = 0;
  for (const p of trail) if (p === steps[i]) i++;
  return i === steps.length;
}
